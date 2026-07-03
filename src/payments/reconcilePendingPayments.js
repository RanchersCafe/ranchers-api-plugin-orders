import { PAYMENT_STATUS } from "../util/paymentStatus.js";
import { evaluateStatusResponse } from "./easypaisaProtocol.js";
import { getOrderInvoiceTotal } from "./paymentMath.js";

const RECONCILABLE_STATUSES = [
  PAYMENT_STATUS.PENDING_VERIFICATION,
  PAYMENT_STATUS.PENDING_REVIEW,
];

function nextRetryAt(now, attemptCount) {
  const delays = [5, 15, 30, 120, 24 * 60];
  const minutes = delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
  return new Date(now.getTime() + minutes * 60 * 1000);
}

async function persistOutcome({
  TransactionDb,
  OrdersDb,
  attempt,
  order,
  outcome,
  now,
}) {
  await TransactionDb.updateOne(
    { _id: attempt._id, status: { $in: RECONCILABLE_STATUSES } },
    {
      $set: {
        status: outcome.status,
        providerStatus: outcome.providerStatus,
        responseCode: outcome.responseCode,
        responseMessage: outcome.description,
        transactionId: outcome.providerTransactionId,
        verifiedAmount: outcome.paidAmount,
        amountMatches: outcome.amountMatches,
        transactionDateTime: outcome.paidAt,
        lastVerifiedAt: now,
        updatedAt: now,
        nextReconciliationAt: outcome.isPaid ? null : attempt.nextReconciliationAt,
      },
      $inc: { reconciliationCount: 1 },
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
      ? { _id: order._id }
      : { _id: order._id, isPaid: { $ne: true } },
    { $set: orderUpdate }
  );
}

export async function reconcilePendingPayments({
  TransactionDb,
  OrdersDb,
  fetchStatus,
  publishStatus = () => {},
  clock = { now: () => new Date() },
  limit = 100,
}) {
  if (!TransactionDb || !OrdersDb) {
    throw new TypeError("TransactionDb and OrdersDb are required");
  }
  if (typeof fetchStatus !== "function") {
    throw new TypeError("fetchStatus must be provided");
  }

  const startedAt = clock.now();
  const cursor = TransactionDb.find({
    provider: "EASYPAISA",
    status: { $in: RECONCILABLE_STATUSES },
    $or: [
      { nextReconciliationAt: { $exists: false } },
      { nextReconciliationAt: null },
      { nextReconciliationAt: { $lte: startedAt } },
    ],
  });

  const attempts = await cursor.sort({ createdAt: 1 }).limit(limit).toArray();
  const summary = {
    scanned: attempts.length,
    verifiedPaid: 0,
    unresolved: 0,
    failed: 0,
    missingOrders: 0,
  };

  for (const attempt of attempts) {
    const order = await OrdersDb.findOne({ _id: attempt.orderId });
    if (!order) {
      summary.missingOrders += 1;
      await TransactionDb.updateOne(
        { _id: attempt._id },
        {
          $set: {
            status: PAYMENT_STATUS.PENDING_REVIEW,
            failureReason: "Order not found during reconciliation",
            nextReconciliationAt: nextRetryAt(startedAt, (attempt.reconciliationCount || 0) + 1),
            updatedAt: startedAt,
          },
          $inc: { reconciliationCount: 1 },
        }
      );
      continue;
    }

    try {
      const providerData = await fetchStatus({ attempt, order });
      const expectedAmount = attempt.amount || getOrderInvoiceTotal(order);
      const outcome = evaluateStatusResponse(providerData, expectedAmount);
      const finishedAt = clock.now();

      await persistOutcome({
        TransactionDb,
        OrdersDb,
        attempt,
        order,
        outcome,
        now: finishedAt,
      });

      publishStatus({
        branchId: order.branchID,
        orderId: order._id,
        status: outcome.status,
        isPaid: outcome.isPaid,
        initiatedAt: order.paymentInitiatedAt,
      });

      if (outcome.isPaid) summary.verifiedPaid += 1;
      else summary.unresolved += 1;
    } catch (error) {
      summary.failed += 1;
      const failedAt = clock.now();
      const reconciliationCount = (attempt.reconciliationCount || 0) + 1;
      await TransactionDb.updateOne(
        { _id: attempt._id, status: { $in: RECONCILABLE_STATUSES } },
        {
          $set: {
            status: PAYMENT_STATUS.PENDING_REVIEW,
            failureCode: error?.code || null,
            failureReason: "Provider status inquiry failed",
            lastReconciliationErrorAt: failedAt,
            nextReconciliationAt: nextRetryAt(failedAt, reconciliationCount),
            updatedAt: failedAt,
          },
          $inc: { reconciliationCount: 1 },
        }
      );
    }
  }

  return summary;
}

export { RECONCILABLE_STATUSES, nextRetryAt };
