import assert from "assert/strict";
import { readFile, writeFile } from "fs/promises";

const writeMode = process.argv.includes("--write");
const sourcePath = new URL("../src/mutations/placeOrder.js", import.meta.url);
const original = await readFile(sourcePath, "utf8");
let hardened = original;

function replaceOnceIfPresent(search, replacement, description) {
  const occurrences = hardened.split(search).length - 1;
  assert.ok(
    occurrences <= 1,
    `${description}: expected no more than one source occurrence, found ${occurrences}`,
  );
  if (occurrences === 1) hardened = hardened.replace(search, replacement);
}

replaceOnceIfPresent(
  'const GUEST_TOKEN =\n  "4fca69b380be5f9898f435e548654c063f757562ca32fb9e5d09bb5d38d3295b";\n',
  "",
  "remove committed guest token",
);

replaceOnceIfPresent(
  `    if (isGuestUser && (!guestToken || guestToken !== GUEST_TOKEN)) {\n      throw new ReactionError(\n        "access-denied",\n        "Guest token required for guest users"\n      );\n    }\n`,
  `    const configuredGuestToken = String(\n      process.env.GUEST_CHECKOUT_TOKEN || ""\n    ).trim();\n    if (\n      isGuestUser &&\n      (!configuredGuestToken || !guestToken || guestToken !== configuredGuestToken)\n    ) {\n      throw new ReactionError(\n        "access-denied",\n        "Guest checkout is not configured or the guest token is invalid"\n      );\n    }\n`,
  "replace hardcoded guest-token validation",
);

for (const [search, description] of [
  ['  console.log("ORDER RECORD", order)\n', "remove full order logging"],
  [
    '      console.log("TRANSACTION RECORD in Place Order", result?.insertedId);\n',
    "remove transaction identifier logging",
  ],
  [
    '          console.log("easyPaisaResponse in place order", response)\n',
    "remove payment-provider response logging",
  ],
]) {
  replaceOnceIfPresent(search, "", description);
}

assert.doesNotMatch(
  hardened,
  /const\s+GUEST_TOKEN\s*=|4fca69b380be5f9898f435e548654c063f757562ca32fb9e5d09bb5d38d3295b/,
);
assert.match(hardened, /process\.env\.GUEST_CHECKOUT_TOKEN/);
assert.match(
  hardened,
  /!configuredGuestToken\s*\|\|\s*!guestToken\s*\|\|\s*guestToken\s*!==\s*configuredGuestToken/,
);
assert.doesNotMatch(hardened, /console\.log\(["']ORDER RECORD/);
assert.doesNotMatch(hardened, /console\.log\(["']easyPaisaResponse/);
assert.doesNotMatch(hardened, /console\.log\(["']TRANSACTION RECORD/);

if (writeMode) {
  if (hardened !== original) {
    await writeFile(sourcePath, hardened);
    console.log("Updated legacy place-order source security controls");
  } else {
    console.log("Legacy place-order source is already hardened");
  }
} else {
  assert.equal(
    original,
    hardened,
    "Legacy place-order source is not hardened; run node scripts/hardenPlaceOrderSource.mjs --write",
  );
  console.log("PASS legacy place-order source security controls");
}
