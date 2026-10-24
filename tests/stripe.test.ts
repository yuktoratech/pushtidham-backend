import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import type Stripe from "stripe";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { Donation } from "../src/models/donation.js";
import { Event } from "../src/models/event.js";
import { Giving } from "../src/models/giving.js";
import { PaymentAdjustment } from "../src/models/payment-adjustment.js";
import { PaymentAttempt } from "../src/models/payment-attempt.js";
import { Session } from "../src/models/session.js";
import { User } from "../src/models/user.js";
import { WebhookEvent } from "../src/models/webhook-event.js";
import type { StripeGateway } from "../src/services/stripe-gateway.js";
import { StripeReconciliationService } from "../src/services/stripe-reconciliation.js";

const config = loadConfig({
  NODE_ENV: "test",
  PORT: "4000",
  MONGODB_URI: "mongodb://127.0.0.1/test",
  JWT_ACCESS_SECRET: randomBytes(40).toString("hex"),
  JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
  FRONTEND_URL: "http://localhost:3000",
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  STRIPE_SECRET_KEY: "sk_test_mock_phase_4b_key",
  STRIPE_WEBHOOK_SECRET: "whsec_mock_phase_4b_secret",
  STRIPE_CARD_PAYMENT_METHOD_CONFIGURATION: "pmc_mockcardconfiguration",
  STRIPE_CHECKOUT_SUCCESS_URL:
    "http://localhost:3000/donation-confirmation?session_id={CHECKOUT_SESSION_ID}",
  STRIPE_CHECKOUT_CANCEL_URL: "http://localhost:3000/checkout?canceled=1",
  STRIPE_CARD_ENABLED: "true",
  PAYMENT_STATUS_TOKEN_SECRET: randomBytes(40).toString("hex"),
  STRIPE_CARD_FEE_BPS: "290",
  STRIPE_CARD_FEE_FIXED_CENTS: "30",
  STRIPE_RECONCILIATION_MIN_AGE_MINUTES: "5",
  STRIPE_RECONCILIATION_BATCH_SIZE: "10",
});

class MockStripe implements StripeGateway {
  sessions = new Map<string, Stripe.Checkout.Session>();
  intents = new Map<string, Stripe.PaymentIntent>();
  charges = new Map<string, Stripe.Charge>();
  byIdempotency = new Map<string, Stripe.Checkout.Session>();
  lastParams?: Stripe.Checkout.SessionCreateParams;
  sessionMethods?: string[];
  event?: Stripe.Event;
  createCalls = 0;

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ) {
    this.createCalls++;
    this.lastParams = params;
    const replay = this.byIdempotency.get(idempotencyKey);
    if (replay) return replay;
    const attemptId = params.metadata!.attemptId!;
    const paymentId = `pi_${attemptId}`;
    const method = params.metadata?.methodFamily === "ach" ? "us_bank_account" : "card";
    const amount = params.line_items![0]!.price_data!.unit_amount!;
    const intent = {
      id: paymentId,
      object: "payment_intent",
      amount,
      amount_received: 0,
      currency: "usd",
      status: "requires_action",
      metadata: params.payment_intent_data!.metadata!,
      latest_charge: null,
      payment_method: { id: `pm_${attemptId}`, object: "payment_method", type: method },
      last_payment_error: null,
      next_action: null,
    } as unknown as Stripe.PaymentIntent;
    this.intents.set(paymentId, intent);
    const session = {
      id: `cs_${attemptId}`,
      object: "checkout.session",
      url: `https://checkout.stripe.test/${attemptId}`,
      amount_total: amount,
      currency: "usd",
      metadata: params.metadata!,
      client_reference_id: params.client_reference_id!,
      payment_intent: paymentId,
      payment_status: "unpaid",
      status: "open",
      payment_method_types: this.sessionMethods ?? [method],
    } as unknown as Stripe.Checkout.Session;
    this.sessions.set(session.id, session);
    this.byIdempotency.set(idempotencyKey, session);
    return session;
  }

  async retrieveCheckoutSession(id: string) {
    const value = this.sessions.get(id);
    if (!value) throw new Error("missing mock session");
    return value;
  }

  async retrievePaymentIntent(id: string) {
    const value = this.intents.get(id);
    if (!value) throw new Error("missing mock intent");
    return value;
  }

  async retrieveCharge(id: string) {
    const value = this.charges.get(id);
    if (!value) throw new Error("missing mock charge");
    return value;
  }

  constructWebhookEvent(_body: Buffer, signature: string) {
    if (signature !== "valid-signature" || !this.event)
      throw new Error("invalid signature");
    return this.event;
  }
}

let replica: MongoMemoryReplSet;
let stripe: MockStripe;
let app: ReturnType<typeof createApp>;
let fixedGiving: string;
let customGiving: string;
let eventId: string;

before(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri(), { dbName: "stripe_phase_4b" });
  await Promise.all([
    User.init(),
    Session.init(),
    Giving.init(),
    Event.init(),
    Donation.init(),
    PaymentAttempt.init(),
    WebhookEvent.init(),
    PaymentAdjustment.init(),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({}),
    ),
  );
  stripe = new MockStripe();
  app = createApp(config, { stripe });
  const fixed = await Giving.create({
    title: "General Support",
    slug: "stripe-general",
    amountType: "fixed",
    fixedAmountsCents: [2500, 5000],
    status: "active",
  });
  const custom = await Giving.create({
    title: "Custom Seva",
    slug: "stripe-custom",
    amountType: "custom",
    status: "active",
  });
  const event = await Event.create({
    title: "Published historical Event",
    slug: "stripe-published-event",
    startsAt: new Date("2020-01-01T00:00:00Z"),
    location: "Haveli",
    status: "published",
  });
  fixedGiving = String(fixed._id);
  customGiving = String(custom._id);
  eventId = String(event._id);
});

const checkoutBody = (overrides: Record<string, unknown> = {}) => ({
  donorName: "Stripe Donor",
  donorEmail: "stripe@example.test",
  type: "general",
  giving: fixedGiving,
  amountCents: 2500,
  currency: "USD",
  methodFamily: "card",
  coverFees: false,
  ...overrides,
});

async function checkout(
  overrides: Record<string, unknown> = {},
  key = `stripe-checkout-${new mongoose.Types.ObjectId()}`,
  token?: string,
) {
  const call = request(app)
    .post("/api/v1/payments/stripe/checkout-sessions")
    .set("Idempotency-Key", key);
  if (token) call.set("Authorization", `Bearer ${token}`);
  return call.send(checkoutBody(overrides));
}

function setIntentStatus(
  paymentId: string,
  status: Stripe.PaymentIntent.Status,
  nextAction: Stripe.PaymentIntent.NextAction | null = null,
) {
  const intent = stripe.intents.get(paymentId)!;
  stripe.intents.set(paymentId, {
    ...intent,
    status,
    amount_received: status === "succeeded" ? intent.amount : 0,
    next_action: nextAction,
  } as Stripe.PaymentIntent);
}

async function webhook(type: Stripe.Event.Type, object: object, eventId: string) {
  stripe.event = {
    id: eventId,
    object: "event",
    type,
    data: { object },
  } as Stripe.Event;
  return request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", "valid-signature")
    .send(JSON.stringify({ id: eventId }));
}

test("checkout validates eligibility, fixed amounts, methods and idempotency headers", async () => {
  assert.equal((await checkout({}, "short")).status, 400);
  assert.equal((await checkout({ amountCents: 2600 })).status, 400);
  await Giving.updateOne({ _id: fixedGiving }, { $set: { status: "inactive" } });
  assert.equal((await checkout()).status, 404);
  assert.equal(
    (
      await checkout({
        giving: undefined,
        type: "event",
        event: new mongoose.Types.ObjectId().toString(),
      })
    ).status,
    409,
  );
});

test("guest card checkout is safe, idempotent and fee opt-in is server-calculated", async () => {
  const key = "same-guest-checkout-key-0001";
  const first = await checkout({ giving: customGiving, amountCents: 1234, coverFees: true }, key);
  assert.equal(first.status, 201);
  assert.ok(first.body.data.statusToken);
  assert.equal(first.body.data.baseDonationCents, 1234);
  assert.equal(first.body.data.feeContributionCents, 68);
  const second = await checkout({ giving: customGiving, amountCents: 1234, coverFees: true }, key);
  assert.equal(second.status, 201);
  assert.equal(second.body.data.attemptId, first.body.data.attemptId);
  assert.equal(second.body.data.statusToken, first.body.data.statusToken);
  assert.equal(await Donation.countDocuments(), 1);
  assert.equal(await PaymentAttempt.countDocuments(), 1);
  const status = await request(app)
    .get(`/api/v1/payments/attempts/${first.body.data.attemptId}/status`)
    .set("X-Payment-Status-Token", first.body.data.statusToken);
  assert.equal(status.status, 200);
  assert.equal(status.body.data.donorEmailSnapshot, undefined);
});

test("Checkout uses the selected Dashboard payment configuration instead of deprecated payment_method_types", async () => {
  const card = await checkout();
  assert.equal(card.status, 201);
  assert.equal(stripe.lastParams?.payment_method_configuration, "pmc_mockcardconfiguration");
  assert.deepEqual(stripe.lastParams?.adaptive_pricing, { enabled: false });
  assert.equal("payment_method_types" in (stripe.lastParams ?? {}), false);
  assert.equal(stripe.createCalls, 1);
});

test("Checkout refuses a provider session that exposes another payment method", async () => {
  stripe.sessionMethods = ["card", "link"];
  const response = await checkout({}, "card-only-session-guard-key-0001");
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, "STRIPE_SESSION_MISMATCH");
  assert.equal(stripe.lastParams?.payment_method_configuration, "pmc_mockcardconfiguration");
  assert.equal(await PaymentAttempt.countDocuments(), 1);
  assert.equal((await Donation.findOne())?.status, "pending");
});

test("informational Events cannot start online Stripe checkout", async () => {
  const created = await checkout({
    type: "event",
    giving: undefined,
    event: eventId,
    amountCents: 4321,
    coverFees: false,
  });
  assert.equal(created.status, 409);
  assert.equal(created.body.error.code, "EVENT_DONATIONS_DISABLED");
  assert.equal(await Donation.countDocuments(), 0);
  assert.equal(await PaymentAttempt.countDocuments(), 0);
  assert.equal(stripe.createCalls, 0);
});

test("authenticated donor checkout owns history without email matching", async () => {
  const password = "Phase4B-Donor-Password!";
  const registered = await request(app).post("/api/v1/auth/register").send({
    name: "Authenticated Donor",
    email: "owner@example.test",
    password,
  });
  assert.equal(registered.status, 201);
  const created = await checkout(
    { donorEmail: "different-contact@example.test" },
    "authenticated-checkout-key-0001",
    registered.body.data.accessToken,
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.data.statusToken, undefined);
  const donation = await Donation.findOne();
  assert.equal(String(donation?.user), registered.body.data.user.id);
});

test("concurrent checkout initiation creates one Donation and one provider session identity", async () => {
  const key = "concurrent-stripe-checkout-0001";
  const results = await Promise.all([checkout({}, key), checkout({}, key)]);
  assert.ok(results.every((response) => response.status === 201));
  assert.equal(new Set(results.map((response) => response.body.data.attemptId)).size, 1);
  assert.equal(await Donation.countDocuments(), 1);
  assert.equal(await PaymentAttempt.countDocuments(), 1);
  assert.equal(stripe.byIdempotency.size, 1);
});

test("invalid Stripe signatures are rejected before event processing", async () => {
  const response = await request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", "invalid")
    .send("{}");
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "INVALID_STRIPE_SIGNATURE");
  assert.equal(await WebhookEvent.countDocuments(), 0);
});

test("card webhooks complete only verified payments and deduplicate delivery", async () => {
  const created = await checkout();
  const attempt = await PaymentAttempt.findById(created.body.data.attemptId);
  setIntentStatus(attempt!.paymentId!, "succeeded");
  const intent = stripe.intents.get(attempt!.paymentId!)!;
  const first = await webhook("payment_intent.succeeded", intent, "evt_card_success");
  assert.equal(first.status, 200);
  assert.equal((await Donation.findById(attempt!.donation))?.status, "completed");
  const duplicate = await webhook("payment_intent.succeeded", intent, "evt_card_success");
  assert.equal(duplicate.status, 200);
  assert.equal(await WebhookEvent.countDocuments({ eventId: "evt_card_success" }), 1);
  setIntentStatus(attempt!.paymentId!, "processing");
  await webhook(
    "payment_intent.processing",
    stripe.intents.get(attempt!.paymentId!)!,
    "evt_late_processing",
  );
  assert.equal((await PaymentAttempt.findById(attempt!._id))?.status, "succeeded");
});

test("card failure and authoritative amount mismatches never complete a donation", async () => {
  const failed = await checkout({}, "card-failure-checkout-key-0001");
  const failedAttempt = await PaymentAttempt.findById(failed.body.data.attemptId);
  setIntentStatus(failedAttempt!.paymentId!, "requires_payment_method");
  const failedResponse = await webhook(
    "payment_intent.payment_failed",
    stripe.intents.get(failedAttempt!.paymentId!)!,
    "evt_card_failure",
  );
  assert.equal(failedResponse.status, 200);
  assert.equal((await PaymentAttempt.findById(failedAttempt!._id))?.status, "failed");
  assert.equal((await Donation.findById(failedAttempt!.donation))?.status, "pending");

  const mismatched = await checkout({}, "amount-mismatch-checkout-key-0001");
  const mismatchedAttempt = await PaymentAttempt.findById(mismatched.body.data.attemptId);
  const intent = stripe.intents.get(mismatchedAttempt!.paymentId!)!;
  stripe.intents.set(intent.id, {
    ...intent,
    amount: intent.amount + 1,
    status: "succeeded",
    amount_received: intent.amount + 1,
  } as Stripe.PaymentIntent);
  const mismatchResponse = await webhook(
    "payment_intent.succeeded",
    stripe.intents.get(intent.id)!,
    "evt_amount_mismatch",
  );
  assert.equal(mismatchResponse.status, 409);
  assert.equal(mismatchResponse.body.error.code, "STRIPE_METADATA_MISMATCH");
  assert.equal((await Donation.findById(mismatchedAttempt!.donation))?.status, "pending");
});

test("a trusted Stripe payment-method mismatch never completes the selected donation", async () => {
  const created = await checkout({}, "card-method-mismatch-key-0001");
  const attempt = await PaymentAttempt.findById(created.body.data.attemptId);
  const intent = stripe.intents.get(attempt!.paymentId!)!;
  stripe.intents.set(intent.id, {
    ...intent,
    status: "succeeded",
    amount_received: intent.amount,
    payment_method: { id: "pm_bank_mismatch", object: "payment_method", type: "us_bank_account" },
  } as Stripe.PaymentIntent);
  const response = await webhook(
    "payment_intent.succeeded",
    stripe.intents.get(intent.id)!,
    "evt_method_mismatch",
  );
  assert.equal(response.status, 200);
  assert.equal((await PaymentAttempt.findById(attempt!._id))?.status, "failed");
  assert.equal((await Donation.findById(attempt!.donation))?.status, "pending");
});

test("a trusted unsupported dynamic Stripe method never completes a donation", async () => {
  const created = await checkout({}, "unsupported-method-key-0001");
  const attempt = await PaymentAttempt.findById(created.body.data.attemptId);
  const intent = stripe.intents.get(attempt!.paymentId!)!;
  stripe.intents.set(intent.id, {
    ...intent,
    status: "succeeded",
    amount_received: intent.amount,
    payment_method: { id: "pm_unsupported", object: "payment_method", type: "klarna" },
  } as Stripe.PaymentIntent);
  const response = await webhook(
    "payment_intent.succeeded",
    stripe.intents.get(intent.id)!,
    "evt_unsupported_method",
  );
  assert.equal(response.status, 200);
  assert.equal((await PaymentAttempt.findById(attempt!._id))?.status, "failed");
  assert.equal((await Donation.findById(attempt!.donation))?.status, "pending");
});

test("verified canceled intent is idempotent and cannot undo a completed donation", async () => {
  const canceled = await checkout({}, "card-canceled-checkout-key-0001");
  const attempt = await PaymentAttempt.findById(canceled.body.data.attemptId);
  setIntentStatus(attempt!.paymentId!, "canceled");
  const intent = stripe.intents.get(attempt!.paymentId!)!;
  assert.equal((await webhook("payment_intent.canceled", intent, "evt_card_canceled")).status, 200);
  assert.equal((await PaymentAttempt.findById(attempt!._id))?.status, "canceled");
  assert.equal((await Donation.findById(attempt!.donation))?.status, "pending");
  assert.equal((await webhook("payment_intent.canceled", intent, "evt_card_canceled")).status, 200);
  assert.equal(await WebhookEvent.countDocuments({eventId: "evt_card_canceled"}), 1);

  const paid = await checkout({}, "card-paid-then-canceled-key-0001");
  const paidAttempt = await PaymentAttempt.findById(paid.body.data.attemptId);
  setIntentStatus(paidAttempt!.paymentId!, "succeeded");
  await webhook("payment_intent.succeeded", stripe.intents.get(paidAttempt!.paymentId!)!, "evt_paid_before_cancel");
  setIntentStatus(paidAttempt!.paymentId!, "canceled");
  await webhook("payment_intent.canceled", stripe.intents.get(paidAttempt!.paymentId!)!, "evt_late_cancel");
  assert.equal((await PaymentAttempt.findById(paidAttempt!._id))?.status, "succeeded");
  assert.equal((await Donation.findById(paidAttempt!.donation))?.status, "completed");
});

test("reconciliation applies missing success without retrying or creating a charge", async () => {
  const created = await checkout();
  const attempt = await PaymentAttempt.findById(created.body.data.attemptId);
  const session = stripe.sessions.get(attempt!.checkoutSessionId!)!;
  setIntentStatus(attempt!.paymentId!, "succeeded");
  stripe.sessions.set(session.id, {
    ...session,
    status: "complete",
    payment_status: "paid",
  } as Stripe.Checkout.Session);
  await PaymentAttempt.updateOne(
    { _id: attempt!._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } },
    { timestamps: false },
  );
  const createsBefore = stripe.createCalls;
  const summary = await new StripeReconciliationService(config, stripe).run();
  assert.deepEqual(summary, { scanned: 1, processed: 1, failed: 0 });
  assert.equal(stripe.createCalls, createsBefore);
  assert.equal((await Donation.findById(attempt!.donation))?.status, "completed");
});

test("verified card refunds, disputes and reversals are durable and deduplicated", async () => {
  const card = await checkout({}, "adjustment-card-checkout-key-0001");
  const cardAttempt = await PaymentAttempt.findById(card.body.data.attemptId);
  setIntentStatus(cardAttempt!.paymentId!, "succeeded");
  const cardIntent = stripe.intents.get(cardAttempt!.paymentId!)!;
  await webhook("payment_intent.succeeded", cardIntent, "evt_adjustment_card_success");
  const cardCharge = {
    id: "ch_card_adjustments",
    object: "charge",
    payment_intent: cardIntent.id,
    refunds: {
      object: "list",
      data: [
        {
          id: "re_partial_1",
          object: "refund",
          amount: 500,
          status: "succeeded",
          created: Math.floor(Date.now() / 1000),
        },
      ],
      has_more: false,
      url: "/v1/refunds",
    },
  } as unknown as Stripe.Charge;
  stripe.charges.set(cardCharge.id, cardCharge);
  assert.equal(
    (await webhook("charge.refunded", cardCharge, "evt_partial_refund")).status,
    200,
  );
  await webhook("charge.refunded", cardCharge, "evt_partial_refund");
  assert.equal(await PaymentAdjustment.countDocuments({ type: "refund" }), 1);

  const dispute = {
    id: "dp_card_1",
    object: "dispute",
    charge: cardCharge.id,
    amount: 700,
    status: "needs_response",
    reason: "general",
    created: Math.floor(Date.now() / 1000),
  } as unknown as Stripe.Dispute;
  assert.equal(
    (await webhook("charge.dispute.created", dispute, "evt_dispute_created")).status,
    200,
  );
  dispute.status = "won";
  assert.equal(
    (await webhook("charge.dispute.closed", dispute, "evt_dispute_won")).status,
    200,
  );
  assert.equal(await PaymentAdjustment.countDocuments({ type: "dispute" }), 1);
  assert.equal(await PaymentAdjustment.countDocuments({ type: "reversal" }), 1);
});
