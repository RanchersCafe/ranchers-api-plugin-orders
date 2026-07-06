import assert from "assert/strict";
import placeOrderGuarded from "../src/mutations/placeOrderGuarded.js";
import { PAYMENT_STATUS } from "../src/util/paymentStatus.js";
import { InMemoryCollection } from "./support/inMemoryCollection.mjs";

class CheckoutCollection extends InMemoryCollection {
  async insertOne(document) {
    if (await this.findOne({ checkoutKey: document.checkoutKey })) {
      const error = new Error("duplicate");
      error.code = 11000;
      throw error;
    }
    this.documents.push(structuredClone(document));
    return { insertedId: document.checkoutKey };
  }
}

function fixtures(requests = []) {
  const order = {
    _id: "order-guarded",
    branchID: "branch-a",
    paymentMethod: "EASYPAISA",
    paymentStatus: PAYMENT_STATUS.CREATED,
    isPaid: false,
    currencyCode: "PKR",
    payments: [{ finalAmount: 1 }],
    shipping: [{ invoice: { subtotal: 900, total: 1000 } }],
    discounts: [{ amount: 50 }],
  };
  const Orders = new InMemoryCollection([order]);
  const CheckoutRequest = new CheckoutCollection(requests);
  return { order, Orders, CheckoutRequest };
}

const input = {
  clientMutationId: "checkout-guarded-1",
  order: {
    shopId: "shop-a",
    fulfillmentGroups: [{ paymentMethod: "EASYPAISA" }],
  },
};

export async function runPlaceOrderGuardedIntegrationTests() {
  {
    const { order, Orders, CheckoutRequest } = fixtures();
    let legacyCalls = 0;
    const result = await placeOrderGuarded(
      { userId: "user-a", collections: { Orders, CheckoutRequest } },
      input,
      {
        legacyPlaceOrder: async () => {
          legacyCalls += 1;
          return { orders: [structuredClone(order)], token: null };
        },
        createLockToken: () => "lock-a",
        clock: { now: () => new Date("2026-07-03T10:00:00.000Z") },
        publishStatus: () => {},
      }
    );

    assert.equal(legacyCalls, 1);
    assert.equal(result.idempotent, false);
    assert.equal(result.orders[0].payments[0].finalAmount, 1000);
    assert.equal(result.orders[0].isPaid, false);
    assert.equal(result.orders[0].paymentStatus, PAYMENT_STATUS.PENDING);
    const saved = await Orders.findOne({ _id: "order-guarded" });
    assert.equal(saved.authoritativePaymentAmount, 1000);
    const request = CheckoutRequest.snapshot()[0];
    assert.equal(request.status, "COMPLETED");
    assert.deepEqual(request.orderIds, ["order-guarded"]);
  }

  {
    const { Orders, CheckoutRequest } = fixtures([
      {
        checkoutKey: "user-a:shop-a:checkout-guarded-1",
        clientMutationId: "checkout-guarded-1",
        status: "COMPLETED",
        orderIds: ["order-guarded"],
      },
    ]);
    let legacyCalls = 0;
    const result = await placeOrderGuarded(
      { userId: "user-a", collections: { Orders, CheckoutRequest } },
      input,
      { legacyPlaceOrder: async () => { legacyCalls += 1; } }
    );
    assert.equal(result.idempotent, true);
    assert.equal(legacyCalls, 0);
  }

  {
    const { Orders, CheckoutRequest } = fixtures();
    await assert.rejects(
      () => placeOrderGuarded(
        { userId: "user-a", collections: { Orders, CheckoutRequest } },
        { order: { shopId: "shop-a", fulfillmentGroups: [{ paymentMethod: "EASYPAISA" }] } },
        { legacyPlaceOrder: async () => ({ orders: [] }) }
      ),
      /clientMutationId is required/
    );
  }
}
