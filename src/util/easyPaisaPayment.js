import axios from "axios";
import { randomBytes } from "crypto";
import ReactionError from "@reactioncommerce/reaction-error";
import mongodb from "mongodb";
import decodeOpaqueId from "@reactioncommerce/api-utils/decodeOpaqueId.js";
import pubSub from "./pubSubIntance.js";
import { PAYMENT_STATUS } from "./paymentStatus.js";
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

const { ObjectId } = mongodb;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LOCK_TTL_MS = 30000;
const DEFAULT_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;

function decodeOrderId(value) {
  if (!value) return null;
  try {
    return decodeOpaqueId(value)?.id || value;
  } catch (error) {
    return value;
  }
}

function getAttemptQuery(orderId, attemptId) {
  const query = { orderId };
  if (attemptId && ObjectId.isValid(attemptId)) {
    query._id = new ObjectId(attemptId);
  }
  return query;
}

function defaultPublishStatus({
  branchId,
  externalOrderId,
  orderId,
  status,
  isPaid,
  initiatedAt,
}) {
  const event = {
    orderId,
    paymentStatus: status,
    updatedAt: new Date(),
    paymentMethod: "EASYPAISA",
    isPaid,
    paymentInitiatedAt: initiatedAt,
  };

  if (branchId) {
    pubSub.publish(`ORDER_PAYMENT_STATUS_UPDATED_${branchId}`, {
      orderPaymentStatusUpdated: event,
    });
  }

  if (externalOrderId) {
    pubSub.publish(`ORDER_PAYMENT_STATUS_UPDATED_${externalOrderId}`, {
      orderPaymentStatusUpdated: {
        ...event,
        orderId: externalOrderId,
      },
    });
  }
}

function readConfiguration(overrides = {}) {
  const timeoutMs = Number.parseInt(
    String(overrides.timeoutMs ?? process.env.EASYPAISA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    10
  );
  const lockTtlMs = Number.parseInt(
    String(overrides.lockTtlMs ?? DEFAULT_LOCK_TTL_MS),
    10
  );
  const reconciliationDelayMs = Number.parseInt(
    String(overrides.reconciliationDelayMs ?? DEFAULT_RECONCILIATION_DELAY_MS),
    10
  );

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
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    lockTtlMs: Number.isFinite(lockTtlMs) && lockTtlMs > 0 ? lockTtlMs : DEFAULT_LOCK_TTL_MS,
    reconciliationDelayMs:
      Number.isFinite(reconciliationDelayMs) && reconciliationDelayMs > 0
        ? reconciliationDelayMs
        : DEFAULT_RECONCILIATION_DELAY_MS,
  };
}

async function claimPaymentAttempt({
  TransactionDb,
  attemptQuery,
  idempotencyKey,
  amount,
  submittedAmount,
  now,
  lockTtlMs,
  lockToken,
}) {
  if (!TransactionDb) return { claimed: true, attempt: null };

  const existing = await TransactionDb.findOne(attemptQuery);
  if (existing?.status === PAYMENT_STATUS.VERIFIED_PAID) {
    return { claimed: false, terminal: true, attempt: existing };
  }

  const lockExpiresAt = new Date(now.getTime() + lockTtlMs);
  const update = {
    $set: {
      idempotencyKey,
      amount,
      submittedAmount,
      submittedAmountMismatch: Math.abs(amount - submittedAmount) >= 0.01,
      provider: "EASYPAISA",
      status: PAYMENT_STATUS.PENDING,
      processingLockToken: lockToken,
      processingLockExpiresAt: lockExpiresAt,
      initiatedAt: existing?.initiatedAt || now,
      lastAttemptAt: now,
      updatedAt: now,
    },
    $inc: { attemptCount: 1 },
  };

  if (typeof TransactionDb.findOneAndUpdate === "function") {
    const result = await TransactionDb.findOneAndUpdate(
      {
        ...attemptQuery,
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

    const attempt = result?.value || null;
    if (!attempt) {
      return {
        claimed: false,
        terminal: false,
        attempt: await TransactionDb.findOne(attemptQuery),
      };
    }
    return { claimed: true, attempt };
  }

  await TransactionDb.updateOne(attemptQuery, update);
  return { claimed: true, attempt: await TransactionDb.findOne(attemptQuery) };
}

async function updateAttempt(TransactionDb, attemptQuery, values, lockToken, now) {
  if (!TransactionDb) return;
  const query = lockToken
    ? { ...attemptQuery, processingLockToken: lockToken }
    : attemptQuery;

  await TransactionDb.updateOne(query, {
    $set: { ...values, updatedAt: now },
    $unset: {
      processingLockToken: "",
      processingLockExpiresAt: "",
    },
  });
}

async function updateOrderPayment({
  OrdersDb,
  orderId,
  status,
  isPaid,
  amount,
  transactionId,
  initiatedAt,
  verifiedAt,
  now,
}) {
  const setValues = {
    paymentStatus: status,
    authoritativePaymentAmount: amount,
    "payments.0.finalAmount": amount,
    updatedAt: now,
  };

  if (initiatedAt) setValues.paymentInitiatedAt = initiatedAt;
  if (transactionId) setValues.transactionId = transactionId;
  if (verifiedAt) setValues.paymentVerifiedAt = verifiedAt;

  if (isPaid) {
    setValues.isPaid = true;
  } else {
    setValues.isPaid = false;
  }

  await OrdersDb.updateOne(
    isPaid ? { _id: orderId } : { _id: orderId, isPaid: { $ne: true } },
    { $set: setValues }
  );
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

  if (!OrdersDb) {
    throw new TypeError("OrdersDb is required");
  }

  const httpClient = dependencies.httpClient || axios;
  const clock = dependencies.clock || { now: () => new Date() };
  const publishStatus = dependencies.publishStatus || defaultPublishStatus;
  const createLockToken =
    dependencies.createLockToken || (() => randomBytes(16).toString("hex"));
  const config = readConfiguration({
    ...dependencies.config,
    storeId: storeId || dependencies.config?.storeId,
  });

  const normalizedSubmittedAmount = positiveMoney(submittedAmount);
  if (normalizedSubmittedAmount === null) {
    throw new ReactionError("invalid-payment", "A valid transaction amount is required");
  }
  if (!mobileAccountNo) {
    throw new ReactionError("invalid-payment", "A mobile account number is required");
  }
  if (!config.authValue || !config.storeId) {
    throw new ReactionError("payment-configuration", "EasyPaisa is not configured");
  }

  const orderId = decodeOrderId(externalOrderId);
  if (!orderId) {
    throw new ReactionError("invalid-payment", "A valid order reference is required");
  }

  const order = await OrdersDb.findOne({ _id: orderId });
  if (!order) {
    throw new ReactionError("not-found", "Order not found while initiating payment");
  }

  const amount = getOrderInvoiceTotal(order);
  if (amount === null) {
    throw new ReactionError("invalid-payment", "The order does not have a valid payable amount");
  }

  const attemptReference = paymentAttemptId || kitchenOrderId;
  const attemptQuery = getAttemptQuery(orderId, paymentAttemptId);
  const idempotencyKey = buildIdempotencyKey("easypaisa", orderId, attemptReference);
  const now = clock.now();
  const lockToken = createLockToken();
  const claim = await claimPaymentAttempt({
    TransactionDb,
    attemptQuery,
    idempotencyKey,
    amount,
    submittedAmount: normalizedSubmittedAmount,
    now,
    lockTtlMs: config.lockTtlMs,
    lockToken,
  });

  if (!claim.claimed) {
    return {
      status: claim.attempt?.status || PAYMENT_STATUS.PENDING,
      transactionId: claim.attempt?.transactionId || null,
      idempotent: true,
      inProgress: !claim.terminal,
      isPaid: claim.attempt?.status === PAYMENT_STATUS.VERIFIED_PAID,
    };
  }

  await updateOrderPayment({
    OrdersDb,
    orderId,
    status: PAYMENT_STATUS.PENDING,
    isPaid: false,
    amount,
    initiatedAt: now,
    now,
  });

  publishStatus({
    branchId: order.branchID,
    externalOrderId,
    orderId,
    status: PAYMENT_STATUS.PENDING,
    isPaid: false,
    initiatedAt: now,
  });

  const requestData = {
    orderId: kitchenOrderId,
    storeId: config.storeId,
    transactionAmount: amount,
    transactionType: transactionType || "MA",
    mobileAccountNo,
    emailAddress,
    optional1: externalOrderId,
    optional2: String(paymentAttemptId || ""),
  };

  try {
    const response = await httpClient.post(
      `${config.baseUrl}/initiate-ma-transaction`,
      requestData,
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

    const result = evaluateInitiationResponse(response.status, response.data);
    const completedAt = clock.now();

    await updateAttempt(
      TransactionDb,
      attemptQuery,
      {
        responseCode: result.responseCode,
        responseMessage: result.responseMessage,
        transactionId: result.transactionId,
        transactionDateTime: result.transactionDateTime,
        providerHttpStatus: response.status,
        status: result.status,
        isPaid: false,
        lastResponseAt: completedAt,
      },
      lockToken,
      completedAt
    );

    await updateOrderPayment({
      OrdersDb,
      orderId,
      status: result.status,
      isPaid: false,
      amount,
      transactionId: result.transactionId,
      initiatedAt: now,
      now: completedAt,
    });

    publishStatus({
      branchId: order.branchID,
      externalOrderId,
      orderId,
      status: result.status,
      isPaid: false,
      initiatedAt: now,
    });

    if (!result.accepted) {
      throw new ReactionError("payment-failed", "EasyPaisa rejected the payment request");
    }

    return result;
  } catch (error) {
    const uncertain = isUncertainProviderError(error);
    const status = uncertain
      ? PAYMENT_STATUS.PENDING_REVIEW
      : PAYMENT_STATUS.FAILED;
    const failedAt = clock.now();

    await updateAttempt(
      TransactionDb,
      attemptQuery,
      {
        status,
        failureCode: error?.code || null,
        failureReason: uncertain
          ? "Provider result is unknown"
          : "Provider rejected the request",
        lastErrorAt: failedAt,
        nextReconciliationAt: uncertain
          ? new Date(failedAt.getTime() + config.reconciliationDelayMs)
          : null,
      },
      lockToken,
      failedAt
    );

    await updateOrderPayment({
      OrdersDb,
      orderId,
      status,
      isPaid: false,
      amount,
      initiatedAt: now,
      now: failedAt,
    });

    publishStatus({
      branchId: order.branchID,
      externalOrderId,
      orderId,
      status,
      isPaid: false,
      initiatedAt: now,
    });

    if (uncertain) {
      return {
        status,
        isPaid: false,
        pendingVerification: true,
      };
    }

    if (error instanceof ReactionError) throw error;
    throw new ReactionError("payment-failed", "EasyPaisa rejected the payment request");
  }
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
