import axios from "axios";
import mongodb from "mongodb";
import decodeOpaqueId from "@reactioncommerce/api-utils/decodeOpaqueId.js";
import { PAYMENT_STATUS } from "../util/paymentStatus.js";
import { evaluateStatusResponse, validateStatusUrl } from "./easypaisaProtocol.js";
import { getOrderInvoiceTotal } from "./paymentMath.js";

const { ObjectId } = mongodb;

function decodeOrderReference(value, decoder = decodeOpaqueId) {
  if (!value) return null;
  try {
    return decoder(value)?.id || value;
  } catch (error) {
    return value;
  }
}

function transactionQuery(orderId, paymentAttemptId) {
  const query = { orderId };
  if (paymentAttemptId && ObjectId.isValid(paymentAttemptId)) {
    query._id = new ObjectId(paymentAttemptId);
  }
  return query;
}

export async function processEasyPaisaStatus(
  {
    statusUrl,
    allowedHosts,
    OrdersDb,
    TransactionDb,
  },
  dependencies = {}
) {
  if (!OrdersDb || !TransactionDb) {
    throw new TypeError("OrdersDb and TransactionDb are required");
  }

  const httpClient = dependencies.httpClient || axios;
  const clock = dependencies.clock || { now: () => new Date() };
  const publishStatus = dependencies.publishStatus || (() => {});
  const decoder = dependencies.decodeOrderId || decodeOpaqueId;
  const timeoutMs = Number(dependencies.timeoutMs || 15000);
  const parsedUrl = validateStatusUrl(statusUrl, allowedHosts);

  const response = await httpClient.get(parsedUrl.toString(), {
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
    maxRedirects: 0,
  });
  const providerData = response?.data || {};
  const externalOrderId = providerData.optional1;
  const paymentAttemptId = providerData.optional2;
  const orderId = decodeOrderReference(externalOrderId, decoder);

  if (!orderId || !paymentAttemptId) {
    const error = new Error("Payment status is missing order references");
    error.code = "INVALID_PROVIDER_REFERENCE";
    throw error;
  }

  const order = await OrdersDb.findOne({ _id: orderId });
  if (!order) {
    const error = new Error("Order not found");
    error.code = "ORDER_NOT_FOUND";
    throw error;
  }

  const attemptQuery = transactionQuery(orderId, paymentAttemptId);
  const attempt = await TransactionDb.findOne(attemptQuery);
  if (!attempt) {
    const error = new Error("Payment attempt not found");
    error.code = "PAYMENT_ATTEMPT_NOT_FOUND";
    throw error;
  }

  if (
    order.isPaid === true &&
    attempt.status === PAYMENT_STATUS.VERIFIED_PAID
  ) {
    return {
      orderId,
      externalOrderId,
      paymentAttemptId,
      status: PAYMENT_STATUS.VERIFIED_PAID,
      isPaid: true,
      idempotent: true,
    };
  }

  const expectedAmount = attempt.amount || getOrderInvoiceTotal(order);
  const outcome = evaluateStatusResponse(providerData, expectedAmount);
  const now = clock.now();

  await TransactionDb.updateOne(
    attemptQuery,
    {
      $set: {
        providerStatus: outcome.providerStatus,
        status: outcome.status,
        responseCode: outcome.responseCode,
        responseMessage: outcome.description,
        transactionId: outcome.providerTransactionId,
        verifiedAmount: outcome.paidAmount,
        amountMatches: outcome.amountMatches,
        transactionDateTime: outcome.paidAt,
        lastVerifiedAt: now,
        nextReconciliationAt:
          outcome.status === PAYMENT_STATUS.PENDING_VERIFICATION
            ? attempt.nextReconciliationAt || now
            : null,
        updatedAt: now,
      },
    }
  );

  const orderUpdate = {
    paymentStatus: outcome.status,
    verifiedPaymentAmount: outcome.paidAmount,
    updatedAt: now,
  };
  if (outcome.providerTransactionId) {
    orderUpdate.transactionId = outcome.providerTransactionId;
  }
  if (outcome.isPaid) {
    orderUpdate.isPaid = true;
    orderUpdate.paymentVerifiedAt = now;
  }

  await OrdersDb.updateOne(
    outcome.isPaid
      ? { _id: orderId }
      : { _id: orderId, isPaid: { $ne: true } },
    { $set: orderUpdate }
  );

  publishStatus({
    branchId: order.branchID,
    externalOrderId,
    orderId,
    status: outcome.status,
    isPaid: outcome.isPaid,
    initiatedAt: order.paymentInitiatedAt,
  });

  return {
    orderId,
    externalOrderId,
    paymentAttemptId,
    ...outcome,
    idempotent: false,
  };
}

export { decodeOrderReference };
