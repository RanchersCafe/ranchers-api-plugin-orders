import assert from "assert/strict";
import {
  allocateServerPaymentSnapshots,
  summarizeFulfillmentGroups,
  verifyPaymentPreview,
} from "../src/payments/serverPaymentSnapshot.js";

const summary = summarizeFulfillmentGroups([
  {
    invoice: {
      subtotal: 1000,
      taxes: 150,
      shipping: 59,
      discounts: 100,
      surcharges: 0,
      total: 1109,
    },
  },
]);

assert.deepEqual(summary, {
  subtotal: 1000,
  tax: 150,
  shipping: 59,
  discounts: 100,
  surcharges: 0,
  finalAmount: 1109,
  merchandiseAfterDiscount: 900,
  amount: 1050,
});

assert.deepEqual(verifyPaymentPreview([{ finalAmount: 1109 }], 1109), [1109]);
assert.throws(
  () => verifyPaymentPreview([{ finalAmount: 1000 }], 1109),
  /does not match server order total/,
);
assert.throws(
  () => verifyPaymentPreview([], 1109),
  /At least one payment is required/,
);

const single = allocateServerPaymentSnapshots(
  [
    {
      method: "iou_example",
      amount: 1050,
      finalAmount: 1109,
      totalAmount: 1000,
      tax: 150,
    },
  ],
  summary,
);
assert.equal(single.length, 1);
assert.equal(single[0].amount, 1050);
assert.equal(single[0].tax, 150);
assert.equal(single[0].totalAmount, 1000);
assert.equal(single[0].finalAmount, 1109);

const split = allocateServerPaymentSnapshots(
  [
    { method: "one", finalAmount: 554.5 },
    { method: "two", finalAmount: 554.5 },
  ],
  summary,
);
assert.equal(split[0].finalAmount + split[1].finalAmount, 1109);
assert.equal(split[0].tax + split[1].tax, 150);
assert.equal(split[0].totalAmount + split[1].totalAmount, 1000);
assert.equal(split[0].amount + split[1].amount, 1050);

assert.throws(
  () => summarizeFulfillmentGroups([{ invoice: { subtotal: -1 } }]),
  /must not be negative/,
);
assert.throws(
  () => summarizeFulfillmentGroups([{}]),
  /missing its server invoice/,
);

console.log("PASS server-authoritative payment snapshot tests");
