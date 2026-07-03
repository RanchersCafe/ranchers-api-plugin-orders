import { getOrderInvoiceTotal, roundMoney } from "../payments/paymentMath.js";
import publishPaymentStatus from "../payments/publishPaymentStatus.js";
import { PAYMENT_STATUS } from "../util/paymentStatus.js";

export function buildPricingSnapshot(order, now) {
  const grandTotal = getOrderInvoiceTotal(order);
  if (grandTotal === null) return null;
  const subtotal = roundMoney(
    (order.shipping || []).reduce(
      (sum, group) => sum + Number(group?.invoice?.subtotal || 0),
      0
    )
  );
  const discount = roundMoney(
    (order.discounts || []).reduce(
      (sum, item) => sum + Number(item?.amount || 0),
      0
    )
  );
  return {
    currencyCode: order.currencyCode || "PKR",
    subtotal: subtotal || 0,
    discount: discount || 0,
    grandTotal,
    calculatedAt: now,
    version: 1,
  };
}

export async function persistPricingSnapshot(options) {
  const {
    Orders,
    order,
    clientMutationId,
    now,
    publishStatus = publishPaymentStatus,
  } = options;
  const snapshot = buildPricingSnapshot(order, now);
  const easyPaisa = String(order.paymentMethod || "").toUpperCase() === "EASYPAISA";
  const status = easyPaisa && order.paymentStatus !== PAYMENT_STATUS.VERIFIED_PAID
    ? PAYMENT_STATUS.PENDING
    : order.paymentStatus;
  const setValues = {
    checkoutClientMutationId: clientMutationId,
    updatedAt: now,
  };

  if (snapshot) {
    setValues.pricingSnapshot = snapshot;
    setValues.authoritativePaymentAmount = snapshot.grandTotal;
    setValues["payments.0.finalAmount"] = snapshot.grandTotal;
    order.pricingSnapshot = snapshot;
    order.authoritativePaymentAmount = snapshot.grandTotal;
    if (order.payments?.[0]) order.payments[0].finalAmount = snapshot.grandTotal;
  }

  if (easyPaisa) {
    setValues.isPaid = status === PAYMENT_STATUS.VERIFIED_PAID;
    setValues.paymentStatus = status;
    order.isPaid = setValues.isPaid;
    order.paymentStatus = status;
  }

  await Orders.updateOne({ _id: order._id }, { $set: setValues });

  if (easyPaisa && !order.isPaid) {
    publishStatus({
      branchId: order.branchID,
      externalOrderId: order._id,
      orderId: order._id,
      status,
      isPaid: false,
      initiatedAt: order.paymentInitiatedAt,
    });
  }
  return snapshot;
}
