import ReactionError from "@reactioncommerce/reaction-error";

const DEFAULT_LOCK_MS = 2 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function normalizeClientMutationId(value) {
  const id = String(value || "").trim();
  if (!id) return null;
  if (!KEY_PATTERN.test(id)) {
    throw new ReactionError(
      "invalid-param",
      "clientMutationId must be 8-128 URL-safe characters"
    );
  }
  return id;
}

export function buildCheckoutKey(context, input, clientMutationId) {
  const principal = context.accountId || context.userId || "guest";
  const shopId = input?.order?.shopId || "unknown-shop";
  return `${principal}:${shopId}:${clientMutationId}`;
}

export function checkoutLockMs() {
  const configured = Number.parseInt(
    process.env.CHECKOUT_IDEMPOTENCY_LOCK_MS || String(DEFAULT_LOCK_MS),
    10
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LOCK_MS;
}

export async function acquireCheckoutRequest({
  CheckoutRequest,
  checkoutKey,
  clientMutationId,
  context,
  now,
  lockToken,
}) {
  if (!CheckoutRequest) return { acquired: true, record: null };

  const existing = await CheckoutRequest.findOne({ checkoutKey });
  if (existing?.status === "COMPLETED" && existing?.orderIds?.length) {
    return { acquired: false, completed: true, record: existing };
  }

  const lockExpiresAt = new Date(now.getTime() + checkoutLockMs());
  if (!existing) {
    try {
      await CheckoutRequest.insertOne({
        checkoutKey,
        clientMutationId,
        accountId: context.accountId || null,
        userId: context.userId || null,
        status: "PROCESSING",
        lockToken,
        lockExpiresAt,
        attemptCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { acquired: true, record: null };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  const result = await CheckoutRequest.findOneAndUpdate(
    {
      checkoutKey,
      status: { $ne: "COMPLETED" },
      $or: [
        { lockExpiresAt: { $exists: false } },
        { lockExpiresAt: null },
        { lockExpiresAt: { $lte: now } },
        { status: "FAILED" },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        lockToken,
        lockExpiresAt,
        lastAttemptAt: now,
        updatedAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    { returnOriginal: false }
  );

  if (result?.value) return { acquired: true, record: result.value };
  const current = await CheckoutRequest.findOne({ checkoutKey });
  return {
    acquired: false,
    completed: current?.status === "COMPLETED",
    record: current,
  };
}

export async function completeCheckoutRequest(
  CheckoutRequest,
  checkoutKey,
  lockToken,
  orderIds,
  now
) {
  if (!CheckoutRequest || !checkoutKey) return;
  await CheckoutRequest.updateOne(
    { checkoutKey, lockToken },
    {
      $set: {
        status: "COMPLETED",
        orderIds,
        completedAt: now,
        updatedAt: now,
      },
      $unset: { lockToken: "", lockExpiresAt: "" },
    }
  );
}

export async function failCheckoutRequest(
  CheckoutRequest,
  checkoutKey,
  lockToken,
  error,
  now
) {
  if (!CheckoutRequest || !checkoutKey) return;
  await CheckoutRequest.updateOne(
    { checkoutKey, lockToken },
    {
      $set: {
        status: "FAILED",
        failureCode: error?.error || error?.code || null,
        failedAt: now,
        updatedAt: now,
      },
      $unset: { lockToken: "", lockExpiresAt: "" },
    }
  );
}
