import { amountsMatch, positiveMoney } from "./paymentMath.js";
import { PAYMENT_STATUS } from "../util/paymentStatus.js";

const TERMINAL_FAILURES = new Set(["FAILED", "CANCELLED", "EXPIRED"]);

export function validateAuthHeaderName(value) {
  const name = String(value || "Credentials").trim();
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    throw new TypeError("Invalid payment authentication header name");
  }
  return name;
}

export function sanitizeInitiationResponse(data = {}) {
  return {
    responseCode: data.responseCode || null,
    responseMessage: data.responseDesc || null,
    transactionId: data.transactionId || null,
    transactionDateTime: data.transactionDateTime || null,
  };
}

export function evaluateInitiationResponse(httpStatus, data = {}) {
  const response = sanitizeInitiationResponse(data);
  const accepted =
    httpStatus >= 200 &&
    httpStatus < 300 &&
    response.responseCode === "0000" &&
    String(response.responseMessage || "").trim().toUpperCase() === "SUCCESS" &&
    Boolean(response.transactionId);

  return {
    ...response,
    accepted,
    status: accepted ? PAYMENT_STATUS.PENDING_VERIFICATION : PAYMENT_STATUS.FAILED,
    isPaid: false,
  };
}

export function sanitizeStatusResponse(data = {}) {
  return {
    providerOrderId: data.order_id || null,
    providerTransactionId: data.transaction_id || null,
    providerStatus: data.transaction_status || null,
    responseCode: data.response_code || null,
    paidAmount: positiveMoney(data.transaction_amount),
    paidAt: data.paid_datetime || null,
    description: data.description || null,
    externalOrderId: data.optional1 || null,
    paymentAttemptId: data.optional2 || null,
  };
}

export function evaluateStatusResponse(data, expectedAmount) {
  const response = sanitizeStatusResponse(data);
  const normalizedStatus = String(response.providerStatus || "").trim().toUpperCase();
  const amountMatches = amountsMatch(expectedAmount, response.paidAmount);
  const providerPaid =
    normalizedStatus === "PAID" &&
    response.responseCode === "0000" &&
    Boolean(response.providerTransactionId);

  let status = PAYMENT_STATUS.PENDING_VERIFICATION;
  if (providerPaid && amountMatches) status = PAYMENT_STATUS.VERIFIED_PAID;
  else if (providerPaid) status = PAYMENT_STATUS.AMOUNT_MISMATCH;
  else if (TERMINAL_FAILURES.has(normalizedStatus)) status = normalizedStatus;

  return {
    ...response,
    amountMatches,
    status,
    isPaid: status === PAYMENT_STATUS.VERIFIED_PAID,
  };
}

export function isUncertainProviderError(error) {
  const errorName = error && error.constructor ? error.constructor.name : "";
  if (errorName === "ReactionError") return false;
  const code = error ? error.code : null;
  return Boolean(
    !(error && error.response) ||
      ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)
  );
}

export function validateStatusUrl(value, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError("Invalid payment status URL");
  }
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !hosts.includes(parsed.hostname)
  ) {
    throw new TypeError("Payment status URL is not allowed");
  }
  return parsed;
}
