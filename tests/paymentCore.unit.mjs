import assert from "assert/strict";
import {
  amountsMatch,
  buildIdempotencyKey,
  getOrderInvoiceTotal,
  roundMoney,
} from "../src/payments/paymentMath.js";
import {
  evaluateInitiationResponse,
  evaluateStatusResponse,
  isUncertainProviderError,
  validateAuthHeaderName,
  validateStatusUrl,
} from "../src/payments/easypaisaProtocol.js";
import {
  PAYMENT_STATUS,
  assertPaymentStatusTransition,
  canTransitionPaymentStatus,
  isPaidStatus,
  isTerminalStatus,
} from "../src/util/paymentStatus.js";

export async function runPaymentCoreUnitTests() {
  assert.equal(roundMoney("10.125"), 10.13);
  assert.equal(roundMoney("invalid"), null);
  assert.equal(amountsMatch(100, "100.00"), true);
  assert.equal(amountsMatch(100, 100.02), false);

  assert.equal(
    getOrderInvoiceTotal({
      shipping: [
        { invoice: { total: 500.25 } },
        { invoice: { total: 700.5 } },
      ],
      payments: [{ finalAmount: 9999 }],
    }),
    1200.75
  );
  assert.equal(
    getOrderInvoiceTotal({ payments: [{ finalAmount: 450.5 }] }),
    450.5
  );
  assert.equal(getOrderInvoiceTotal({ shipping: [] }), null);

  assert.equal(
    buildIdempotencyKey("EasyPaisa", "order-1", "attempt-1"),
    "easypaisa:order-1:attempt-1"
  );
  assert.throws(() => buildIdempotencyKey("EasyPaisa", "", "attempt-1"));

  const accepted = evaluateInitiationResponse(200, {
    responseCode: "0000",
    responseDesc: "SUCCESS",
    transactionId: "provider-1",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, PAYMENT_STATUS.PENDING_VERIFICATION);
  assert.equal(accepted.isPaid, false);

  const rejected = evaluateInitiationResponse(400, {
    responseCode: "1001",
    responseDesc: "DECLINED",
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.status, PAYMENT_STATUS.FAILED);

  const paid = evaluateStatusResponse(
    {
      transaction_status: "PAID",
      response_code: "0000",
      transaction_id: "provider-1",
      transaction_amount: "1200.75",
    },
    1200.75
  );
  assert.equal(paid.status, PAYMENT_STATUS.VERIFIED_PAID);
  assert.equal(paid.isPaid, true);
  assert.equal(paid.amountMatches, true);

  const mismatch = evaluateStatusResponse(
    {
      transaction_status: "PAID",
      response_code: "0000",
      transaction_id: "provider-2",
      transaction_amount: "1100.00",
    },
    1200.75
  );
  assert.equal(mismatch.status, PAYMENT_STATUS.AMOUNT_MISMATCH);
  assert.equal(mismatch.isPaid, false);

  const failed = evaluateStatusResponse(
    { transaction_status: "FAILED", response_code: "1001" },
    1200.75
  );
  assert.equal(failed.status, PAYMENT_STATUS.FAILED);

  assert.equal(isUncertainProviderError({ code: "ETIMEDOUT" }), true);
  assert.equal(isUncertainProviderError({ response: { status: 400 } }), false);
  assert.equal(validateAuthHeaderName("Credentials"), "Credentials");
  assert.throws(() => validateAuthHeaderName("Bad Header"));
  assert.equal(
    validateStatusUrl(
      "https://easypay.easypaisa.com.pk/status/123",
      ["easypay.easypaisa.com.pk"]
    ).hostname,
    "easypay.easypaisa.com.pk"
  );
  assert.throws(() =>
    validateStatusUrl("http://easypay.easypaisa.com.pk/status/123", [
      "easypay.easypaisa.com.pk",
    ])
  );
  assert.throws(() =>
    validateStatusUrl("https://example.com/status/123", [
      "easypay.easypaisa.com.pk",
    ])
  );

  assert.equal(isPaidStatus(PAYMENT_STATUS.VERIFIED_PAID), true);
  assert.equal(isTerminalStatus(PAYMENT_STATUS.AMOUNT_MISMATCH), true);
  assert.equal(
    canTransitionPaymentStatus(
      PAYMENT_STATUS.PENDING,
      PAYMENT_STATUS.VERIFIED_PAID
    ),
    true
  );
  assert.equal(
    canTransitionPaymentStatus(PAYMENT_STATUS.FAILED, PAYMENT_STATUS.PENDING),
    false
  );
  assert.throws(() =>
    assertPaymentStatusTransition(
      PAYMENT_STATUS.VERIFIED_PAID,
      PAYMENT_STATUS.PENDING
    )
  );
}
