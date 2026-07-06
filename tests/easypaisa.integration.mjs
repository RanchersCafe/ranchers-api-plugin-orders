import assert from "assert/strict";
import { initiateEasyPaisaPayment } from "../src/util/easyPaisaPayment.js";
import { PAYMENT_STATUS } from "../src/util/paymentStatus.js";
import { InMemoryCollection } from "./support/inMemoryCollection.mjs";
import { runPaymentCoreUnitTests } from "./paymentCore.unit.mjs";
import { runEasyPaisaStatusIntegrationTests } from "./easypaisaStatus.integration.mjs";
import { runCheckoutIdempotencyIntegrationTests } from "./checkoutIdempotency.integration.mjs";
import { runReconciliationIntegrationTests } from "./reconciliation.integration.mjs";
import { runPendingReconciliationTest } from "./reconciliation.pending.mjs";

function fixedClock(...times) {
  let index = 0;
  return {
    now() {
      const value = times[Math.min(index, times.length - 1)];
      index += 1;
      return new Date(value);
    },
  };
}

function baseFixtures(transactionOverrides = {}) {
  return {
    OrdersDb: new InMemoryCollection([
      {
        _id: "order-1",
        branchID: "branch-1",
        isPaid: false,
        paymentStatus: PAYMENT_STATUS.CREATED,
        payments: [{ finalAmount: 999 }],
        shipping: [
          { invoice: { total: 1000.25 } },
          { invoice: { total: 250.5 } },
        ],
      },
    ]),
    TransactionDb: new InMemoryCollection([
      {
        _id: "attempt-1",
        orderId: "order-1",
        status: PAYMENT_STATUS.CREATED,
        createdAt: new Date("2026-07-03T10:00:00.000Z"),
        ...transactionOverrides,
      },
    ]),
  };
}

const params = {
  kitchenOrderId: "K-1001",
  externalOrderId: "order-1",
  storeId: null,
  submittedAmount: 999,
  transactionType: "MA",
  mobileAccountNo: "03001234567",
  emailAddress: "customer@example.com",
  paymentAttemptId: "attempt-1",
};

const config = {
  authHeader: "Credentials",
  authValue: "test-auth-value",
  storeId: "test-store",
  baseUrl: "https://provider.test/rest/v4",
  timeoutMs: 5000,
  lockTtlMs: 30000,
  reconciliationDelayMs: 300000,
};

async function testAcceptedInitiation() {
  const { OrdersDb, TransactionDb } = baseFixtures();
  const requests = [];
  const events = [];
  const result = await initiateEasyPaisaPayment(
    { ...params, OrdersDb, TransactionDb },
    {
      config,
      clock: fixedClock("2026-07-03T10:01:00.000Z", "2026-07-03T10:01:01.000Z"),
      createLockToken: () => "lock-1",
      publishStatus: (event) => events.push(event),
      httpClient: {
        async post(url, body, options) {
          requests.push({ url, body, options });
          return {
            status: 200,
            data: {
              responseCode: "0000",
              responseDesc: "SUCCESS",
              transactionId: "provider-1001",
              transactionDateTime: "2026-07-03T15:01:01+05:00",
            },
          };
        },
      },
    }
  );

  assert.equal(result.status, PAYMENT_STATUS.PENDING_VERIFICATION);
  assert.equal(result.isPaid, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.transactionAmount, 1250.75);
  assert.equal(requests[0].options.headers["X-Idempotency-Key"], "easypaisa:order-1:attempt-1");

  const order = await OrdersDb.findOne({ _id: "order-1" });
  assert.equal(order.authoritativePaymentAmount, 1250.75);
  assert.equal(order.payments[0].finalAmount, 1250.75);
  assert.equal(order.paymentStatus, PAYMENT_STATUS.PENDING_VERIFICATION);
  assert.equal(order.isPaid, false);
  assert.equal(order.transactionId, "provider-1001");

  const attempt = await TransactionDb.findOne({ orderId: "order-1" });
  assert.equal(attempt.amount, 1250.75);
  assert.equal(attempt.submittedAmount, 999);
  assert.equal(attempt.submittedAmountMismatch, true);
  assert.equal(attempt.status, PAYMENT_STATUS.PENDING_VERIFICATION);
  assert.equal(attempt.attemptCount, 1);
  assert.equal(attempt.processingLockToken, undefined);
  assert.equal(events.map((event) => event.status).join(","), "PENDING,PENDING_VERIFICATION");
}

async function testTimeoutInitiation() {
  const { OrdersDb, TransactionDb } = baseFixtures();
  const result = await initiateEasyPaisaPayment(
    { ...params, OrdersDb, TransactionDb },
    {
      config,
      clock: fixedClock("2026-07-03T10:02:00.000Z", "2026-07-03T10:02:10.000Z"),
      createLockToken: () => "lock-timeout",
      publishStatus: () => {},
      httpClient: {
        async post() {
          const error = new Error("timeout");
          error.code = "ETIMEDOUT";
          throw error;
        },
      },
    }
  );

  assert.equal(result.status, PAYMENT_STATUS.PENDING_REVIEW);
  assert.equal(result.pendingVerification, true);
  const order = await OrdersDb.findOne({ _id: "order-1" });
  assert.equal(order.paymentStatus, PAYMENT_STATUS.PENDING_REVIEW);
  const attempt = await TransactionDb.findOne({ orderId: "order-1" });
  assert.equal(attempt.status, PAYMENT_STATUS.PENDING_REVIEW);
  assert.equal(attempt.nextReconciliationAt.toISOString(), "2026-07-03T10:07:10.000Z");
}

async function testPaidIdempotency() {
  const { OrdersDb, TransactionDb } = baseFixtures({
    status: PAYMENT_STATUS.VERIFIED_PAID,
    transactionId: "provider-paid",
  });
  let providerCalls = 0;
  const result = await initiateEasyPaisaPayment(
    { ...params, OrdersDb, TransactionDb },
    {
      config,
      publishStatus: () => {},
      httpClient: {
        async post() {
          providerCalls += 1;
          throw new Error("must not be called");
        },
      },
    }
  );

  assert.equal(result.idempotent, true);
  assert.equal(result.isPaid, true);
  assert.equal(providerCalls, 0);
}

async function testConcurrentAttemptLock() {
  const { OrdersDb, TransactionDb } = baseFixtures({
    status: PAYMENT_STATUS.PENDING,
    processingLockToken: "other-worker",
    processingLockExpiresAt: new Date("2026-07-03T10:10:00.000Z"),
  });
  let providerCalls = 0;
  const result = await initiateEasyPaisaPayment(
    { ...params, OrdersDb, TransactionDb },
    {
      config,
      clock: fixedClock("2026-07-03T10:05:00.000Z"),
      publishStatus: () => {},
      httpClient: {
        async post() {
          providerCalls += 1;
        },
      },
    }
  );

  assert.equal(result.idempotent, true);
  assert.equal(result.inProgress, true);
  assert.equal(providerCalls, 0);
}

async function testDeclinedInitiation() {
  const { OrdersDb, TransactionDb } = baseFixtures();
  await assert.rejects(
    () =>
      initiateEasyPaisaPayment(
        { ...params, OrdersDb, TransactionDb },
        {
          config,
          clock: fixedClock(
            "2026-07-03T10:20:00.000Z",
            "2026-07-03T10:20:01.000Z",
            "2026-07-03T10:20:02.000Z"
          ),
          createLockToken: () => "lock-declined",
          publishStatus: () => {},
          httpClient: {
            async post() {
              return {
                status: 400,
                data: { responseCode: "1001", responseDesc: "DECLINED" },
              };
            },
          },
        }
      ),
    /rejected the payment request/
  );

  const order = await OrdersDb.findOne({ _id: "order-1" });
  assert.equal(order.paymentStatus, PAYMENT_STATUS.FAILED);
  const attempt = await TransactionDb.findOne({ orderId: "order-1" });
  assert.equal(attempt.status, PAYMENT_STATUS.FAILED);
  assert.ok(attempt.nextReconciliationAt == null);
}

export async function runEasyPaisaIntegrationTests() {
  await testAcceptedInitiation();
  await testTimeoutInitiation();
  await testPaidIdempotency();
  await testConcurrentAttemptLock();
  await testDeclinedInitiation();
  await runPaymentCoreUnitTests();
  await runEasyPaisaStatusIntegrationTests();
  await runCheckoutIdempotencyIntegrationTests();
  await runReconciliationIntegrationTests();
  await runPendingReconciliationTest();
}
