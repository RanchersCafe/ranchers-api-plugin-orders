import axios from "axios";
import { randomBytes } from "crypto";
import mongodb from "mongodb";
import ReactionError from "@reactioncommerce/reaction-error";
import decodeOrderReference from "../payments/decodeOrderReference.js";
import publishPaymentStatus from "../payments/publishPaymentStatus.js";
import {
  buildIdempotencyKey,
  getOrderInvoiceTotal,
  positiveMoney,
} from "../payments/paymentMath.js";
import {
  evaluateInitiationResponse,
  isUncertainProviderError,
  validateAuthHeaderName,
} from "../payments/easypaisaProtocol.js";
import { PAYMENT_STATUS } from "./paymentStatus.js";

const { ObjectId } = mongodb;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LOCK_TTL_MS = 30000;
const DEFAULT_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfiguration(overrides = {}) {
  return {
    authHeader: validateAuthHeaderName(
      overrides.authHeader ?? process.env.EASYPAISA_AUTH_HEADER ?? "Credentials"
    ),
    authValue: overrides.authValue ?? process.env.EASYPAISA_AUTH_VALUE,
    storeId: overrides.storeId ?? process.env.EASYPAISA_STORE_ID,
    baseUrl: String(
      overrides.baseUrl ??
        process.env.EASYPAISA_BASE_URL ??
        "https://easypay.easypaisa.com.pk/easypay-service/rest/v4"
    ).replace(/\/$/, ""),
    timeoutMs: positiveInteger(
      overrides.timeoutMs ?? process.env.EASYPAISA_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    lockTtlMs: positiveInteger(overrides.lockTtlMs, DEFAULT_LOCK_TTL_MS),
    reconciliationDelayMs: positiveInteger(
      overrides.reconciliationDelayMs,
      DEFAULT_RECONCILIATION_DELAY_MS
    ),
  };
}

function getAttemptQuery(orderId, paymentAttemptId) {
  const query = { orderId };
  if (paymentAttemptId && ObjectId.isValid(paymentAttemptId)) {
    query._id = new ObjectId(paymentAttemptId);
  }
  return query;
}

async function claimAttempt({
  TransactionDb,
  query,
  idempotencyKey,
  amount,
  submittedAmount,
  lockToken,
  now,
  lockTtlMs,
}) {
  if (!TransactionDb) return { claimed: true, attempt: null };

  const existing = await TransactionDb.findOne(query);
  if (existing?.status === PAYMENT_STATUS.VERIFIED_PAID) {
    return { claimed: false, terminal: true, attempt: existing };
  }

  const update = {
    $set: {
      idempotencyKey,
      provider: "EASYPAISA",
      amount,
      submittedAmount,
      submittedAmountMismatch: Math.abs(amount - submittedAmount) >= 0.01,
      status: PAYMENT_STATUS.PENDING,
      processingLockToken: lockToken,
      processingLockExpiresAt: new Date(now.getTime() + lockTtlMs),
      initiatedAt: existing?.initiatedAt || now,
      lastAttemptAt: now,
      updatedAt: now,
    },
    $inc: { attemptCount: 1 },
  };

  if (typeof TransactionDb.findOneAndUpdate !== "function") {
    await TransactionDb.updateOne(query, update);
    return { claimed: true, attempt: await TransactionDb.findOne(query) };
  }

  const result = await TransactionDb.findOneAndUpdate(
    {
      ...query,
      status: { $ne: PAYMENT_STATUS.VERIFIED_PAID },
      $or: [
        { processingLockExpiresAt: { $exists: false } },
        { processingLockExpiresAt: null },
        { processingLockExpiresAt: { $lte: now } },
      ],
    },
    update,
    { returnOriginal: false }
  );

  if (result?.value) return { claimed: true, attempt: result.value };
  return {
    claimed: false,
    terminal: false,
    attempt: await TransactionDb.findOne(query),
  };
}

async function persistAttempt(TransactionDb, query, lockToken, values, now) {
  if (!TransactionDb) return;
  await TransactionDb.updateOne(
    lockToken ? { ...query, processingLockToken: lockToken } : query,
    {
      $set: { ...values, updatedAt: now },
      $unset: {
        processingLockToken: "",
        processingLockExpiresAt: "",
      },
    }
  );
}

async function persistOrder({
  OrdersDb,
  orderId,
  amount,
  status,
  isPaid,
  transactionId,
  initiatedAt,
  verifiedAt,
  now,
}) {
  const values = {
    paymentStatus: status,
    authoritativePaymentAmount: amount,
    "payments.0.finalAmount": amount,
    isPaid: Boolean(isPaid),
    updatedAt: now,
  };
  if (initiatedAt) values.paymentInitiatedAt = initiatedAt;
  if (transactionId) values.transactionId = transactionId;
  if (verifiedAt) values.paymentVerifiedAt = verifiedAt;

  await OrdersDb.updateOne(
    isPaid ? { _id: orderId } : { _id: orderId, isPaid: { $ne: true } },
    { $set: values }
  );
}

async function persistStatus({
  TransactionDb,
  OrdersDb,
  attemptQuery,
  lockToken,
  orderId,
  amount,
  status,
  transactionId,
  attemptValues,
  initiatedAt,
  now,
}) {
  await persistAttempt(
    TransactionDb,
    attemptQuery,
    lockToken,
    { ...attemptValues, status, isPaid: false },
    now
  );
  await persistOrder({
    OrdersDb,
    orderId,
    amount,
    status,
    isPaid: false,
    transactionId,
    initiatedAt,
    now,
  });
}

export async function initiateEasyPaisaPayment(params, dependencies = {}) {
  const {
    kitchenOrderId,
    externalOrderId,
    storeId,
    submittedAmount,
    transactionType,
    mobileAccountNo,
    emailAddress,
    paymentAttemptId,
    TransactionDb,
    OrdersDb,
  } = params;

  if (!OrdersDb) throw new TypeError("OrdersDb is required");
  const submitted = positiveMoney(submittedAmount);
  if (submitted === null) {
    throw new ReactionError("invalid-payment", "A valid transaction amount is required");
  }
  if (!mobileAccountNo) {
    throw new ReactionError("invalid-payment", "A mobile account number is required");
  }

  const config = readConfiguration({
    ...dependencies.config,
    storeId: storeId || dependencies.config?.storeId,
  });
  if (!config.authValue || !config.storeId) {
    throw new ReactionError("payment-configuration", "EasyPaisa is not configured");
  }

  const orderId = (dependencies.decodeOrderReference || decodeOrderReference)(
    externalOrderId
  );
  if (!orderId) {
    throw new ReactionError("invalid-payment", "A valid order reference is required");
  }

  const order = await OrdersDb.findOne({ _id: orderId });
  if (!order) {
    throw new ReactionError("not-found", "Order not found while initiating payment");
  }
  if (order.isPaid === true || order.paymentStatus === PAYMENT_STATUS.VERIFIED_PAID) {
    return {
      status: PAYMENT_STATUS.VERIFIED_PAID,
      transactionId: order.transactionId || null,
      isPaid: true,
      idempotent: true,
    };
  }

  const amount = getOrderInvoiceTotal(order);
  if (amount === null) {
    throw new ReactionError("invalid-payment", "The order does not have a valid payable amount");
  }

  const clock = dependencies.clock || { now: () => new Date() };
  const httpClient = dependencies.httpClient || axios;
  const publishStatus = dependencies.publishStatus || publishPaymentStatus;
  const createLockToken =
    dependencies.createLockToken || (() => randomBytes(16).toString("hex"));
  const attemptReference = paymentAttemptId || kitchenOrderId;
  const attemptQuery = getAttemptQuery(orderId, paymentAttemptId);
  const idempotencyKey = buildIdempotencyKey(
    "easypaisa",
    orderId,
    attemptReference
  );
  const initiatedAt = clock.now();
  const lockToken = createLockToken();
  const claim = await claimAttempt({
    TransactionDb,
    query: attemptQuery,
    idempotencyKey,
    amount,
    submittedAmount: submitted,
    lockToken,
    now: initiatedAt,
    lockTtlMs: config.lockTtlMs,
  });

  if (!claim.claimed) {
    return {
      status: claim.attempt?.status || PAYMENT_STATUS.PENDING,
      transactionId: claim.attempt?.transactionId || null,
      isPaid: claim.attempt?.status === PAYMENT_STATUS.VERIFIED_PAID,
      idempotent: true,
      inProgress: !claim.terminal,
    };
  }

  await persistOrder({
    OrdersDb,
    orderId,
    amount,
    status: PAYMENT_STATUS.PENDING,
    isPaid: false,
    initiatedAt,
    now: initiatedAt,
  });
  publishStatus({
    branchId: order.branchID,
    externalOrderId,
    orderId,
    status: PAYMENT_STATUS.PENDING,
    isPaid: false,
    initiatedAt,
  });

  const request = {
    orderId: kitchenOrderId,
    storeId: config.storeId,
    transactionAmount: amount,
    transactionType: transactionType || "MA",
    mobileAccountNo,
    emailAddress,
    optional1: externalOrderId,
    optional2: String(paymentAttemptId || ""),
  };

  let response;
  try {
    response = await httpClient.post(
      `${config.baseUrl}/initiate-ma-transaction`,
      request,
      {
        timeout: config.timeoutMs,
        maxRedirects: 0,
        headers: {
          [config.authHeader]: config.authValue,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        validateStatus: (status) => status >= 200 && status < 500,
      }
    );
  } catch (error) {
    const now = clock.now();
    const uncertain = isUncertainProviderError(error);
    const status = uncertain
      ? PAYMENT_STATUS.PENDING_REVIEW
      : PAYMENT_STATUS.FAILED;
    await persistStatus({
      TransactionDb,
      OrdersDb,
      attemptQuery,
      lockToken,
      orderId,
      amount,
      status,
      transactionId: null,
      initiatedAt,
      now,
      attemptValues: {
        failureCode: error?.code || null,
        failureReason: uncertain
          ? "Provider result is unknown"
          : "Provider rejected the request",
        lastErrorAt: now,
        nextReconciliationAt: uncertain
          ? new Date(now.getTime() + config.reconciliationDelayMs)
          : null,
      },
    });
    publishStatus({
      branchId: order.branchID,
      externalOrderId,
      orderId,
      status,
      isPaid: false,
      initiatedAt,
    });
    if (uncertain) {
      return { status, isPaid: false, pendingVerification: true };
    }
    throw new ReactionError("payment-failed", "EasyPaisa rejected the payment request");
  }

  const result = evaluateInitiationResponse(response.status, response.data);
  const completedAt = clock.now();
  await persistStatus({
    TransactionDb,
    OrdersDb,
    attemptQuery,
    lockToken,
    orderId,
    amount,
    status: result.status,
    transactionId: result.transactionId,
    initiatedAt,
    now: completedAt,
    attemptValues: {
      responseCode: result.responseCode,
      responseMessage: result.responseMessage,
      transactionId: result.transactionId,
      transactionDateTime: result.transactionDateTime,
      providerHttpStatus: response.status,
      lastResponseAt: completedAt,
      nextReconciliationAt: result.accepted
        ? new Date(completedAt.getTime() + config.reconciliationDelayMs)
        : null,
    },
  });
  publishStatus({
    branchId: order.branchID,
    externalOrderId,
    orderId,
    status: result.status,
    isPaid: false,
    initiatedAt,
  });

  if (!result.accepted) {
    throw new ReactionError("payment-failed", "EasyPaisa rejected the payment request");
  }
  return result;
}

export default function doEasyPaisaPayment(
  kitchenOrderId,
  externalOrderId,
  storeId,
  submittedAmount,
  transactionType,
  mobileAccountNo,
  emailAddress,
  paymentAttemptId,
  TransactionDb,
  OrdersDb,
  dependencies
) {
  return initiateEasyPaisaPayment(
    {
      kitchenOrderId,
      externalOrderId,
      storeId,
      submittedAmount,
      transactionType,
      mobileAccountNo,
      emailAddress,
      paymentAttemptId,
      TransactionDb,
      OrdersDb,
    },
    dependencies
  );
}

export { claimAttempt, getAttemptQuery, readConfiguration };
