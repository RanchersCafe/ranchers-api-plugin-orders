import assertModule from "assert";
import { readFile, writeFile } from "fs/promises";

const assert = assertModule.strict;
const writeMode = process.argv.includes("--write");
const sourcePath = new URL("../src/mutations/placeOrder.js", import.meta.url);
const original = await readFile(sourcePath, "utf8");
let secured = original;

function replaceOnceIfPresent(search, replacement, description) {
  const occurrences = secured.split(search).length - 1;
  assert.ok(
    occurrences <= 1,
    `${description}: expected no more than one occurrence, found ${occurrences}`,
  );
  if (occurrences === 1) secured = secured.replace(search, replacement);
}

replaceOnceIfPresent(
  'import getHashedAnonymousAccessToken from "@reactioncommerce/api-utils/getHashedAnonymousAccessToken.js";\n',
  'import hashToken from "@reactioncommerce/api-utils/hashToken.js";\n',
  "replace unavailable anonymous cart token helper",
);

if (!secured.includes('import hashToken from "@reactioncommerce/api-utils/hashToken.js";')) {
  replaceOnceIfPresent(
    'import getAnonymousAccessToken from "@reactioncommerce/api-utils/getAnonymousAccessToken.js";\n',
    'import getAnonymousAccessToken from "@reactioncommerce/api-utils/getAnonymousAccessToken.js";\nimport hashToken from "@reactioncommerce/api-utils/hashToken.js";\n',
    "add anonymous cart token hashing",
  );
}

replaceOnceIfPresent(
  `    const configuredGuestToken = String(\n      process.env.GUEST_CHECKOUT_TOKEN || ""\n    ).trim();\n    if (\n      isGuestUser &&\n      (!configuredGuestToken || !guestToken || guestToken !== configuredGuestToken)\n    ) {\n      throw new ReactionError(\n        "access-denied",\n        "Guest checkout is not configured or the guest token is invalid"\n      );\n    }\n`,
  "",
  "remove shared guest checkout token validation",
);

replaceOnceIfPresent(
  '        "Guest token required for guest users"\n',
  '        "Anonymous cart token required for guest checkout"\n',
  "clarify guest cart credential error",
);

const protectedCartLookup = `  if (!cartId) {\n    throw new ReactionError("invalid-parameter", "Cart ID is required");\n  }\n\n  const cart = await Cart.findOne({ _id: cartId });\n  if (!cart) {\n    throw new ReactionError("not-found", "Cart not found");\n  }\n\n  if (isGuestUser) {\n    const hashedCartToken = guestToken ? hashToken(guestToken) : null;\n    if (\n      !hashedCartToken ||\n      !cart.anonymousAccessToken ||\n      cart.anonymousAccessToken !== hashedCartToken\n    ) {\n      throw new ReactionError(\n        "access-denied",\n        "Anonymous cart credentials are invalid",\n      );\n    }\n  } else if (String(cart.accountId || "") !== String(accountId || "")) {\n    throw new ReactionError(\n      "access-denied",\n      "The authenticated account does not own this cart",\n    );\n  }\n`;

for (const [legacyCartLookup, description] of [
  [
    `  let cart = null;\n  if (cartId) {\n    cart = await Cart.findOne({ _id: cartId });\n  }\n`,
    "replace simple unprotected cart lookup",
  ],
  [
    `  let cart;\n  if (cartId) {\n    //console.log("cartId ", cartId)\n    cart = await Cart.findOne({ _id: cartId });\n    //console.log("cart ",cart)\n    // await\n    if (!cart) {\n      throw new ReactionError(\n        "not-found",\n        "Cart not found while trying to place order"\n      );\n    }\n  }\n`,
    "replace current unprotected cart lookup",
  ],
]) {
  replaceOnceIfPresent(legacyCartLookup, protectedCartLookup, description);
}

assert.match(secured, /hashToken/);
assert.doesNotMatch(secured, /getHashedAnonymousAccessToken/);
assert.match(
  secured,
  /cart\.anonymousAccessToken\s*!==\s*hashedCartToken/,
);
assert.match(secured, /The authenticated account does not own this cart/);
assert.doesNotMatch(secured, /process\.env\.GUEST_CHECKOUT_TOKEN/);
assert.doesNotMatch(secured, /configuredGuestToken/);
assert.doesNotMatch(
  secured,
  /let cart(?: = null)?;\s*if \(cartId\) \{[\s\S]*Cart\.findOne/,
);

if (writeMode) {
  if (secured !== original) {
    await writeFile(sourcePath, secured);
    console.log("Updated cart ownership controls");
  } else {
    console.log("Cart ownership controls are already enforced");
  }
} else {
  assert.equal(
    original,
    secured,
    "Cart ownership controls are missing; run node scripts/enforceCartOwnershipSource.mjs --write",
  );
  console.log("PASS cart ownership controls");
}
