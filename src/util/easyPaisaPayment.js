import axios from "axios";
import ReactionError from "@reactioncommerce/reaction-error";
import mongodb from "mongodb";
import pubSub from "./pubSubIntance.js";
import decodeOpaqueId from "@reactioncommerce/api-utils/decodeOpaqueId.js";
import { PAYMENT_STATUS } from "./paymentStatus.js";

const { ObjectId } = mongodb;

function decodeOrderId(value) {
  if (!value) return null;
  try {
    return decodeOpaqueId(value)?.id || value;
  } catch (error) {
    return value;
  }
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function getOrderInvoiceTotal(order) {
  const total = (order?.shipping || []).reduce(
    (sum, group) => sum + Number(group?.invoice?.total || 0),
    0
  );
  return normalizeAmount(total);
}

function getAttemptQuery(orderId, attemptId) {
  const query = { orderId };
  if (attemptId && ObjectId.isValid(attemptId)) query._id = new ObjectId(attemptId);
  return query;
}

function publishStatus({ branchId, externalOrderId, orderId, status, isPaid, initiatedAt }) {
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
      orderPaymentStatusUpdated: { ...event, orderId: externalOrderId },
    });
  }
}

function sanitizeResponse(data = {}) {
  return {
    responseCode: data.responseCode || null,
    responseMessage: data.responseDesc || null,
    transactionId: data.transactionId || null,
    transactionDateTime: data.transactionDateTime || null,
  };
}

export default async function doEasyPaisaPayment(
  kitchenOrderID,
  orderId,
  storeId,
  transactionAmount,
  transactionType,
  mobileAccountNo,
  emailAddress,
  transactionRecord,
  TransactionDb,
  OrdersDb
) {
  const submittedAmount = normalizeAmount(transactionAmount);
  if (submittedAmount === null) {
    throw new ReactionError("invalid-payment", "A valid transaction amount is required");
  }
  if (!mobileAccountNo) {
    throw new ReactionError("invalid-payment", "A mobile account number is required");
  }

  const providerAuthHeader = process.env.EASYPAISA_AUTH_HEADER;
  const providerAuthValue = process.env.EASYPAISA_AUTH_VALUE;
  const configuredStoreId = storeId || process.env.EASYPAISA_STORE_ID;
  if (!providerAuthHeader || !providerAuthValue || !configuredStoreId) {
    throw new ReactionError("payment-configuration", "The payment provider is not configured");
  }

  const lookupId = decodeOrderId(orderId);
  if (!lookupId) {
    throw new ReactionError("invalid-payment", "A valid order reference is required");
  }

  const order = await OrdersDb.findOne({ _id: lookupId });
  if (!order) {
    throw new ReactionError("not-found", "Order not found while initiating payment");
  }

  const authoritativeAmount =
    getOrderInvoiceTotal(order) || normalizeAmount(order?.payments?.[0]?.finalAmount);
  if (authoritativeAmount === null) {
    throw new ReactionError("invalid-payment", "The order does not have a valid payable amount");
  }
  const amount = authoritativeAmount;
  const submittedAmountMismatch = Math.abs(authoritativeAmount - submittedAmount) >= 0.01;

  const attemptQuery = getAttemptQuery(lookupId, transactionRecord);
  const existingAttempt = TransactionDb ? await TransactionDb.findOne(attemptQuery) : null;
  if (existingAttempt?.status === PAYMENT_STATUS.VERIFIED_PAID) {
    return {
      status: existingAttempt.status,
      transactionId: existingAttempt.transactionId,
      idempotent: true,
    };
  }

  const idempotencyKey = `easypaisa:${lookupId}:${String(transactionRecord || kitchenOrderID)}`;
  const initiatedAt = new Date();
  const timeout = Number.parseInt(process.env.EASYPAISA_TIMEOUT_MS || "15000", 10);
  const baseUrl = (
    process.env.EASYPAISA_BASE_URL ||
    "https://easypay.easypaisa.com.pk/easypay-service/rest/v4"
  ).replace(/\/$/, "");

  const requestData = {
    orderId: kitchenOrderID,
    storeId: configuredStoreId,
    transactionAmount:
      ["development", "staging"].includes(process.env.ENVIRONMENT) &&
      process.env.EASYPAISA_TEST_AMOUNT
        ? normalizeAmount(process.env.EASYPAISA_TEST_AMOUNT)
        : amount,
    transactionType: transactionType || "MA",
    mobileAccountNo,
    emailAddress,
    optional1: orderId,
    optional2: String(transactionRecord),
  };

  if (TransactionDb) {
    await TransactionDb.updateOne(
      attemptQuery,
      {
        $set: {
          idempotencyKey,
          amount,
          submittedAmount,
          submittedAmountMismatch,
          status: PAYMENT_STATUS.PENDING,
          provider: "EASYPAISA",
          initiatedAt,
          lastAttemptAt: initiatedAt,
          updatedAt: initiatedAt,
        },
        $inc: { attemptCount: 1 },
      }
    );
  }

  await OrdersDb.updateOne(
    { _id: lookupId, isPaid: { $ne: true } },
    {
      $set: {
        paymentStatus: PAYMENT_STATUS.PENDING,
        isPaid: false,
        paymentInitiatedAt: initiatedAt,
        paymentAttemptId: transactionRecord ? String(transactionRecord) : null,
        authoritativePaymentAmount: amount,
        updatedAt: initiatedAt,
      },
    }
  );

  publishStatus({
    branchId: order.branchID,
    externalOrderId: orderId,
    orderId: lookupId,
    status: PAYMENT_STATUS.PENDING,
    isPaid: false,
    initiatedAt,
  });

  try {
    const response = await axios.post(`${baseUrl}/initiate-ma-transaction`, requestData, {
      timeout: Number.isNaN(timeout) ? 15000 : timeout,
      maxRedirects: 0,
      headers: {
        [providerAuthHeader]: providerAuthValue,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });

    const providerResponse = sanitizeResponse(response.data);
    const providerSuccess =
      response.status >= 200 &&
      response.status < 300 &&
      providerResponse.responseCode === "0000" &&
      String(providerResponse.responseMessage || "").toUpperCase() === "SUCCESS" &&
      Boolean(providerResponse.transactionId);
    const trustInitiateResponse = process.env.EASYPAISA_TRUST_INITIATE_RESPONSE === "true";

    let status = PAYMENT_STATUS.FAILED;
    let isPaid = false;
    if (providerSuccess && trustInitiateResponse) {
      status = PAYMENT_STATUS.VERIFIED_PAID;
      isPaid = true;
    } else if (providerSuccess) {
      status = PAYMENT_STATUS.PENDING_VERIFICATION;
    }

    if (TransactionDb) {
      await TransactionDb.updateOne(
        attemptQuery,
        {
          $set: {
            ...providerResponse,
            providerHttpStatus: response.status,
            providerStatus: providerResponse.responseMessage,
            status,
            isPaid,
            lastResponseAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );
    }

    await OrdersDb.updateOne(
      { _id: lookupId, isPaid: { $ne: true } },
      {
        $set: {
          isPaid,
          paymentStatus: status,
          transactionId: providerResponse.transactionId,
          paymentVerifiedAt: isPaid ? new Date() : null,
          updatedAt: new Date(),
        },
      }
    );

    publishStatus({
      branchId: order.branchID,
      externalOrderId: orderId,
      orderId: lookupId,
      status,
      isPaid,
      initiatedAt,
    });

    return { ...providerResponse, status, isPaid };
  } catch (error) {
    const uncertainOutcome =
      error.code === "ECONNABORTED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      !error.response;
    const status = uncertainOutcome
      ? PAYMENT_STATUS.PENDING_REVIEW
      : PAYMENT_STATUS.FAILED;

    if (TransactionDb) {
      await TransactionDb.updateOne(
        attemptQuery,
        {
          $set: {
            status,
            failureCode: error.code || null,
            failureReason: uncertainOutcome
              ? "Provider result is unknown"
              : "Provider rejected the request",
            lastErrorAt: new Date(),
            nextReconciliationAt: uncertainOutcome
              ? new Date(Date.now() + 5 * 60 * 1000)
              : null,
            updatedAt: new Date(),
          },
        }
      );
    }

    await OrdersDb.updateOne(
      { _id: lookupId, isPaid: { $ne: true } },
      { $set: { isPaid: false, paymentStatus: status, updatedAt: new Date() } }
    );

    publishStatus({
      branchId: order.branchID,
      externalOrderId: orderId,
      orderId: lookupId,
      status,
      isPaid: false,
      initiatedAt,
    });

    if (uncertainOutcome) {
      return { status, isPaid: false, pendingVerification: true };
    }
    throw new ReactionError("payment-failed", "The payment provider rejected the request");
  }
}
