import pubSub from "../util/pubSubIntance.js";

export default function publishPaymentStatus({
  branchId,
  externalOrderId,
  orderId,
  status,
  isPaid,
  initiatedAt,
}) {
  const event = {
    orderId,
    paymentStatus: status,
    updatedAt: new Date(),
    paymentMethod: "EASYPAISA",
    isPaid,
    paymentInitiatedAt: initiatedAt,
  };

  if (branchId) {
    pubSub.publish(`ORDER_PAYMENT_STATUS_UPDATED_${branchId}`, {
      orderPaymentStatusUpdated: event,
    });
  }

  if (externalOrderId) {
    pubSub.publish(`ORDER_PAYMENT_STATUS_UPDATED_${externalOrderId}`, {
      orderPaymentStatusUpdated: {
        ...event,
        orderId: externalOrderId,
      },
    });
  }
}
