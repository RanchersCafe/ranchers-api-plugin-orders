import assert from "assert/strict";
import { readFile } from "fs/promises";

const [placeOrderSource, fulfillmentGroupSource] = await Promise.all([
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
]);

assert.doesNotMatch(
  placeOrderSource,
  /const\s+GUEST_TOKEN\s*=|4fca69b380be5f9898f435e548654c063f757562ca32fb9e5d09bb5d38d3295b/,
  "Guest checkout credentials must not be committed in source",
);
assert.match(
  placeOrderSource,
  /process\.env\.GUEST_CHECKOUT_TOKEN/,
  "Guest checkout must use protected runtime configuration",
);
assert.match(
  placeOrderSource,
  /!configuredGuestToken\s*\|\|\s*!guestToken\s*\|\|\s*guestToken\s*!==\s*configuredGuestToken/,
  "Guest checkout must fail closed when configuration or the supplied token is missing",
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

console.log("PASS place-order source security regression tests");
