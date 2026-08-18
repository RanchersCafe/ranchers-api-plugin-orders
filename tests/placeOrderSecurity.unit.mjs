import assertModule from "assert";
import { readFile } from "fs/promises";

const assert = assertModule.strict;
const [
  placeOrderSource,
  fulfillmentGroupSource,
  orderGraphqlSchema,
  simpleSchemasSource,
] = await Promise.all([
  readFile(
    new URL("../src/mutations/placeOrder.js", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL(
      "../src/util/buildOrderFulfillmentGroupFromInput.js",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL("../src/schemas/schema.graphql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/simpleSchemas.js", import.meta.url),
    "utf8",
  ),
]);

assert.doesNotMatch(
  placeOrderSource,
  /const\s+GUEST_TOKEN\s*=|4fca69b380be5f9898f435e548654c063f757562ca32fb9e5d09bb5d38d3295b/,
  "Guest checkout credentials must not be committed in source",
);
assert.doesNotMatch(
  placeOrderSource,
  /process\.env\.GUEST_CHECKOUT_TOKEN|configuredGuestToken/,
  "Guest checkout must not depend on a shared browser-visible token",
);
assert.match(
  placeOrderSource,
  /hashToken/,
  "Guest checkout must hash the cart-specific anonymous token",
);
assert.doesNotMatch(
  placeOrderSource,
  /getHashedAnonymousAccessToken/,
  "Guest checkout must not call the nonexistent getHashedAnonymousAccessToken helper",
);
assert.match(
  placeOrderSource,
  /cart\.anonymousAccessToken\s*!==\s*hashedCartToken/,
  "Guest checkout must compare the submitted token hash with the cart hash string",
);
assert.match(
  placeOrderSource,
  /The authenticated account does not own this cart/,
  "Authenticated checkout must enforce cart ownership",
);


assert.match(
  orderGraphqlSchema,
  /input OrderInput\s*\{[\s\S]*?\bcustomFields:\s*JSONObject\b/,
  "GraphQL OrderInput must accept customFields as JSONObject",
);
assert.match(
  simpleSchemasSource,
  /export const orderInputSchema = new SimpleSchema\(\{[\s\S]*?customFields:\s*\{[\s\S]*?blackbox:\s*true/,
  "Order input SimpleSchema must continue accepting blackbox customFields",
);
assert.match(
  placeOrderSource,
  /summarizeFulfillmentGroups\(\s*finalFulfillmentGroups/s,
  "Payment pricing must be summarized from server-built fulfillment groups",
);
assert.match(
  placeOrderSource,
  /allocateServerPaymentSnapshots/,
  "Payment authorization must use server-allocated payment snapshots",
);
assert.match(
  placeOrderSource,
  /pricingSnapshot:\s*paymentPricingSnapshot/,
  "Server pricing snapshot must be passed into payment authorization",
);
assert.match(
  placeOrderSource,
  /merchandiseAfterDiscount\s*<\s*500/,
  "Minimum order value must use the server-calculated merchandise amount",
);
assert.doesNotMatch(
  placeOrderSource,
  /payments\[0\]\.finalAmount\s*-\s*discountTotal/,
  "EasyPaisa amount must not subtract an already-applied discount twice",
);
assert.doesNotMatch(
  placeOrderSource,
  /isPaid:\s*\{\s*\$cond:\s*\[\{\s*\$eq:\s*\["\$paymentMethod",\s*"EASYPAISA"\]/,
  "New EasyPaisa orders must not be published as paid before provider verification",
);
assert.match(
  placeOrderSource,
  /fulfillmentGroups:\s*finalFulfillmentGroups/,
  "Order-created events must contain server-built fulfillment groups",
);

for (const pattern of [
  /console\.log\(["']ORDER RECORD/,
  /console\.log\(["']TRANSACTION RECORD/,
  /console\.log\(["']easyPaisaResponse/,
]) {
  assert.doesNotMatch(
    placeOrderSource,
    pattern,
    `Sensitive place-order logging remains: ${pattern}`,
  );
}

assert.doesNotMatch(
  fulfillmentGroupSource,
  /console\.log\(/,
  "Fulfillment-group construction must not log customer, cart, address, item, or pricing data",
);

console.log("PASS place-order ownership, security and pricing regression tests");
