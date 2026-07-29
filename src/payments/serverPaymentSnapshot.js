const MONEY_SCALE = 100;

export function toMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * MONEY_SCALE) / MONEY_SCALE;
}

function nonNegativeMoney(value, fieldName) {
  const parsed = toMoney(value);
  if (parsed < 0) {
    throw new Error(`${fieldName} must not be negative`);
  }
  return parsed;
}

export function summarizeFulfillmentGroups(groups = []) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("At least one server-built fulfillment group is required");
  }

  const summary = groups.reduce(
    (result, group, index) => {
      const invoice = group?.invoice;
      if (!invoice) {
        throw new Error(`Fulfillment group ${index + 1} is missing its server invoice`);
      }

      result.subtotal += nonNegativeMoney(invoice.subtotal, "Invoice subtotal");
      result.tax += nonNegativeMoney(invoice.taxes, "Invoice tax");
      result.shipping += nonNegativeMoney(invoice.shipping, "Invoice shipping");
      result.discounts += nonNegativeMoney(invoice.discounts, "Invoice discounts");
      result.surcharges += nonNegativeMoney(invoice.surcharges, "Invoice surcharges");
      result.finalAmount += nonNegativeMoney(invoice.total, "Invoice total");
      return result;
    },
    {
      subtotal: 0,
      tax: 0,
      shipping: 0,
      discounts: 0,
      surcharges: 0,
      finalAmount: 0,
    },
  );

  for (const key of Object.keys(summary)) summary[key] = toMoney(summary[key]);
  summary.merchandiseAfterDiscount = toMoney(
    Math.max(0, summary.subtotal - summary.discounts),
  );
  summary.amount = toMoney(Math.max(0, summary.finalAmount - summary.shipping));
  return summary;
}

function requestedFinalAmount(paymentInput) {
  const candidate = Number.isFinite(Number(paymentInput?.finalAmount))
    ? paymentInput.finalAmount
    : paymentInput?.amount;
  const value = toMoney(candidate);
  if (value <= 0) {
    throw new Error("Each payment must have a positive final amount");
  }
  return value;
}

export function verifyPaymentPreview(paymentsInput = [], expectedFinalAmount) {
  if (!Array.isArray(paymentsInput) || paymentsInput.length === 0) {
    throw new Error("At least one payment is required");
  }

  const requestedAmounts = paymentsInput.map(requestedFinalAmount);
  const requestedTotal = toMoney(
    requestedAmounts.reduce((sum, value) => sum + value, 0),
  );
  const expectedTotal = toMoney(expectedFinalAmount);

  if (Math.abs(requestedTotal - expectedTotal) > 0.01) {
    throw new Error(
      `Payment preview total ${requestedTotal} does not match server order total ${expectedTotal}`,
    );
  }

  return requestedAmounts;
}

function allocateComponent(total, requestedAmounts, expectedFinalAmount) {
  let allocated = 0;
  return requestedAmounts.map((requestedAmount, index) => {
    if (index === requestedAmounts.length - 1) {
      return toMoney(total - allocated);
    }
    const share = expectedFinalAmount > 0
      ? requestedAmount / expectedFinalAmount
      : 0;
    const value = toMoney(total * share);
    allocated = toMoney(allocated + value);
    return value;
  });
}

export function allocateServerPaymentSnapshots(paymentsInput, summary) {
  const requestedAmounts = verifyPaymentPreview(
    paymentsInput,
    summary.finalAmount,
  );
  const finalAmounts = allocateComponent(
    summary.finalAmount,
    requestedAmounts,
    summary.finalAmount,
  );
  const subtotals = allocateComponent(
    summary.subtotal,
    requestedAmounts,
    summary.finalAmount,
  );
  const taxes = allocateComponent(
    summary.tax,
    requestedAmounts,
    summary.finalAmount,
  );
  const shipping = allocateComponent(
    summary.shipping,
    requestedAmounts,
    summary.finalAmount,
  );

  return paymentsInput.map((paymentInput, index) => ({
    paymentInput,
    amount: toMoney(Math.max(0, finalAmounts[index] - shipping[index])),
    tax: taxes[index],
    totalAmount: subtotals[index],
    finalAmount: finalAmounts[index],
  }));
}
