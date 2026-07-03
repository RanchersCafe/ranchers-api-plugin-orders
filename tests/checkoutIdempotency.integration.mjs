import assert from "assert/strict";
import {
  acquireCheckoutRequest,
  buildCheckoutKey,
  completeCheckoutRequest,
  failCheckoutRequest,
  normalizeClientMutationId,
} from "../src/orders/checkoutIdempotency.js";
import { InMemoryCollection } from "./support/inMemoryCollection.mjs";

export async function runCheckoutIdempotencyIntegrationTests() {
  const collection = new InMemoryCollection();
  const context = { userId: "user-1" };
  const input = { order: { shopId: "shop-1" } };
  const clientMutationId = normalizeClientMutationId("checkout-test-1");
  const checkoutKey = buildCheckoutKey(context, input, clientMutationId);
  const now = new Date("2026-07-03T10:00:00.000Z");

  const first = await acquireCheckoutRequest({
    CheckoutRequest: collection,
    checkoutKey,
    clientMutationId,
    context,
    now,
    lockToken: "lock-1",
  });
  assert.equal(first.acquired, true);

  const concurrent = await acquireCheckoutRequest({
    CheckoutRequest: collection,
    checkoutKey,
    clientMutationId,
    context,
    now: new Date("2026-07-03T10:00:10.000Z"),
    lockToken: "lock-2",
  });
  assert.equal(concurrent.acquired, false);
  assert.equal(concurrent.completed, false);

  await completeCheckoutRequest(
    collection,
    checkoutKey,
    "lock-1",
    ["order-1"],
    new Date("2026-07-03T10:00:20.000Z")
  );
  const replay = await acquireCheckoutRequest({
    CheckoutRequest: collection,
    checkoutKey,
    clientMutationId,
    context,
    now: new Date("2026-07-03T10:00:30.000Z"),
    lockToken: "lock-3",
  });
  assert.equal(replay.acquired, false);
  assert.equal(replay.completed, true);
  assert.deepEqual(replay.record.orderIds, ["order-1"]);

  const failedCollection = new InMemoryCollection();
  const failedKey = buildCheckoutKey(
    context,
    input,
    normalizeClientMutationId("checkout-test-2")
  );
  await acquireCheckoutRequest({
    CheckoutRequest: failedCollection,
    checkoutKey: failedKey,
    clientMutationId: "checkout-test-2",
    context,
    now,
    lockToken: "lock-failed",
  });
  await failCheckoutRequest(
    failedCollection,
    failedKey,
    "lock-failed",
    { code: "CHECKOUT_FAILED" },
    new Date("2026-07-03T10:01:00.000Z")
  );
  const failed = await failedCollection.findOne({ checkoutKey: failedKey });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.failureCode, "CHECKOUT_FAILED");

  assert.throws(() => normalizeClientMutationId("bad key with spaces"));
}
