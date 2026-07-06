const MONEY_PRECISION = 100;

export function roundMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round((amount + Number.EPSILON) * MONEY_PRECISION) / MONEY_PRECISION;
}

export function positiveMoney(value) {
  const amount = roundMoney(value);
  return amount !== null && amount > 0 ? amount : null;
}

export function getOrderInvoiceTotal(order) {
  const groups = Array.isArray(order?.shipping) ? order.shipping : [];
  if (groups.length > 0) {
    const total = groups.reduce(
      (sum, group) => sum + Number(group?.invoice?.total || 0),
      0
    );
    const normalized = positiveMoney(total);
    if (normalized !== null) return normalized;
  }

  return positiveMoney(order?.payments?.[0]?.finalAmount);
}

export function amountsMatch(expected, actual, tolerance = 0.01) {
  const expectedAmount = roundMoney(expected);
  const actualAmount = roundMoney(actual);
  if (expectedAmount === null || actualAmount === null) return false;
  return Math.abs(expectedAmount - actualAmount) < tolerance;
}

export function buildIdempotencyKey(provider, orderId, attemptId) {
  const providerName = String(provider || "payment").trim().toLowerCase();
  const orderReference = String(orderId || "").trim();
  const attemptReference = String(attemptId || "").trim();

  if (!orderReference || !attemptReference) {
    throw new TypeError("orderId and attemptId are required to build an idempotency key");
  }

  return `${providerName}:${orderReference}:${attemptReference}`;
}
