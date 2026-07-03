import axios from "axios";
import bodyParser from "body-parser";
import { processEasyPaisaStatus } from "./processEasyPaisaStatus.js";

function csvEnvironment(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function forwardStatusUrl(targetUrl, statusUrl) {
  if (!targetUrl) return;
  try {
    await axios.post(targetUrl, {}, {
      params: { url: statusUrl },
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
      maxRedirects: 0,
    });
  } catch (error) {
    console.error("Payment status forwarding failed:", error.message);
  }
}

function httpStatusForError(error) {
  if (error?.code === "ORDER_NOT_FOUND" || error?.code === "PAYMENT_ATTEMPT_NOT_FOUND") return 404;
  if (error?.code === "INVALID_PROVIDER_REFERENCE") return 422;
  if (error instanceof TypeError) return 400;
  if (["ECONNABORTED", "ETIMEDOUT"].includes(error?.code)) return 504;
  return 502;
}

export default function registerPaymentRoutes(context) {
  const expressApp = context?.app?.expressApp;
  if (!expressApp) return;

  const jsonParser = bodyParser.json({ limit: "1mb" });
  const formParser = bodyParser.urlencoded({ extended: true, limit: "1mb" });

  expressApp.post("/jazzcash/ipn", formParser, async (req, res) => {
    const payload = req.body || {};
    if (!payload.pp_TxnRefNo || !payload.pp_ResponseCode) {
      return res.status(400).json({ success: false, message: "Invalid payment notification" });
    }

    try {
      await context.collections.Transaction.updateOne(
        { transactionId: payload.pp_TxnRefNo },
        {
          $set: {
            statusCode: payload.pp_ResponseCode,
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

  expressApp.post("/webhook/easypaisa", jsonParser, async (req, res) => {
    const statusUrl = req.query?.url || req.body?.url;
    if (!statusUrl) {
      return res.status(400).json({ success: false, message: "Missing status URL" });
    }

    try {
      const result = await processEasyPaisaStatus(
        {
          statusUrl,
          allowedHosts: csvEnvironment("EASYPAISA_STATUS_ALLOWED_HOSTS", [
            "easypay.easypaisa.com.pk",
          ]),
          OrdersDb: context.collections.Orders,
          TransactionDb: context.collections.Transaction,
        },
        {
          timeoutMs: Number(process.env.EASYPAISA_TIMEOUT_MS || 15000),
        }
      );

      void forwardStatusUrl(process.env.FINNECT_EASYPAISA_WEBHOOK_URL, statusUrl);
      void forwardStatusUrl(process.env.RANCHERS_EASYPAISA_MONITOR_URL, statusUrl);

      return res.status(200).json({
        success: true,
        orderId: result.orderId,
        paymentStatus: result.status,
        isPaid: result.isPaid,
        idempotent: result.idempotent,
      });
    } catch (error) {
      console.error("EasyPaisa status processing failed:", error.message);
      return res.status(httpStatusForError(error)).json({
        success: false,
        message: error.message || "Unable to verify payment status",
      });
    }
  });
}

export { csvEnvironment, httpStatusForError };
