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
  'import verifyPaymentsMatchOrderTotal from "../util/verifyPaymentsMatchOrderTotal.js";\n',
  `import {\n  allocateServerPaymentSnapshots,\n  summarizeFulfillmentGroups,\n} from "../payments/serverPaymentSnapshot.js";\n`,
  "replace client payment-total helper import",
);

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

const authoritativeCreatePayments = `async function createPayments({\n  accountId,\n  billingAddress,\n  context,\n  currencyCode,\n  email,\n  paymentsInput,\n  pricingSnapshot,\n  shippingAddress,\n  shop,\n}) {\n  const availablePaymentMethods = shop.availablePaymentMethods || [];\n\n  let serverPaymentInputs;\n  try {\n    serverPaymentInputs = allocateServerPaymentSnapshots(\n      paymentsInput || [],\n      pricingSnapshot,\n    );\n  } catch (error) {\n    throw new ReactionError("payment-failed", error.message);\n  }\n\n  const paymentPromises = serverPaymentInputs.map(async (serverPaymentInput) => {\n    const {\n      paymentInput,\n      amount,\n      tax,\n      totalAmount,\n      finalAmount,\n    } = serverPaymentInput;\n    const { method: methodName } = paymentInput;\n\n    if (!availablePaymentMethods.includes(methodName)) {\n      throw new ReactionError(\n        "payment-failed",\n        \`Payment method not enabled for this shop: \${methodName}\`,\n      );\n    }\n\n    let paymentMethodConfig;\n    try {\n      paymentMethodConfig =\n        context.queries.getPaymentMethodConfigByName(methodName);\n    } catch (error) {\n      Logger.error(error.message);\n      throw new ReactionError(\n        "payment-failed",\n        \`Invalid payment method name: \${methodName}\`,\n      );\n    }\n\n    const payment = await paymentMethodConfig.functions.createAuthorizedPayment(\n      context,\n      {\n        accountId,\n        amount,\n        tax,\n        totalAmount,\n        finalAmount,\n        billingAddress: paymentInput.billingAddress || billingAddress,\n        currencyCode,\n        email,\n        shippingAddress,\n        shopId: shop._id,\n        paymentData: {\n          ...(paymentInput.data || {}),\n        },\n      },\n    );\n\n    const paymentWithCurrency = {\n      ...payment,\n      currency: { exchangeRate: 1, userCurrency: currencyCode },\n      currencyCode,\n      amount,\n      tax,\n      totalAmount,\n      finalAmount,\n    };\n\n    PaymentSchema.validate(paymentWithCurrency);\n    return paymentWithCurrency;\n  });\n\n  try {\n    const payments = await Promise.all(paymentPromises);\n    return payments.filter(Boolean);\n  } catch (error) {\n    Logger.error("createOrder: error creating payments", error.message);\n    throw new ReactionError(\n      "payment-failed",\n      \`There was a problem authorizing this payment: \${error.message}\`,\n    );\n  }\n}\n\n`;

const legacyCreatePaymentsStart = hardened.indexOf(
  "async function\n  createPayments({",
);
const placeOrderCommentStart = hardened.indexOf("/**\n * @method placeOrder");
if (legacyCreatePaymentsStart !== -1) {
  assert.ok(
    placeOrderCommentStart > legacyCreatePaymentsStart,
    "Unable to locate the end of the legacy createPayments function",
  );
  hardened =
    hardened.slice(0, legacyCreatePaymentsStart) +
    authoritativeCreatePayments +
    hardened.slice(placeOrderCommentStart);
} else {
  assert.match(hardened, /async function createPayments\(\{[\s\S]*pricingSnapshot/);
}

const legacyPaymentCall = `  const payments = await createPayments({\n    accountId,\n    billingAddress,\n    context,\n    currencyCode,\n    email,\n    orderTotal,\n    paymentsInput,\n    shippingAddress: shippingAddressForPayments,\n    shop,\n    taxPercentage,\n    fulfillmentType: fulfillmentGroups[0]?.type,\n    fulfillmentGroups,\n    discountTotal\n  });\n  if (payments[0].totalAmount < 500) {\n    throw new ReactionError(\n      "invalid-order",\n      "Order amount must be greater than 500"\n    );\n  }\n`;
const authoritativePaymentCall = `  const paymentPricingSnapshot = summarizeFulfillmentGroups(\n    finalFulfillmentGroups,\n  );\n  if (Math.abs(paymentPricingSnapshot.finalAmount - orderTotal) > 0.01) {\n    throw new ReactionError(\n      "invalid-order",\n      "Server order totals are inconsistent",\n    );\n  }\n\n  const payments = await createPayments({\n    accountId,\n    billingAddress,\n    context,\n    currencyCode,\n    email,\n    paymentsInput,\n    pricingSnapshot: paymentPricingSnapshot,\n    shippingAddress: shippingAddressForPayments,\n    shop,\n  });\n  if (paymentPricingSnapshot.merchandiseAfterDiscount < 500) {\n    throw new ReactionError(\n      "invalid-order",\n      "Order merchandise amount must be at least 500",\n    );\n  }\n`;
replaceOnceIfPresent(
  legacyPaymentCall,
  authoritativePaymentCall,
  "replace client-derived payment authorization",
);

const doubleDiscountExpression = "payments[0].finalAmount - discountTotal";
const doubleDiscountOccurrences = hardened.split(doubleDiscountExpression).length - 1;
assert.ok(
  doubleDiscountOccurrences <= 2,
  `Unexpected EasyPaisa double-discount occurrences: ${doubleDiscountOccurrences}`,
);
hardened = hardened.split(doubleDiscountExpression).join("payments[0].finalAmount");

replaceOnceIfPresent(
  '        isPaid: { $cond: [{ $eq: ["$paymentMethod", "EASYPAISA"] }, true, false] }, // for easyPaisa payment method, we are not marking it as paid as user pays to rider on delviery\n',
  '        isPaid: { $ifNull: ["$isPaid", false] },\n',
  "stop publishing EasyPaisa orders as paid before verification",
);

replaceOnceIfPresent(
  `   appEvents.emit("afterOrderCreate", {\n    createdBy: userId,\n    order,\n    orderId,\n    branchID,\n    branchData,\n    fulfillmentGroups,\n    generatedID,\n  });\n`,
  `   appEvents.emit("afterOrderCreate", {\n    createdBy: userId,\n    order,\n    orderId,\n    branchID,\n    branchData,\n    fulfillmentGroups: finalFulfillmentGroups,\n    generatedID,\n  });\n`,
  "publish server-built fulfillment groups",
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
assert.match(hardened, /allocateServerPaymentSnapshots/);
assert.match(hardened, /summarizeFulfillmentGroups/);
assert.match(hardened, /pricingSnapshot: paymentPricingSnapshot/);
assert.match(hardened, /merchandiseAfterDiscount < 500/);
assert.doesNotMatch(hardened, /payments\[0\]\.finalAmount - discountTotal/);
assert.doesNotMatch(
  hardened,
  /isPaid:\s*\{\s*\$cond:\s*\[\{\s*\$eq:\s*\["\$paymentMethod",\s*"EASYPAISA"\]/,
);
assert.doesNotMatch(hardened, /console\.log\(["']ORDER RECORD/);
assert.doesNotMatch(hardened, /console\.log\(["']easyPaisaResponse/);
assert.doesNotMatch(hardened, /console\.log\(["']TRANSACTION RECORD/);

if (writeMode) {
  if (hardened !== original) {
    await writeFile(sourcePath, hardened);
    console.log("Updated place-order security and pricing controls");
  } else {
    console.log("Place-order source is already hardened");
  }
} else {
  assert.equal(
    original,
    hardened,
    "Place-order source is not hardened; run node scripts/hardenPlaceOrderSource.mjs --write",
  );
  console.log("PASS place-order security and pricing controls");
}
