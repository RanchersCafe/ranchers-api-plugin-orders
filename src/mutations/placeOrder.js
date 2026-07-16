import _ from "lodash";
import ObjectID from "mongodb";
import SimpleSchema from "simpl-schema";
import Logger from "@reactioncommerce/logger";
import Random from "@reactioncommerce/random";
import ReactionError from "@reactioncommerce/reaction-error";
import getAnonymousAccessToken from "@reactioncommerce/api-utils/getAnonymousAccessToken.js";
import buildOrderFulfillmentGroupFromInput from "../util/buildOrderFulfillmentGroupFromInput.js";
import verifyPaymentsMatchOrderTotal from "../util/verifyPaymentsMatchOrderTotal.js";
import doEasyPaisaPayment from "../util/easyPaisaPayment.js";
import sendOrderEmail from "../util/sendOrderEmail.js";
import encodeOpaqueId from "@reactioncommerce/api-utils/encodeOpaqueId.js";
import checkTimeBasedDiscount from "../util/checkTimeBasedDiscount.js";

import {
  Order as OrderSchema,
  orderInputSchema,
  Payment as PaymentSchema,
  paymentInputSchema,
} from "../simpleSchemas.js";
// import deliveryTimeCalculation from "../util/deliveryTimeCalculation.js";
import generateKitchenOrderID from "../util/generateKitchenOrderID.js";
import checkIfTime from "../util/checkIfTime.js";
import pubSub from "../util/pubSubIntance.js";
// import { PubSub } from "graphql-subscriptions";
// const pubSub = new PubSub();

const DEAL_TAG_ID = "QxJefMA3viGnquk6Y";

const inputSchema = new SimpleSchema({
  order: orderInputSchema,
  payments: {
    type: Array,
    optional: true,
  },
  "payments.$": paymentInputSchema,
});

/**
 * @summary Create all authorized payments for a potential order
 * @param {String} [accountId] The ID of the account placing the order
 * @param {Object} [billingAddress] Billing address for the order as a whole
 * @param {Object} context - The application context
 * @param {String} currencyCode Currency code for interpreting the amount of all payments
 * @param {String} email Email address for the order
 * @param {Number} orderTotal Total due for the order
 * @param {Object[]} paymentsInput List of payment inputs
 * @param {Object} [shippingAddress] Shipping address, if relevant, for fraud detection
 * @param {String} shop shop that owns the order
 * @returns {Object[]} Array of created payments
 */
async function
  createPayments({
    accountId,
    billingAddress,
    context,
    currencyCode,
    email,
    orderTotal,
    paymentsInput,
    shippingAddress,
    shop,
    taxPercentage,
    fulfillmentType,
    fulfillmentGroups,
    discountTotal
  }) {

  // Determining which payment methods are enabled for the shop
  const availablePaymentMethods = shop.availablePaymentMethods || [];

  // Calculate total amount from items
  const totalAmount = fulfillmentGroups.reduce((sum, group) => {
    return sum + group.items.reduce((itemSum, item) => {
      return itemSum + (item.price * item.quantity);
    }, 0);
  }, 0);

  // Calculate tax based on totalAmount and taxPercentage
  const tax = Math.round(totalAmount * (taxPercentage / 100));

  // Calculate amount (totalAmount + tax)
  const amount = totalAmount + tax;

  // Create authorized payments for each
  const paymentPromises = (paymentsInput || []).map(async (paymentInput) => {
    const {
      method: methodName
    } = paymentInput;

    // Calculate finalAmount based on fulfillment type
    let finalAmount;
    if (fulfillmentType === "shipping") {
      if (shop?.deliveryCharges == null || shop?.deliveryCharges == undefined) {
        throw new ReactionError(
          "payment-failed",
          `Missing key deliveryCharges in shop Object`
        );
      }
      finalAmount = amount + parseInt(shop?.deliveryCharges); // Adding delivery fee of 50 for shipping
    } else {
      finalAmount = amount; // Just totalAmount + tax for pickup
    }

    // Verify that this payment method is enabled for the shop
    if (!availablePaymentMethods.includes(methodName)) {
      throw new ReactionError(
        "payment-failed",
        `Payment method not enabled for this shop: ${methodName}`
      );
    }

    // Grab config for this payment method
    let paymentMethodConfig;
    try {
      paymentMethodConfig =
        context.queries.getPaymentMethodConfigByName(methodName);
    } catch (error) {
      Logger.error(error);
      throw new ReactionError(
        "payment-failed",
        `Invalid payment method name: ${methodName}`
      );
    }

    // Authorize this payment
    const payment = await paymentMethodConfig.functions.createAuthorizedPayment(
      context,
      {
        accountId,
        amount,
        tax,
        totalAmount,
        finalAmount,
        billingAddress: paymentInput.billingAddress || billingAddress,
        currencyCode,
        email,
        shippingAddress,
        shopId: shop._id,
        paymentData: {
          ...(paymentInput.data || {}),
        },
      }
    );
    const paymentWithCurrency = {
      ...payment,
      // This is from previous support for exchange rates, which was removed in v3.0.0
      currency: { exchangeRate: 1, userCurrency: currencyCode },
      currencyCode,
      finalAmount,
    };

    // For EASYPAISA payments, ensure finalAmount is properly set (commented out as per user request)
    // if (methodName === "easypaisa" && (!paymentWithCurrency.finalAmount || paymentWithCurrency.finalAmount <= 0)) {
    //   if (paymentWithCurrency.totalAmount > 0) {
    //     paymentWithCurrency.finalAmount = paymentWithCurrency.totalAmount;
    //   } else if (paymentWithCurrency.amount > 0) {
    //     paymentWithCurrency.finalAmount = paymentWithCurrency.amount;
    //   } else {
    //     throw new ReactionError(
    //       "payment-invalid",
    //       "Cannot determine payment amount for EasyPaisa payment"
    //     );
    //   }
    // }

    PaymentSchema.validate(paymentWithCurrency);

    return paymentWithCurrency;
  });

  let payments;
  try {
    payments = await Promise.all(paymentPromises);
    payments = payments.filter((payment) => !!payment); // remove nulls
  } catch (error) {
    Logger.error("createOrder: error creating payments", error);
    throw new ReactionError(
      "payment-failed",
      `There was a problem authorizing this payment: ${error.message}`
    );
  }
  return payments;
}

/**
 * @method placeOrder
 * @summary Places an order, authorizing all payments first
 * @param {Object} context - an object containing the per-request state
 * @param {Object} input - Necessary input. See SimpleSchema
 * @returns {Promise<Object>} Object with `order` property containing the created order
 */
export default async function placeOrder(context, input) {
  let prepTime = 0;
  let taxID = "";
  let deliveryTime = 0.0;
  let deliveryCharges;
  let today = new Date().toISOString().substr(0, 10);
  const cleanedInput = inputSchema.clean(input); // add default values and such
  inputSchema.validate(cleanedInput);
  const { order: orderInput, payments: paymentsInput } = cleanedInput;

  const {
    branchID,
    notes,
    Latitude,
    Longitude,
    placedFrom,
    isGuestUser,
    guestToken,
    jazzCashNumber
  } = input;
  const {
    billingAddress,
    cartId,
    currencyCode,
    customFields: customFieldsFromClient,
    email,
    fulfillmentGroups,
    ordererPreferredLanguage,
    shopId,
  } = orderInput;

  const { accountId, appEvents, collections, getFunctionsOfType, userId } =
    context;
  const { TaxRate, Orders, Cart, BranchData, CartHistory, Transaction } = collections;

  //this is moved to the app event call
  let query = {
    todayDate: { $eq: today },
    branchID: { $eq: branchID },
    kitchenOrderID: { $exists: true },
  };
  let generatedID = await generateKitchenOrderID(query, Orders, branchID);
  let kitchenOrderID = generatedID;
  let todayDate = today;
  let branchData = await BranchData.findOne({
    _id: ObjectID.ObjectId(branchID),
  });
  if (branchData?.Timing) {
    const [startTime, endTime] = branchData.Timing.split(" - ").map((time) => time.trim());
    // Call the checkIfTime function
    const isOpen = await checkIfTime(startTime, endTime);

    if (!isOpen && process.env.ENVIRONMENT == "production") {
      throw new ReactionError("access-denied", `${branchData.name} Branch is closed for now. Please try between ${branchData.Timing}`);
    }
  }
  if (branchData) {
    prepTime = branchData.prepTime;
    taxID = branchData.taxID;
    deliveryCharges = branchData.deliveryCharges;
  }

  prepTime = prepTime ? prepTime : 20;
  const taxData = await TaxRate.findOne({ _id: ObjectID.ObjectId(taxID) });
  let taxPercentage = taxData?.Cash;
  if (
    fulfillmentGroups?.[0]?.type === "pickup" &&
    fulfillmentGroups?.[0]?.paymentMethod === "CARD"
  ) {
    taxPercentage = taxData?.Card;
  }
  if (fulfillmentGroups?.[0]?.paymentMethod === "EASYPAISA") {
    taxPercentage = taxData?.Card;
  }

  const shop = await context.queries.shopById(context, shopId);
  if (!shop) throw new ReactionError("not-found", "Shop not found");
  if (
    !shop?.discount ||
    shop.discount?.discountValue == null ||
    !shop.discount?.startTime ||
    !shop.discount?.endTime
  ) {
    throw new ReactionError(
      "invalid-param",
      "Missing discount configuration in shop Object"
    );
  }

  // if (!userId && !shop.allowGuestCheckout) {
  //   throw new ReactionError("access-denied", "Guest checkout not allowed");
  // }

  if (!userId) {
    if (!isGuestUser) {
      throw new ReactionError("access-denied", "User or guest access required");
    }
    const configuredGuestToken = String(
      process.env.GUEST_CHECKOUT_TOKEN || ""
    ).trim();
    if (
      isGuestUser &&
      (!configuredGuestToken || !guestToken || guestToken !== configuredGuestToken)
    ) {
      throw new ReactionError(
        "access-denied",
        "Guest checkout is not configured or the guest token is invalid"
      );
    }
  }

  let cart;
  if (cartId) {
    //console.log("cartId ", cartId)
    cart = await Cart.findOne({ _id: cartId });
    //console.log("cart ",cart)
    // await
    if (!cart) {
      throw new ReactionError(
        "not-found",
        "Cart not found while trying to place order"
      );
    }
  }
  // We are mixing concerns a bit here for now. This is for backwards compatibility with current
  // discount codes feature. We are planning to revamp discounts soon, but until then, we'll look up
  // any discounts on the related cart here.
  let discounts = [];
  let discountTotal = 0;
  // if (cart) {
  //   const discountsResult = await context.queries.getDiscountsTotalForCart(
  //     context,
  //     cart
  //   );
  //   ({ discounts } = discountsResult);
  //   discountTotal = discountsResult.total;
  // }

  // Create array for surcharges to apply to order, if applicable
  // Array is populated inside `fulfillmentGroups.map()`
  const orderSurcharges = [];

  // Create orderId
  const orderId = Random.id();

  // First pass: build fulfillment groups to calculate item totals
  let itemsTotalBeforeDiscount = 0;
  const initialFulfillmentGroups = await Promise.all(
    fulfillmentGroups.map(async (inputGroup) => {
      const { group, groupSurcharges } =
        await buildOrderFulfillmentGroupFromInput(context, {
          accountId,
          billingAddress,
          cartId,
          currencyCode,
          discountTotal,
          inputGroup,
          orderId,
          cart,
          branchID,
          notes,
          Latitude,
          Longitude,
        });

      // Accumulate items total before any discount
      itemsTotalBeforeDiscount += (group.invoice.subtotal || 0);

      return { group, groupSurcharges };
    })
  );

  const hasDealItem = initialFulfillmentGroups.some(({ group }) =>
    (group.items || []).some((item) =>
      item?.isDeal === true || item?.productTagIds?.includes(DEAL_TAG_ID)
    )
  ) || (cart?.items || []).some((item) =>
    item?.isDeal === true || item?.productTagIds?.includes(DEAL_TAG_ID)
  );

  // Calculate time-based discount using Shop.discount object values.
  const clientTimeZone = customFieldsFromClient?.timeZone || customFieldsFromClient?.timezone || "Asia/Karachi";
  const { isDiscountActive, discountAmount } = checkTimeBasedDiscount(
    itemsTotalBeforeDiscount,
    clientTimeZone,
    shop.discount.discountValue,
    shop.discount.startTime,
    shop.discount.endTime,
    hasDealItem
  );
  if (isDiscountActive) {
    const timeBasedDiscountInfo = {
      amount: discountAmount,
      discountId: "night-discount-8pm-2am"
    };
    discounts.push(timeBasedDiscountInfo);
    discountTotal += discountAmount;
  }

  // Second pass: rebuild groups with updated discount total if time-based discount was applied
  let orderTotal = 0;
  let shippingAddressForPayments = null;
  const finalFulfillmentGroups = await Promise.all(
    fulfillmentGroups.map(async (inputGroup) => {
      const { group, groupSurcharges } =
        await buildOrderFulfillmentGroupFromInput(context, {
          accountId,
          billingAddress,
          cartId,
          currencyCode,
          discountTotal, // Now includes time-based discount if applicable
          inputGroup,
          orderId,
          cart,
          branchID,
          notes,
          Latitude,
          Longitude,
        });

      // We save off the first shipping address found, for passing to payment services. They use this
      // for fraud detection.
      if (group.address && !shippingAddressForPayments)
        shippingAddressForPayments = group.address;

      // Push all group surcharges to overall order surcharge array.
      // Currently, we do not save surcharges per group
      orderSurcharges.push(...groupSurcharges);

      // Add the group total to the order total
      orderTotal += group.invoice.total;
      // //console.log("orderTotal", orderTotal);
      // //console.log("group", group);
      return group;
    })
  );

  const payments = await createPayments({
    accountId,
    billingAddress,
    context,
    currencyCode,
    email,
    orderTotal,
    paymentsInput,
    shippingAddress: shippingAddressForPayments,
    shop,
    taxPercentage,
    fulfillmentType: fulfillmentGroups[0]?.type,
    fulfillmentGroups,
    discountTotal
  });
  if (payments[0].totalAmount < 500) {
    throw new ReactionError(
      "invalid-order",
      "Order amount must be greater than 500"
    );
  }

  // Create anonymousAccessToken if no account ID
  const fullToken = accountId ? null : getAnonymousAccessToken();

  const now = new Date();
  const order = {
    _id: orderId,
    accountId,
    billingAddress,
    cartId,
    createdAt: now,
    currencyCode,
    discounts,
    email,
    ordererPreferredLanguage: ordererPreferredLanguage || null,
    payments,
    shipping: finalFulfillmentGroups,
    shopId,
    placedFrom,
    branchID,
    notes,
    surcharges: orderSurcharges,
    totalItemQuantity: finalFulfillmentGroups.reduce(
      (sum, group) => sum + group.totalItemQuantity,
      0
    ),
    updatedAt: now,
    workflow: {
      status: "new",
      workflow: ["new"],
    },
    kitchenOrderID,
    todayDate,
    prepTime,
    deliveryTime,
    Latitude,
    Longitude,
    paymentMethod: fulfillmentGroups[0].paymentMethod,
    isPaid: false,
    transactionId: "null",
    msisdn: jazzCashNumber || null,
    paymentStatus: "NA",
  };



  if (fullToken) {
    const dbToken = { ...fullToken };
    // don't store the raw token in db, only the hash
    delete dbToken.token;
    order.anonymousAccessTokens = [dbToken];
  }
  let referenceId;
  const createReferenceIdFunctions = getFunctionsOfType(
    "createOrderReferenceId"
  );
  if (!createReferenceIdFunctions || createReferenceIdFunctions.length === 0) {
    // if the cart has a reference Id, and no custom function is created use that
    if (_.get(cart, "referenceId")) {
      // we want the else to fallthrough if no cart to keep the if/else logic simple
      ({ referenceId } = cart);
    } else {
      referenceId = Random.id();
    }
  } else {
    referenceId = await createReferenceIdFunctions[0](context, order, cart);
    if (typeof referenceId !== "string") {
      throw new ReactionError(
        "invalid-parameter",
        "createOrderReferenceId function returned a non-string value"
      );
    }
    if (createReferenceIdFunctions.length > 1) {
      Logger.warn(
        "More than one createOrderReferenceId function defined. Using first one defined"
      );
    }
  }
  //console.log("referenceId ", referenceId)

  order.referenceId = referenceId;

  // Apply custom order data transformations from plugins
  const transformCustomOrderFieldsFuncs = getFunctionsOfType(
    "transformCustomOrderFields"
  );
  if (transformCustomOrderFieldsFuncs.length > 0) {
    let customFields = { ...(customFieldsFromClient || {}) };
    // We need to run each of these functions in a series, rather than in parallel, because
    // each function expects to get the result of the previous. It is recommended to disable `no-await-in-loop`
    // rules when the output of one iteration might be used as input in another iteration, such as this case here.
    // See https://eslint.org/docs/rules/no-await-in-loop#when-not-to-use-it
    for (const transformCustomOrderFieldsFunc of transformCustomOrderFieldsFuncs) {
      customFields = await transformCustomOrderFieldsFunc({
        context,
        customFields,
        order,
      }); // eslint-disable-line no-await-in-loop
    }
    order.customFields = customFields;
  } else {
    order.customFields = customFieldsFromClient;
  }
  // Validate and save

  OrderSchema.validate(order);
  const newOrder = await Orders.insertOne({
    ...order,
    paymentMethod: fulfillmentGroups?.[0]?.paymentMethod || "CASH",
  });
  const opaqueOrderId = encodeOpaqueId("reaction/order",newOrder.insertedId);
  let easyPaisaResponse;
  if (fulfillmentGroups[0].paymentMethod == "EASYPAISA") {
    // Process EasyPaisa payment non-blocking (fire and forget)
    const transactionRecordObj = {
      orderId,
      kitchenOrderID,
      accountId,
      email,
      responseCode: "NA",
      responseMessage: "NA",
      amount: payments[0].finalAmount - discountTotal,
      status: "PENDING",
      createdAt: new Date(),
      updatedAt: new Date(),
      transactionId: "NA",
      transactionDateTime: "NA",
      jazzCashNumber: jazzCashNumber
    }

    Transaction.insertOne(transactionRecordObj).then((result) => {

      doEasyPaisaPayment(kitchenOrderID, opaqueOrderId, null, payments[0].finalAmount - discountTotal, null, jazzCashNumber, email,result?.insertedId, Transaction, Orders)
        .then((response) => {
        })
        .catch((error) => {
          Logger.error("Error processing EasyPaisa payment or inserting transaction record:", error)
        });
    }).catch((error) => {
      Logger.error("Error inserting transaction record:", error)
    });
  }




  //Getting data for real time event (non-blocking)
  Orders.aggregate([
    {
      $match: {
        _id: newOrder.ops[0]?._id
      }
    },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: "RiderOrder",
        localField: "_id",
        foreignField: "OrderID",
        as: "riderOrderInfo",
      },
    },
    {
      $unwind: {
        path: "$riderOrderInfo",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "Accounts",
        localField: "riderOrderInfo.riderID",
        foreignField: "_id",
        as: "riderInfo",
      },
    },
    { $unwind: { path: "$riderInfo", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        branchObjectId: { $toObjectId: "$branchID" },
        transferFromBranchObjectId: {
          $cond: {
            if: { $ne: ["$transferFrom", null] },
            then: { $toObjectId: "$transferFrom" },
            else: "$$REMOVE",
          },
        },
      },
    },
    {
      $lookup: {
        from: "BranchData",
        localField: "branchObjectId",
        foreignField: "_id",
        as: "branchDetails",
      },
    },
    {
      $unwind: {
        path: "$branchDetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "BranchData",
        localField: "transferFromBranchObjectId",
        foreignField: "_id",
        as: "transferFromBranchDetails",
      },
    },
    {
      $addFields: {
        transferFromBranchDetails: {
          $cond: {
            if: { $eq: [{ $size: "$transferFromBranchDetails" }, 0] },
            then: null,
            else: { $arrayElemAt: ["$transferFromBranchDetails", 0] }
          }
        }
      }
    },
    {
      $addFields: {
        transferFromBranchInfo: {
          $cond: {
            if: { $ne: ["$transferFromBranchDetails", null] },
            then: {
              _id: "$transferFromBranchDetails._id",
              name: "$transferFromBranchDetails.name",
              __typename: "TransferFromBranchInfo"
            },
            else: null
          }
        }
      }
    },
    {
      $addFields: {
        isPaid: { $cond: [{ $eq: ["$paymentMethod", "EASYPAISA"] }, true, false] }, // for easyPaisa payment method, we are not marking it as paid as user pays to rider on delviery
        isGuestUser: { $cond: [{ $eq: ["$accountId", null] }, true, false] },
      },
    },
    {
      $project: {
        id: "$_id",
        _id: 1,
        startTime: "$riderOrderInfo.startTime",
        endTime: "$riderOrderInfo.endTime",
        createdAt: 1,
        updatedAt: 1,
        branchID: 1,
        placedFrom: 1,
        isPaid: 1,
        isGuestUser: 1,
        summary: {
          discountTotal: {
            amount: { $sum: "$discounts.amount" },
            __typename: "DiscountTotal",
          },
          __typename: "Summary",
        },
        payments: {
          $map: {
            input: "$payments",
            as: "payment",
            in: {
              finalAmount: "$$payment.finalAmount",
              tax: "$$payment.tax",
              totalAmount: "$$payment.totalAmount",
              billingAddress: {
                fullName: "$$payment.address.fullName",
                phone: "$$payment.address.phone",
                address1: "$$payment.address.address1",
                city: "$$payment.address.city",
                country: "$$payment.address.country",
                postal: "$$payment.address.postal",
                region: "$$payment.address.region",
              },
              __typename: "Payments",
            },
          },
        },
        email: 1,
        kitchenOrderID: 1,
        paymentMethod: 1,
        status: "$workflow.status",
        branches: "$riderOrderInfo.branches",
        username: "$riderInfo.name",
        OrderStatus: "$riderOrderInfo.OrderStatus",
        transferFromBranchDetails: 1,
        riderOrderInfo: {
          _id: "$riderOrderInfo._id",
          startTime: "$riderOrderInfo.startTime",
          endTime: "$riderOrderInfo.endTime",
          __typename: "RiderOrderInfo",
        },
        riderInfo: {
          userId: "$riderInfo.userId",
          _id: "$riderInfo._id",
          firstName: "$riderInfo.profile.firstName",
          lastName: "$riderInfo.profile.lastName",
          phone: "$riderInfo.profile.phone",
          __typename: "RiderInfo",
        },
        fulfillmentGroups: {
          $map: {
            input: "$shipping",
            as: "shippingItem",
            in: {
              selectedFulfillmentOption: {
                fulfillmentMethod: {
                  fulfillmentTypes: ["$$shippingItem.type"],
                  __typename: "FulfillmentMethod",
                },
                __typename: "FulfillmentOption",
              },
              items: {
                nodes: {
                  $map: {
                    input: "$$shippingItem.items",
                    as: "item",
                    in: {
                      _id: "$$item._id",
                      quantity: "$$item.quantity",
                      optionTitle: "$$item.optionTitle",
                      title: "$$item.title",
                      variantTitle: "$$item.variantTitle",
                      price: "$$item.price",
                      attributes: {
                        $map: {
                          input: "$$item.attributes",
                          as: "attribute",
                          in: {
                            label: "$$attribute.label",
                            value: "$$attribute.value",
                            __typename: "OrderItemAttribute",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        notes: {
          content: { $arrayElemAt: ["$notes.content", 0] },
          createdAt: { $arrayElemAt: ["$notes.createdAt", 0] },
          __typename: "Notes",
        },
        deliveryTime: 1,
        branchTimePickup: {
          branchOrderTime: "$riderOrderInfo.startTime",
          __typename: "BranchTimePickup",
        },
        customerInfo: {
          address1: { $arrayElemAt: ["$shipping.address.address1", 0] },
          __typename: "CustomerInfo",
        },
        branchInfo: {
          _id: "$branchID",
          name: "$branchDetails.name",
          __typename: "BranchInfo",
        },
        transferFromBranchInfo: 1
      },
    }
  ]).toArray()
    .then((ordersResp) => {
      if (ordersResp && ordersResp[0]) {
        pubSub.publish("ORDER_CREATED", {
          newOrder: ordersResp[0]
        });
      }
    })
    .catch((error) => {
      Logger.error("Error fetching order or publishing ORDER_CREATED event:", error);
    });

   appEvents.emit("afterOrderCreate", {
    createdBy: userId,
    order,
    orderId,
    branchID,
    branchData,
    fulfillmentGroups,
    generatedID,
  });

  return {
    orders: [order],
    // GraphQL response gets the raw token
    token: fullToken && fullToken.token,
  };
}
