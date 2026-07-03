import assert from "assert/strict";
import { reconcilePendingPayments } from "../src/payments/reconcilePendingPayments.js";
import { PAYMENT_STATUS } from "../src/util/paymentStatus.js";
import { InMemoryCollection } from "./support/inMemoryCollection.mjs";

function fixtures(status = PAYMENT_STATUS.PENDING_VERIFICATION) {
  return {
    OrdersDb: new InMemoryCollection([
      {
        _id: "order-1",
        branchID: "branch-1",
        isPaid: false,
        paymentStatus: status,
        paymentInitiatedAt: new Date("2026-07-03T09:00:00.000Z"),
        shipping: [{ invoice: { total: 1250.75 } }],
        payments: [{ finalAmount: 1250.75 }],
      },
    ]),
    TransactionDb: new InMemoryCollection([
      {
        _id: "attempt-1",
        orderId: "order-1",
        provider: "EASYPAISA",
        amount: 1250.75,
        status,
        reconciliationCount: 0,
        createdAt: new Date("2026-07-03T09:00:00.000Z"),
        nextReconciliationAt: new Date("2026-07-03T09:05:00.000Z"),
      },
    ]),
  };
}

export async function runReconciliationIntegrationTests() {
  {
    const { OrdersDb, TransactionDb } = fixtures();
    const events = [];
    const summary = await reconcilePendingPayments({
      OrdersDb,
      TransactionDb,
      clock: { now: () => new Date("2026-07-03T09:10:00.000Z") },
      publishStatus: (event) => events.push(event),
      fetchStatus: async () => ({
        transaction_status: "PAID",
        response_code: "0000",
        transaction_id: "provider-1001",
        transaction_amount: "1250.75",
        paid_datetime: "2026-07-03T14:09:00+05:00",
      }),
    });

    assert.deepEqual(summary, {
      scanned: 1,
      verifiedPaid: 1,
      unresolved: 0,
      failed: 0,
      missingOrders: 0,
    });
    const order = await OrdersDb.findOne({ _id: "order-1" });
    assert.equal(order.isPaid, true);
    assert.equal(order.paymentStatus, PAYMENT_STATUS.VERIFIED_PAID);
    assert.equal(order.transactionId, "provider-1001");
    const attempt = await TransactionDb.findOne({ _id: "attempt-1" });
    assert.equal(attempt.status, PAYMENT_STATUS.VERIFIED_PAID);
    assert.equal(attempt.amountMatches, true);
    assert.equal(attempt.reconciliationCount, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].isPaid, true);
  }

  {
    const { OrdersDb, TransactionDb } = fixtures();
    const summary = await reconcilePendingPayments({
      OrdersDb,
      TransactionDb,
      clock: { now: () => new Date("2026-07-03T09:10:00.000Z") },
      fetchStatus: async () => ({
        transaction_status: "PAID",
        response_code: "0000",
        transaction_id: "provider-1002",
        transaction_amount: "1200.00",
      }),
    });

    assert.equal(summary.unresolved, 1);
    const order = await OrdersDb.findOne({ _id: "order-1" });
    assert.equal(order.isPaid, false);
    assert.equal(order.paymentStatus, PAYMENT_STATUS.AMOUNT_MISMATCH);
    const attempt = await TransactionDb.findOne({ _id: "attempt-1" });
    assert.equal(attempt.status, PAYMENT_STATUS.AMOUNT_MISMATCH);
    assert.equal(attempt.amountMatches, false);
  }

  {
    const { OrdersDb, TransactionDb } = fixtures(PAYMENT_STATUS.PENDING_REVIEW);
    const summary = await reconcilePendingPayments({
      OrdersDb,
      TransactionDb,
      clock: { now: () => new Date("2026-07-03T09:10:00.000Z") },
      fetchStatus: async () => {
        const error = new Error("provider unavailable");
        error.code = "ETIMEDOUT";
        throw error;
      },
    });

    assert.equal(summary.failed, 1);
    const attempt = await TransactionDb.findOne({ _id: "attempt-1" });
    assert.equal(attempt.status, PAYMENT_STATUS.PENDING_REVIEW);
    assert.equal(attempt.reconciliationCount, 1);
    assert.equal(
      attempt.nextReconciliationAt.toISOString(),
      "2026-07-03T09:15:00.000Z"
    );
  }
}
