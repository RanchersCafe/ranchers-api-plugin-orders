import assert from "assert/strict";
import { processEasyPaisaStatus } from "../src/payments/processEasyPaisaStatus.js";
import { PAYMENT_STATUS } from "../src/util/paymentStatus.js";
import { InMemoryCollection } from "./support/inMemoryCollection.mjs";

function createFixtures({ paid = false, attemptStatus = PAYMENT_STATUS.PENDING_VERIFICATION } = {}) {
  return {
    OrdersDb: new InMemoryCollection([
      {
        _id: "order-status",
        branchID: "branch-1",
        isPaid: paid,
        paymentStatus: paid ? PAYMENT_STATUS.VERIFIED_PAID : attemptStatus,
        paymentInitiatedAt: new Date("2026-07-03T09:00:00.000Z"),
        shipping: [{ invoice: { total: 900 } }],
        payments: [{ finalAmount: 900 }],
      },
    ]),
    TransactionDb: new InMemoryCollection([
      {
        _id: "attempt-status",
        orderId: "order-status",
        provider: "EASYPAISA",
        amount: 900,
        status: paid ? PAYMENT_STATUS.VERIFIED_PAID : attemptStatus,
        transactionId: paid ? "provider-existing" : null,
      },
    ]),
  };
}

function providerClient(overrides = {}) {
  return {
    async get() {
      return {
        status: 200,
        data: {
          optional1: "opaque-order-status",
          optional2: "attempt-status",
          order_id: "K-2001",
          transaction_status: "PAID",
          response_code: "0000",
          transaction_id: "provider-status-1",
          transaction_amount: "900.00",
          paid_datetime: "2026-07-03T14:01:00+05:00",
          ...overrides,
        },
      };
    },
  };
}

const baseInput = {
  statusUrl: "https://easypay.easypaisa.com.pk/status/abc",
  allowedHosts: ["easypay.easypaisa.com.pk"],
};

export async function runEasyPaisaStatusIntegrationTests() {
  {
    const { OrdersDb, TransactionDb } = createFixtures();
    const events = [];
    const result = await processEasyPaisaStatus(
      { ...baseInput, OrdersDb, TransactionDb },
      {
        httpClient: providerClient(),
        decodeOrderId: () => ({ id: "order-status" }),
        clock: { now: () => new Date("2026-07-03T09:01:00.000Z") },
        publishStatus: (event) => events.push(event),
      }
    );

    assert.equal(result.status, PAYMENT_STATUS.VERIFIED_PAID);
    assert.equal(result.isPaid, true);
    assert.equal(result.idempotent, false);
    const order = await OrdersDb.findOne({ _id: "order-status" });
    assert.equal(order.isPaid, true);
    assert.equal(order.paymentStatus, PAYMENT_STATUS.VERIFIED_PAID);
    assert.equal(order.transactionId, "provider-status-1");
    const attempt = await TransactionDb.findOne({ _id: "attempt-status" });
    assert.equal(attempt.status, PAYMENT_STATUS.VERIFIED_PAID);
    assert.equal(attempt.verifiedAmount, 900);
    assert.equal(attempt.amountMatches, true);
    assert.equal(events.length, 1);
  }

  {
    const { OrdersDb, TransactionDb } = createFixtures();
    const result = await processEasyPaisaStatus(
      { ...baseInput, OrdersDb, TransactionDb },
      {
        httpClient: providerClient({ transaction_amount: "850.00" }),
        decodeOrderId: () => ({ id: "order-status" }),
        clock: { now: () => new Date("2026-07-03T09:02:00.000Z") },
      }
    );

    assert.equal(result.status, PAYMENT_STATUS.AMOUNT_MISMATCH);
    assert.equal(result.isPaid, false);
    const order = await OrdersDb.findOne({ _id: "order-status" });
    assert.equal(order.isPaid, false);
    assert.equal(order.paymentStatus, PAYMENT_STATUS.AMOUNT_MISMATCH);
  }

  {
    const { OrdersDb, TransactionDb } = createFixtures({ paid: true });
    const result = await processEasyPaisaStatus(
      { ...baseInput, OrdersDb, TransactionDb },
      {
        httpClient: providerClient(),
        decodeOrderId: () => ({ id: "order-status" }),
      }
    );
    assert.equal(result.idempotent, true);
    assert.equal(result.isPaid, true);
  }

  {
    const { OrdersDb, TransactionDb } = createFixtures();
    await assert.rejects(
      () =>
        processEasyPaisaStatus(
          {
            ...baseInput,
            statusUrl: "https://example.com/status/abc",
            OrdersDb,
            TransactionDb,
          },
          { httpClient: providerClient() }
        ),
      /not allowed/
    );
  }
}
