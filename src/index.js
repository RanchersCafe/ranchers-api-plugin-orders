import pkg from "../package.json";
import i18n from "./i18n/index.js";
import cors from "cors";
import bodyParser from "body-parser";
import morgan from "morgan";
import axios from "axios";
import https from "https";
import mongodb from "mongodb";
import mutations from "./mutations/index.js";
import policies from "./policies.json";
import preStartup from "./preStartup.js";
import queries from "./queries/index.js";
import resolvers from "./resolvers/index.js";
import schemas from "./schemas/index.js";
import { Order, OrderFulfillmentGroup, OrderItem } from "./simpleSchemas.js";
import startup from "./startup.js";
import getDataForOrderEmail from "./util/getDataForOrderEmail.js";
import decodeOpaqueId from "@reactioncommerce/api-utils/decodeOpaqueId.js";
import pubSub from "./util/pubSubIntance.js";

const { ObjectId } = mongodb;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://admin.rancherscafe.com",
  "https://ops.rancherscafe.com",
  "https://api.rancherscafe.com",
  "https://simosa.rancherscafe.com",
  "https://rancherscafe.com",
  "https://www.rancherscafe.com",
];

function csvEnv(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  if (!Number.isFinite(amount)) return null;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function amountsMatch(expected, actual) {
  const normalizedExpected = normalizeAmount(expected);
  const normalizedActual = normalizeAmount(actual);
  if (normalizedExpected === null || normalizedActual === null) return false;
  return Math.abs(normalizedExpected - normalizedActual) < 0.01;
}

function sanitizeProviderStatus(data = {}) {
  return {
    orderId: data.order_id || null,
    transactionId: data.transaction_id || null,
    transactionStatus: data.transaction_status || null,
    responseCode: data.response_code || null,
    paidAmount: normalizeAmount(data.transaction_amount),
    paidAt: data.paid_datetime || null,
    description: data.description || null,
  };
}

function publishPaymentStatus({ branchId, externalOrderId, orderId, paymentMethod, paymentStatus, isPaid, paymentInitiatedAt }) {
  const event = {
    orderId,
    paymentStatus,
    updatedAt: new Date(),
    paymentMethod,
    isPaid,
    paymentInitiatedAt,
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

async function forwardStatusUrl(targetUrl, statusUrl, httpsAgent) {
  if (!targetUrl) return;
  try {
    await axios.post(
      targetUrl,
      {},
      {
        params: { url: statusUrl },
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
        httpsAgent,
      }
    );
  } catch (error) {
    console.error("Payment status forwarding failed:", error.message);
  }
}

function registerPaymentRoutes(context) {
  const { app } = context;
  if (!app.expressApp) return;

  const allowedOrigins = csvEnv("ORDERS_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS);
  app.expressApp.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Origin is not allowed"));
      },
    })
  );
  app.expressApp.use(bodyParser.json({ limit: "1mb" }));
  app.expressApp.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));
  app.expressApp.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  app.expressApp.post("/jazzcash/ipn", async (req, res) => {
    const payload = req.body || {};
    const reference = payload.pp_TxnRefNo;
    const responseCode = payload.pp_ResponseCode;

    if (!reference || !responseCode) {
      return res.status(400).json({ success: false, message: "Invalid payment notification" });
    }

    try {
      const { Transaction } = context.collections;
      await Transaction.updateOne(
        { transactionId: reference },
        {
          $set: {
            statusCode: responseCode,
            paymentResMsg: payload.pp_ResponseMessage || null,
            updatedAt: new Date(),
          },
        }
      );
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("JazzCash notification processing failed:", error.message);
      return res.status(500).json({ success: false });
    }
  });

  app.expressApp.post("/webhook/easypaisa", async (req, res) => {
    const statusUrl = req.query.url || req.body?.url;
    if (!statusUrl) {
      return res.status(400).json({ success: false, message: "Missing status URL" });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(statusUrl);
    } catch (error) {
      return res.status(400).json({ success: false, message: "Invalid status URL" });
    }

    const allowedHosts = csvEnv("EASYPAISA_STATUS_ALLOWED_HOSTS", ["easypay.easypaisa.com.pk"]);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username ||
      parsedUrl.password ||
      !allowedHosts.includes(parsedUrl.hostname)
    ) {
      return res.status(403).json({ success: false, message: "Status URL is not allowed" });
    }

    try {
      const timeout = Number.parseInt(process.env.EASYPAISA_TIMEOUT_MS || "15000", 10);
      const statusResponse = await axios.get(parsedUrl.toString(), {
        timeout: Number.isNaN(timeout) ? 15000 : timeout,
        maxRedirects: 0,
      });
      const transactionData = statusResponse.data || {};
      const safeStatus = sanitizeProviderStatus(transactionData);
      const externalOrderId = transactionData.optional1;
      const transactionRecordId = transactionData.optional2;
      const orderId = decodeOrderId(externalOrderId);

      if (!orderId || !transactionRecordId) {
        return res.status(422).json({ success: false, message: "Payment status is missing order references" });
      }

      const { Orders, Transaction } = context.collections;
      const order = await Orders.findOne({ _id: orderId });
      if (!order) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      const transactionQuery = { orderId };
      if (ObjectId.isValid(transactionRecordId)) {
        transactionQuery._id = new ObjectId(transactionRecordId);
      }
      const transaction = await Transaction.findOne(transactionQuery);
      if (!transaction) {
        return res.status(404).json({ success: false, message: "Payment attempt not found" });
      }

      const expectedAmount = normalizeAmount(
        transaction.amount ?? order?.payments?.[0]?.finalAmount
      );
      const amountMatches = amountsMatch(expectedAmount, safeStatus.paidAmount);
      const providerPaid =
        String(safeStatus.transactionStatus || "").toUpperCase() === "PAID" &&
        safeStatus.responseCode === "0000" &&
        Boolean(safeStatus.transactionId);

      let paymentStatus = "PENDING";
      let isPaid = false;
      if (providerPaid && amountMatches) {
        paymentStatus = "VERIFIED_PAID";
        isPaid = true;
      } else if (providerPaid && !amountMatches) {
        paymentStatus = "AMOUNT_MISMATCH";
      } else if (["FAILED", "CANCELLED", "EXPIRED"].includes(String(safeStatus.transactionStatus || "").toUpperCase())) {
        paymentStatus = String(safeStatus.transactionStatus).toUpperCase();
      }

      await Transaction.updateOne(
        transactionQuery,
        {
          $set: {
            providerStatus: safeStatus.transactionStatus,
            status: paymentStatus,
            responseCode: safeStatus.responseCode,
            responseMessage: safeStatus.description,
            transactionId: safeStatus.transactionId,
            verifiedAmount: safeStatus.paidAmount,
            amountMatches,
            transactionDateTime: safeStatus.paidAt,
            lastVerifiedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );

      if (!order.isPaid || isPaid) {
        await Orders.updateOne(
          { _id: orderId },
          {
            $set: {
              isPaid: order.isPaid || isPaid,
              paymentStatus: order.isPaid ? order.paymentStatus : paymentStatus,
              transactionId: safeStatus.transactionId || order.transactionId || null,
              verifiedPaymentAmount: safeStatus.paidAmount,
              paymentVerifiedAt: isPaid ? new Date() : order.paymentVerifiedAt || null,
              updatedAt: new Date(),
            },
          }
        );
      }

      publishPaymentStatus({
        branchId: order.branchID,
        externalOrderId,
        orderId,
        paymentMethod: order.paymentMethod || "EASYPAISA",
        paymentStatus: order.isPaid ? order.paymentStatus : paymentStatus,
        isPaid: order.isPaid || isPaid,
        paymentInitiatedAt: order.paymentInitiatedAt,
      });

      const insecureAgent = process.env.FINNECT_ALLOW_INSECURE_TLS === "true"
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined;
      void forwardStatusUrl(process.env.FINNECT_EASYPAISA_WEBHOOK_URL, statusUrl, insecureAgent);
      void forwardStatusUrl(process.env.RANCHERS_EASYPAISA_MONITOR_URL, statusUrl, insecureAgent);

      return res.status(200).json({
        success: true,
        paymentStatus,
        orderId,
      });
    } catch (error) {
      const status = error.code === "ECONNABORTED" ? 504 : 502;
      console.error("EasyPaisa status processing failed:", error.message);
      return res.status(status).json({ success: false, message: "Unable to verify payment status" });
    }
  });
}

export default async function register(app) {
  await app.registerPlugin({
    label: "Orders",
    name: "orders",
    version: pkg.version,
    i18n,
    collections: {
      Orders: {
        name: "Orders",
        indexes: [
          [{ accountId: 1, shopId: 1 }],
          [{ createdAt: -1 }, { name: "c2_createdAt" }],
          [{ email: 1 }, { name: "c2_email" }],
          [{ referenceId: 1 }, { unique: true }],
          [{ shopId: 1 }, { name: "c2_shopId" }],
          [{ "shipping.items.productId": 1 }],
          [{ "shipping.items.variantId": 1 }],
          [{ "payments.address.fullName": 1 }],
          [{ "shipping.address.fullName": 1 }],
          [{ "payments.address.phone": 1 }],
          [{ "workflow.status": 1 }, { name: "c2_workflow.status" }],
          [{ branchID: 1, createdAt: -1 }, { name: "orders_branch_createdAt" }],
          [{ paymentStatus: 1, createdAt: -1 }, { name: "orders_payment_status" }],
        ],
      },
      CartHistory: {
        name: "CartHistory",
        updatedAt: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now },
      },
      WhatsAppMessage: {
        name: "WhatsAppMessage",
        updatedAt: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now },
      },
      Transaction: {
        name: "Transaction",
        updatedAt: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now },
        indexes: [
          [{ orderId: 1, createdAt: -1 }, { name: "transaction_order_createdAt" }],
          [{ transactionId: 1 }, { name: "transaction_provider_id", unique: true, sparse: true }],
          [{ idempotencyKey: 1 }, { name: "transaction_idempotency", unique: true, sparse: true }],
          [{ status: 1, createdAt: 1 }, { name: "transaction_status_createdAt" }],
        ],
      },
      FavoriteOrder: {
        name: "FavoriteOrder",
        updatedAt: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now },
      },
    },
    functionsByType: {
      getDataForOrderEmail: [getDataForOrderEmail],
      preStartup: [preStartup, registerPaymentRoutes],
      startup: [startup],
    },
    graphQL: {
      resolvers,
      schemas,
    },
    mutations,
    queries,
    policies,
    simpleSchemas: {
      Order,
      OrderFulfillmentGroup,
      OrderItem,
    },
  });
}
