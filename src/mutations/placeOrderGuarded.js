import ReactionError from "@reactioncommerce/reaction-error";
import {
  acquireCheckoutRequest,
  buildCheckoutKey,
  completeCheckoutRequest,
  failCheckoutRequest,
  normalizeClientMutationId,
} from "../orders/checkoutIdempotency.js";
import { persistPricingSnapshot } from "../orders/orderPricingSnapshot.js";

function isEasyPaisaOrder(input) {
  return input?.order?.fulfillmentGroups?.some(
    (group) => String(group?.paymentMethod || "").toUpperCase() === "EASYPAISA"
  );
}

async function loadExistingOrders(Orders, orderIds) {
  if (!Orders || !Array.isArray(orderIds) || orderIds.length === 0) return [];
  if (orderIds.length === 1) {
    const order = await Orders.findOne({ _id: orderIds[0] });
    return order ? [order] : [];
  }
  return Orders.find({ _id: { $in: orderIds } }).toArray();
}

async function resolvePlaceOrder(dependencies) {
  if (dependencies.legacyPlaceOrder) return dependencies.legacyPlaceOrder;
  const module = await import("./placeOrder.js");
  return module.default;
}

export default async function placeOrderGuarded(context, input, dependencies = {}) {
  const clock = dependencies.clock || { now: () => new Date() };
  const createLockToken =
    dependencies.createLockToken || (() => `${Date.now()}-${Math.random()}`);
  const clientMutationId = normalizeClientMutationId(input?.clientMutationId);
  const easyPaisa = isEasyPaisaOrder(input);

  if (easyPaisa && !clientMutationId) {
    throw new ReactionError(
      "invalid-param",
      "clientMutationId is required for Easypaisa orders"
    );
  }

  const { Orders, CheckoutRequest } = context.collections;
  const checkoutKey = clientMutationId
    ? buildCheckoutKey(context, input, clientMutationId)
    : null;
  const lockToken = checkoutKey ? createLockToken() : null;

  if (checkoutKey) {
    const claim = await acquireCheckoutRequest({
      CheckoutRequest,
      checkoutKey,
      clientMutationId,
      context,
      now: clock.now(),
      lockToken,
    });

    if (!claim.acquired && claim.completed) {
      const orders = await loadExistingOrders(Orders, claim.record.orderIds);
      if (orders.length) return { orders, token: null, idempotent: true };
    }

    if (!claim.acquired) {
      throw new ReactionError(
        "request-in-progress",
        "This checkout request is already being processed"
      );
    }
  }

  try {
    const placeOrder = await resolvePlaceOrder(dependencies);
    const result = await placeOrder(context, input);
    const now = clock.now();
    await Promise.all(
      (result.orders || []).map((order) =>
        persistPricingSnapshot({
          Orders,
          order,
          clientMutationId,
          now,
          publishStatus: dependencies.publishStatus,
        })
      )
    );

    await completeCheckoutRequest(
      CheckoutRequest,
      checkoutKey,
      lockToken,
      (result.orders || []).map((order) => order._id),
      now
    );

    return { ...result, idempotent: false };
  } catch (error) {
    await failCheckoutRequest(
      CheckoutRequest,
      checkoutKey,
      lockToken,
      error,
      clock.now()
    );
    throw error;
  }
}

export { isEasyPaisaOrder, loadExistingOrders, resolvePlaceOrder };
