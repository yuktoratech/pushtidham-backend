import {after, before, beforeEach, test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import mongoose from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import request from "supertest";
import type Stripe from "stripe";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";
import {Donation} from "../src/models/donation.js";
import {PaymentAttempt} from "../src/models/payment-attempt.js";
import type {PayPalCapture, PayPalGateway, PayPalOrder} from "../src/services/paypal-gateway.js";
import type {StripeGateway} from "../src/services/stripe-gateway.js";

const config=loadConfig({
  NODE_ENV:"test",PORT:"4000",MONGODB_URI:"mongodb://127.0.0.1/payment-safety",
  JWT_ACCESS_SECRET:randomBytes(40).toString("hex"),JWT_REFRESH_SECRET:randomBytes(40).toString("hex"),
  JWT_ACCESS_EXPIRES_IN:"15m",JWT_REFRESH_EXPIRES_IN:"7d",FRONTEND_URL:"http://localhost:3000",
  STRIPE_SECRET_KEY:"stripe_mock_disabled_payment_test_key",STRIPE_WEBHOOK_SECRET:"stripe_mock_disabled_webhook_test_secret",
  STRIPE_CHECKOUT_SUCCESS_URL:"http://localhost:3000/donation-confirmation",STRIPE_CHECKOUT_CANCEL_URL:"http://localhost:3000/checkout",
  PAYMENT_STATUS_TOKEN_SECRET:randomBytes(40).toString("hex"),STRIPE_CARD_ENABLED:"false",STRIPE_ACH_ENABLED:"false",
  STRIPE_FINANCIAL_CONNECTIONS_ENABLED:"false",PAYPAL_ENABLED:"false",PAYPAL_VENMO_ENABLED:"false",
});

class DisabledStripe implements StripeGateway {
  checkoutCalls=0; webhookChecks=0;
  async createCheckoutSession(_params:Stripe.Checkout.SessionCreateParams,_key:string):Promise<Stripe.Checkout.Session>{this.checkoutCalls++;throw new Error("provider must not be called");}
  async retrieveCheckoutSession(_id:string):Promise<Stripe.Checkout.Session>{throw new Error("provider must not be called");}
  async retrievePaymentIntent(_id:string):Promise<Stripe.PaymentIntent>{throw new Error("provider must not be called");}
  async retrieveCharge(_id:string):Promise<Stripe.Charge>{throw new Error("provider must not be called");}
  constructWebhookEvent(_body:Buffer,_signature:string,_secret:string):Stripe.Event{this.webhookChecks++;throw new Error("invalid signature");}
}

class DisabledPayPal implements PayPalGateway {
  orderCalls=0;
  async createOrder(_payload:object,_requestId:string):Promise<PayPalOrder>{this.orderCalls++;throw new Error("provider must not be called");}
  async getOrder(_orderId:string):Promise<PayPalOrder>{throw new Error("provider must not be called");}
  async captureOrder(_orderId:string,_requestId:string):Promise<PayPalOrder>{throw new Error("provider must not be called");}
  async getCapture(_captureId:string):Promise<PayPalCapture>{throw new Error("provider must not be called");}
  async verifyWebhook(_headers:Record<string,string|undefined>,_event:object):Promise<boolean>{throw new Error("provider must not be called");}
}

let replica:MongoMemoryReplSet;
let stripe:DisabledStripe;
let paypal:DisabledPayPal;
let app:ReturnType<typeof createApp>;

before(async()=>{replica=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(replica.getUri(),{dbName:"payment_safety"});await Promise.all([Donation.init(),PaymentAttempt.init()]);});
after(async()=>{await mongoose.disconnect();await replica.stop();});
beforeEach(async()=>{await Promise.all(Object.values(mongoose.connection.collections).map(collection=>collection.deleteMany({})));stripe=new DisabledStripe();paypal=new DisabledPayPal();app=createApp(config,{stripe,paypal});});

const stripeBody=()=>({donorName:"Safety Donor",donorEmail:"safety@example.test",type:"general",giving:new mongoose.Types.ObjectId().toString(),amountCents:2500,currency:"USD",methodFamily:"card",coverFees:false});
const paypalBody=()=>({donorName:"Safety Donor",donorEmail:"safety@example.test",type:"general",giving:new mongoose.Types.ObjectId().toString(),amountCents:2500,currency:"USD",coverFees:false});
const assertNoPaymentWrites=async()=>{assert.equal(await Donation.countDocuments(),0);assert.equal(await PaymentAttempt.countDocuments(),0);};

test("disabled capabilities report every online payment method as unavailable",async()=>{
  const response=await request(app).get("/api/v1/payments/capabilities");
  assert.equal(response.status,200);
  assert.deepEqual(response.body.data.stripe,{card:false,ach:false});
  assert.deepEqual(response.body.data.paypal,{enabled:false,environment:"sandbox",venmo:false});
});

test("disabled Stripe checkout is blocked before provider invocation or database writes",async()=>{
  const response=await request(app).post("/api/v1/payments/stripe/checkout-sessions").set("Idempotency-Key","disabled-stripe-checkout-key-0001").send(stripeBody());
  assert.equal(response.status,422);
  assert.equal(response.body.error.code,"PAYMENT_METHOD_UNAVAILABLE");
  assert.equal(stripe.checkoutCalls,0);
  await assertNoPaymentWrites();
});

test("disabled PayPal order creation is blocked before provider invocation or database writes",async()=>{
  const response=await request(app).post("/api/v1/payments/paypal/orders").set("Idempotency-Key","disabled-paypal-order-key-0001").send(paypalBody());
  assert.equal(response.status,503);
  assert.equal(response.body.error.code,"PAYPAL_UNAVAILABLE");
  assert.equal(paypal.orderCalls,0);
  await assertNoPaymentWrites();
});

test("disabled initiation does not bypass Stripe webhook signature validation",async()=>{
  const response=await request(app).post("/api/v1/webhooks/stripe").set("Content-Type","application/json").set("Stripe-Signature","invalid-signature").send(JSON.stringify({id:"evt_invalid"}));
  assert.equal(response.status,400);
  assert.equal(response.body.error.code,"INVALID_STRIPE_SIGNATURE");
  assert.equal(stripe.webhookChecks,1);
  assert.equal(stripe.checkoutCalls,0);
  await assertNoPaymentWrites();
});
