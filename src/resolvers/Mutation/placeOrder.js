import {
  decodeCartOpaqueId,
  decodeFulfillmentMethodOpaqueId,
  decodeOrderItemsOpaqueIds,
  decodeShopOpaqueId,
} from "../../xforms/id.js";

export default async function placeOrder(parentResult, { input }, context) {
  const {
    clientMutationId = null,
    order,
    payments,
    branchID,
    notes,
    Latitude,
    Longitude,
    placedFrom,
    isGuestUser = false,
    guestToken = null,
    jazzCashNumber,
    CNIC,
  } = input;

  const {
    cartId: opaqueCartId,
    fulfillmentGroups,
    shopId: opaqueShopId,
  } = order;
  const cartId = opaqueCartId ? decodeCartOpaqueId(opaqueCartId) : null;
  const shopId = decodeShopOpaqueId(opaqueShopId);
  const transformedFulfillmentGroups = fulfillmentGroups.map((group) => ({
    ...group,
    paymentMethod: group?.paymentMethod || "CASH",
    items: decodeOrderItemsOpaqueIds(group.items),
    selectedFulfillmentMethodId: decodeFulfillmentMethodOpaqueId(
      group.selectedFulfillmentMethodId
    ),
    shopId: decodeShopOpaqueId(group.shopId),
  }));

  const result = await context.mutations.placeOrder(context, {
    clientMutationId,
    order: {
      ...order,
      cartId,
      fulfillmentGroups: transformedFulfillmentGroups,
      shopId,
      notes,
    },
    payments,
    branchID,
    placedFrom,
    notes,
    Latitude,
    Longitude,
    isGuestUser,
    guestToken,
    jazzCashNumber,
    CNIC,
  });

  return {
    clientMutationId,
    orders: result.orders,
    token: result.token,
    notes,
  };
}
