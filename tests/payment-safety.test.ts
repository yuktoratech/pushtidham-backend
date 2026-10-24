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
import type {StripeGateway} from "../src/services/stripe-gateway.js";

const config=loadConfig({
  NODE_ENV:"test",PORT:"4000",MONGODB_URI:"mongodb://127.0.0.1/payment-safety",
  JWT_ACCESS_SECRET:randomBytes(40).toString("hex"),JWT_REFRESH_SECRET:randomBytes(40).toString("hex"),
  JWT_ACCESS_EXPIRES_IN:"15m",JWT_REFRESH_EXPIRES_IN:"7d",FRONTEND_URL:"http://localhost:3000",
  STRIPE_SECRET_KEY:"stripe_mock_disabled_payment_test_key",STRIPE_WEBHOOK_SECRET:"stripe_mock_disabled_webhook_test_secret",
  STRIPE_CHECKOUT_SUCCESS_URL:"http://localhost:3000/donation-confirmation",STRIPE_CHECKOUT_CANCEL_URL:"http://localhost:3000/checkout",
  PAYMENT_STATUS_TOKEN_SECRET:randomBytes(40).toString("hex"),STRIPE_CARD_ENABLED:"false",
});

class DisabledStripe implements StripeGateway {
  checkoutCalls=0; webhookChecks=0;
  async createCheckoutSession(_params:Stripe.Checkout.SessionCreateParams,_key:string):Promise<Stripe.Checkout.Session>{this.checkoutCalls++;throw new Error("provider must not be called");}
  async retrieveCheckoutSession(_id:string):Promise<Stripe.Checkout.Session>{throw new Error("provider must not be called");}
  async retrievePaymentIntent(_id:string):Promise<Stripe.PaymentIntent>{throw new Error("provider must not be called");}
  async retrieveCharge(_id:string):Promise<Stripe.Charge>{throw new Error("provider must not be called");}
  constructWebhookEvent(_body:Buffer,_signature:string,_secret:string):Stripe.Event{this.webhookChecks++;throw new Error("invalid signature");}
}


let replica:MongoMemoryReplSet;
let stripe:DisabledStripe;
let app:ReturnType<typeof createApp>;

before(async()=>{replica=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(replica.getUri(),{dbName:"payment_safety"});await Promise.all([Donation.init(),PaymentAttempt.init()]);});
after(async()=>{await mongoose.disconnect();await replica.stop();});
beforeEach(async()=>{await Promise.all(Object.values(mongoose.connection.collections).map(collection=>collection.deleteMany({})));stripe=new DisabledStripe();app=createApp(config,{stripe});});

const stripeBody=()=>({donorName:"Safety Donor",donorEmail:"safety@example.test",type:"general",giving:new mongoose.Types.ObjectId().toString(),amountCents:2500,currency:"USD",methodFamily:"card",coverFees:false});
const assertNoPaymentWrites=async()=>{assert.equal(await Donation.countDocuments(),0);assert.equal(await PaymentAttempt.countDocuments(),0);};

test("disabled capabilities report card unavailable",async()=>{
  const response=await request(app).get("/api/v1/payments/capabilities");
  assert.equal(response.status,200);
  assert.deepEqual(response.body.data,{stripe:{card:false}});
});

test("disabled Stripe checkout is blocked before provider invocation or database writes",async()=>{
  const response=await request(app).post("/api/v1/payments/stripe/checkout-sessions").set("Idempotency-Key","disabled-stripe-checkout-key-0001").send(stripeBody());
  assert.equal(response.status,422);
  assert.equal(response.body.error.code,"PAYMENT_METHOD_UNAVAILABLE");
  assert.equal(stripe.checkoutCalls,0);
  await assertNoPaymentWrites();
});

test("retired public payment routes cannot create donations or payment attempts",async()=>{
  for(const path of ["/api/v1/payments/paypal/orders","/api/v1/payments/paypal/orders/example/capture","/api/v1/donations"]){
    const response=await request(app).post(path).send(stripeBody());
    assert.equal(response.status,404);
  }
  assert.equal((await request(app).post("/api/v1/webhooks/paypal").send({})).status,404);
  await assertNoPaymentWrites();
});

test("ACH is rejected by the Card-only schema before provider invocation or database writes",async()=>{
  const response=await request(app).post("/api/v1/payments/stripe/checkout-sessions").set("Idempotency-Key","disabled-stripe-ach-key-0001").send({...stripeBody(),methodFamily:"ach"});
  assert.equal(response.status,400);
  assert.equal(stripe.checkoutCalls,0);
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
