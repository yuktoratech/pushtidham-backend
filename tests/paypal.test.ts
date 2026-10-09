import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { Donation } from "../src/models/donation.js";
import { Giving } from "../src/models/giving.js";
import { PaymentAttempt } from "../src/models/payment-attempt.js";
import { PaymentAdjustment } from "../src/models/payment-adjustment.js";
import { WebhookEvent } from "../src/models/webhook-event.js";
import type { PayPalCapture, PayPalGateway, PayPalOrder } from "../src/services/paypal-gateway.js";
import { PayPalReconciliationService } from "../src/services/paypal-reconciliation.js";

const config = loadConfig({ NODE_ENV: "test", PORT: "4000", MONGODB_URI: "mongodb://127.0.0.1/test", JWT_ACCESS_SECRET: randomBytes(40).toString("hex"), JWT_REFRESH_SECRET: randomBytes(40).toString("hex"), FRONTEND_URL: "http://localhost:3000", JWT_ACCESS_EXPIRES_IN: "15m", JWT_REFRESH_EXPIRES_IN: "7d", PAYMENT_STATUS_TOKEN_SECRET: randomBytes(40).toString("hex"), PAYPAL_ENABLED: "true", PAYPAL_CLIENT_ID: "paypal_test_client_id_12345", PAYPAL_CLIENT_SECRET: "paypal_test_client_secret_12345", PAYPAL_WEBHOOK_ID: "paypal_webhook_test_identifier", PAYPAL_MERCHANT_ID: "MERCHANT-TEST", PAYPAL_RETURN_URL: "http://localhost:3000/success", PAYPAL_CANCEL_URL: "http://localhost:3000/cancel", PAYPAL_FEE_BPS: "290", PAYPAL_FEE_FIXED_CENTS: "30" });

class MockPayPal implements PayPalGateway {
  orders = new Map<string, PayPalOrder>(); captures = new Map<string, PayPalCapture>(); creates = 0; verified = true;
  async createOrder(payload: { purchase_units: PayPalOrder["purchase_units"] }, key: string) { this.creates++; const existing = this.orders.get(key); if (existing) return existing; const unit = payload.purchase_units[0]!; const order = { id: `ORDER-${key.replaceAll(/[^A-Za-z0-9-]/g, "-")}`, status: "CREATED", intent: "CAPTURE", purchase_units: [unit], links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=x" }] } as PayPalOrder; this.orders.set(key, order); this.orders.set(order.id, order); return order; }
  async getOrder(id: string) { const order = this.orders.get(id); if (!order) throw new Error("missing order"); return order; }
  async captureOrder(id: string) { const order = await this.getOrder(id); const capture = { id: `CAPTURE-${id}`, status: "COMPLETED", amount: order.purchase_units[0]!.amount, supplementary_data: { related_ids: { order_id: id } }, payee: { merchant_id: "MERCHANT-TEST" }, seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "0.75" } } } as PayPalCapture; this.captures.set(capture.id, capture); const complete = { ...order, status: "COMPLETED", purchase_units: [{ ...order.purchase_units[0]!, payments: { captures: [capture] } }] }; this.orders.set(id, complete); return complete; }
  async getCapture(id: string) { const capture = this.captures.get(id); if (!capture) throw new Error("missing capture"); return capture; }
  async verifyWebhook() { return this.verified; }
}
let replica: MongoMemoryReplSet; let paypal: MockPayPal; let app: ReturnType<typeof createApp>; let giving: string;
before(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri()); await Promise.all([Giving.init(), Donation.init(), PaymentAttempt.init(), WebhookEvent.init(), PaymentAdjustment.init()]); });
after(async () => { await mongoose.disconnect(); await replica.stop(); });
beforeEach(async () => { await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({}))); paypal = new MockPayPal(); app = createApp(config, { paypal }); const record = await Giving.create({ title: "General Support", slug: "paypal-general", amountType: "fixed", fixedAmountsCents: [2500], status: "active" }); giving = String(record._id); });
const body = () => ({ donorName: "PayPal Donor", donorEmail: "paypal@example.test", type: "general", giving, amountCents: 2500, currency: "USD", coverFees: true });
async function order(key = "paypal-idempotency-key-0001") { return request(app).post("/api/v1/payments/paypal/orders").set("Idempotency-Key", key).send(body()); }

test("guest order creation is server-validated, idempotent, and does not complete a donation", async () => {
  const first = await order(); assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(first.body.data.feeContributionCents, 106); assert.ok(first.body.data.statusToken);
  const repeat = await order(); assert.equal(repeat.status, 201); assert.equal(repeat.body.data.orderId, first.body.data.orderId); assert.equal(await Donation.countDocuments(), 1); assert.equal((await Donation.findOne())?.status, "pending");
  assert.equal((await order("paypal-idempotency-key-0001",)).status, 201);
});

test("public capabilities expose only browser-safe provider configuration", async () => {
  const response = await request(app).get("/api/v1/payments/capabilities");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.paypal, {
    enabled: true,
    clientId: "paypal_test_client_id_12345",
    environment: "sandbox",
    venmo: false,
  });
  assert.deepEqual(response.body.data.stripe, { card: false, ach: false });
  assert.equal(JSON.stringify(response.body).includes("secret"), false);
  assert.equal(JSON.stringify(response.body).includes("webhook"), false);
});

test("capture requires an unguessable guest grant and authoritative approval", async () => {
  const created = await order("paypal-capture-key-0001"); const orderId = created.body.data.orderId;
  const forbidden = await request(app).post(`/api/v1/payments/paypal/orders/${orderId}/capture`).send({}); assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  paypal.orders.set(orderId, { ...(await paypal.getOrder(orderId)), status: "APPROVED" });
  const captured = await request(app).post(`/api/v1/payments/paypal/orders/${orderId}/capture`).set("X-Payment-Status-Token", created.body.data.statusToken).send({});
  assert.equal(captured.status, 200); assert.equal((await Donation.findOne())?.status, "completed");
  assert.equal((await PaymentAttempt.findOne())?.actualProviderFeeCents, 75);
});

test("webhooks reject failed authenticity and reconciliation applies an approved missing capture", async () => {
  paypal.verified = false;
  const rejected = await request(app).post("/api/v1/webhooks/paypal").set("Content-Type", "application/json").send(JSON.stringify({ id: "WH-1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "none" } }));
  assert.equal(rejected.status, 400);
  const created = await order("paypal-reconcile-key-0001"); const attempt = await PaymentAttempt.findOne(); const orderId = created.body.data.orderId;
  paypal.orders.set(orderId, { ...(await paypal.getOrder(orderId)), status: "APPROVED" });
  await PaymentAttempt.updateOne({ _id: attempt!._id }, { $set: { updatedAt: new Date(Date.now() - 7_200_000) } }, { timestamps: false });
  paypal.verified = true;
  const result = await new PayPalReconciliationService(config, paypal).run(); assert.deepEqual(result, { scanned: 1, processed: 1, failed: 0 });
  assert.equal((await Donation.findOne())?.status, "pending");
});
