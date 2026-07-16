import assert from "assert/strict";
import { readFile } from "fs/promises";

const source = await readFile(
  new URL("../src/mutations/placeOrder.js", import.meta.url),
  "utf8",
);

assert.doesNotMatch(
  source,
  /const\s+GUEST_TOKEN\s*=|4fca69b380be5f9898f435e548654c063f757562ca32fb9e5d09bb5d38d3295b/,
  "Guest checkout credentials must not be committed in source",
);
assert.match(
  source,
  /process\.env\.GUEST_CHECKOUT_TOKEN/,
  "Guest checkout must use protected runtime configuration",
);
assert.match(
  source,
  /!configuredGuestToken\s*\|\|\s*!guestToken\s*\|\|\s*guestToken\s*!==\s*configuredGuestToken/,
  "Guest checkout must fail closed when configuration or the supplied token is missing",
);

for (const pattern of [
  /console\.log\(["']ORDER RECORD/,
  /console\.log\(["']TRANSACTION RECORD/,
  /console\.log\(["']easyPaisaResponse/,
]) {
  assert.doesNotMatch(source, pattern, `Sensitive logging pattern remains: ${pattern}`);
}

console.log("PASS place-order source security regression tests");
