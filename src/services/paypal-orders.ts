import { createHash, createHmac } from "node:crypto";
import type { Types } from "mongoose";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { PayPalOrderInput } from "../validators/payments.js";
import { resolveDonationDesignation } from "./donation-eligibility.js";
import { PaymentService } from "./payments.js";
import type { PayPalGateway, PayPalOrder } from "./paypal-gateway.js";
import type { FeePolicy } from "./payment-fees.js";

const dollars = (cents: number) => (cents / 100).toFixed(2);
function policy(config: Config): FeePolicy | undefined {
  if (config.PAYPAL_FEE_BPS === undefined || config.PAYPAL_FEE_FIXED_CENTS === undefined) return undefined;
  return { enabled: true, percentageBasisPoints: config.PAYPAL_FEE_BPS, fixedCents: config.PAYPAL_FEE_FIXED_CENTS };
}
function approval(order: PayPalOrder) {
  const url = order.links?.find((link) => link.rel === "approve" || link.rel === "payer-action")?.href;
  if (!url || !url.startsWith("https://")) throw new AppError(502, "PAYPAL_ORDER_MISMATCH", "PayPal order has no safe approval URL");
  return url;
}

export class PayPalOrderService {
  constructor(private readonly config: Config, private readonly paypal: PayPalGateway, private readonly payments = new PaymentService()) {}
  async create(input: PayPalOrderInput, key: string, actorId?: Types.ObjectId) {
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Provide a 16 to 200 character Idempotency-Key header");
    if (!this.config.PAYPAL_ENABLED || !this.config.PAYPAL_MERCHANT_ID || !this.config.PAYMENT_STATUS_TOKEN_SECRET)
      throw new AppError(503, "PAYPAL_UNAVAILABLE", "PayPal checkout is not configured");
    const designation = await resolveDonationDesignation(input);
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, donorPhone: input.donorPhone ?? "" })).digest("hex");
    const token = actorId ? undefined : createHmac("sha256", this.config.PAYMENT_STATUS_TOKEN_SECRET).update(`paypal:${key}:${fingerprint}`).digest("base64url");
    const prepared = await this.payments.prepareNewPayPalDonationAttempt({
      ...input, designationTitle: designation.title, idempotencyKey: key, requestFingerprint: fingerprint,
      feePolicy: policy(this.config), actorId, guestStatusToken: token,
    });
    const attempt = prepared.attempt;
    if (attempt.orderId) {
      const order = await this.paypal.getOrder(attempt.orderId);
      return this.response(order, attempt, prepared.statusToken);
    }
    const order = await this.paypal.createOrder({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: String(attempt._id), custom_id: String(prepared.donation._id),
        amount: { currency_code: "USD", value: dollars(attempt.totalChargeCents) },
        payee: { merchant_id: this.config.PAYPAL_MERCHANT_ID },
        description: `Donation ${prepared.donation.donationNumber}` }],
      application_context: { return_url: this.config.PAYPAL_RETURN_URL, cancel_url: this.config.PAYPAL_CANCEL_URL },
    }, `pushtidham:${key}`);
    this.assertOrder(order, attempt, String(prepared.donation._id));
    await this.payments.bindPayPalOrder(String(attempt._id), order.id);
    return this.response(order, attempt, prepared.statusToken);
  }
  private response(order: PayPalOrder, attempt: { _id: unknown; baseDonationCents: number; feeContributionCents: number; totalChargeCents: number }, statusToken?: string) {
    return { orderId: order.id, approvalUrl: approval(order), attemptId: String(attempt._id), status: "requires_action", baseDonationCents: attempt.baseDonationCents, feeContributionCents: attempt.feeContributionCents, totalChargeCents: attempt.totalChargeCents, currency: "USD" as const, ...(statusToken ? { statusToken } : {}) };
  }
  assertOrder(order: PayPalOrder, attempt: { _id: unknown; totalChargeCents: number }, donationId: string) {
    const unit = order.purchase_units[0];
    if (!unit || order.intent !== "CAPTURE" || unit.reference_id !== String(attempt._id) || unit.custom_id !== donationId || unit.amount.currency_code !== "USD" || Math.round(Number(unit.amount.value) * 100) !== attempt.totalChargeCents || (unit.payee?.merchant_id && unit.payee.merchant_id !== this.config.PAYPAL_MERCHANT_ID))
      throw new AppError(502, "PAYPAL_ORDER_MISMATCH", "PayPal order does not match the prepared donation");
  }
}
