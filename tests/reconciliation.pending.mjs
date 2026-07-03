import assert from "assert/strict";
import { reconcilePendingPayments } from "../src/payments/reconcilePendingPayments.js";
import { PAYMENT_STATUS } from "../src/util/paymentStatus.js";
import { InMemoryCollection } from "./support/inMemoryCollection.mjs";

export async function runPendingReconciliationTest() {
  const OrdersDb = new InMemoryCollection([
    {
      _id: "order-pending",
      isPaid: false,
      paymentStatus: PAYMENT_STATUS.PENDING_VERIFICATION,
      shipping: [{ invoice: { total: 750 } }],
      payments: [{ finalAmount: 750 }],
    },
  ]);
  const TransactionDb = new InMemoryCollection([
    {
      _id: "attempt-pending",
      orderId: "order-pending",
      provider: "EASYPAISA",
      amount: 750,
      status: PAYMENT_STATUS.PENDING_VERIFICATION,
      reconciliationCount: 0,
      createdAt: new Date("2026-07-03T09:00:00.000Z"),
      nextReconciliationAt: new Date("2026-07-03T09:05:00.000Z"),
    },
  ]);

  const summary = await reconcilePendingPayments({
    OrdersDb,
    TransactionDb,
    clock: { now: () => new Date("2026-07-03T09:10:00.000Z") },
    fetchStatus: async () => ({
      transaction_status: "PENDING",
      response_code: "0000",
      transaction_id: "provider-pending",
      transaction_amount: "750.00",
    }),
  });

  assert.equal(summary.unresolved, 1);
  const attempt = await TransactionDb.findOne({ _id: "attempt-pending" });
  assert.equal(attempt.status, PAYMENT_STATUS.PENDING_VERIFICATION);
  assert.equal(attempt.reconciliationCount, 1);
  assert.equal(attempt.nextReconciliationAt.toISOString(), "2026-07-03T09:15:00.000Z");
}
