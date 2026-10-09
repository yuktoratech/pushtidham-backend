import { createHash } from "node:crypto";
import { PaymentAttempt } from "../models/payment-attempt.js";
import { AppError, missing } from "../utils/errors.js";
import type { PayPalCapture, PayPalGateway, PayPalOrder } from "./paypal-gateway.js";
import { PaymentService } from "./payments.js";
import { VerifiedProviderEvent, type VerifiedProviderEventInput } from "./verified-provider-event.js";

const cents = (value: string) => Math.round(Number(value) * 100);
const status = (value: string): VerifiedProviderEventInput["status"] =>
  value === "COMPLETED" ? "succeeded" : value === "PENDING" ? "processing" : value === "DENIED" || value === "FAILED" || value === "DECLINED" ? "failed" : "requires_action";

export class PayPalEventService {
  constructor(private readonly paypal: PayPalGateway, private readonly merchantId: string, private readonly payments = new PaymentService()) {}
  async applyOrder(order: PayPalOrder, eventId: string, eventType: string, digest: string) {
    const unit = order.purchase_units[0];
    if (!unit?.reference_id || !unit.custom_id || unit.amount.currency_code !== "USD") throw new AppError(409, "PAYPAL_METADATA_MISMATCH", "PayPal order is missing required references");
    const attempt = await PaymentAttempt.findById(unit.reference_id);
    if (!attempt || attempt.provider !== "paypal" || String(attempt.donation) !== unit.custom_id || attempt.orderId !== order.id || cents(unit.amount.value) !== attempt.totalChargeCents || (unit.payee?.merchant_id && unit.payee.merchant_id !== this.merchantId))
      throw new AppError(409, "PAYMENT_VERIFICATION_MISMATCH", "PayPal order does not match the payment attempt");
    const capture = unit.payments?.captures?.[0];
    if (!capture)
      return this.payments.applyVerifiedEvent(VerifiedProviderEvent.fromVerifiedAdapter({
        provider: "paypal", eventId, eventType, payloadDigest: digest, attemptId: String(attempt._id), donationId: String(attempt.donation), currency: "USD",
        baseDonationCents: attempt.baseDonationCents, feeContributionCents: attempt.feeContributionCents, totalChargeCents: attempt.totalChargeCents,
        status: status(order.status), providerReference: { field: "orderId", value: order.id },
      }));
    return this.applyCapture(capture, order, eventId, eventType, digest);
  }
  async applyCapture(capture: PayPalCapture, order: PayPalOrder, eventId: string, eventType: string, digest: string) {
    const unit = order.purchase_units[0];
    if (!unit?.reference_id || !unit.custom_id || capture.amount.currency_code !== "USD" || cents(capture.amount.value) !== cents(unit.amount.value) || (capture.payee?.merchant_id && capture.payee.merchant_id !== this.merchantId))
      throw new AppError(409, "PAYMENT_VERIFICATION_MISMATCH", "PayPal capture does not match order");
    const attempt = await PaymentAttempt.findById(unit.reference_id);
    if (!attempt || attempt.provider !== "paypal" || attempt.orderId !== order.id || String(attempt.donation) !== unit.custom_id) missing("PayPal payment attempt");
    await this.payments.bindPayPalCapture(String(attempt._id), capture.id, order.payment_source?.venmo ? "venmo" : "paypal");
    const fee = capture.seller_receivable_breakdown?.paypal_fee;
    return this.payments.applyVerifiedEvent(VerifiedProviderEvent.fromVerifiedAdapter({
      provider: "paypal", eventId, eventType, payloadDigest: digest, attemptId: String(attempt._id), donationId: String(attempt.donation), currency: "USD",
      baseDonationCents: attempt.baseDonationCents, feeContributionCents: attempt.feeContributionCents, totalChargeCents: attempt.totalChargeCents,
      status: status(capture.status), providerReference: { field: "captureId", value: capture.id },
      ...(fee?.currency_code === "USD" ? { actualProviderFeeCents: cents(fee.value) } : {}),
    }));
  }
  async process(event: { id: string; event_type: string; resource: Record<string, unknown> }, digest: string) {
    if (event.event_type === "CHECKOUT.ORDER.APPROVED") return this.applyOrder(await this.paypal.getOrder(String(event.resource.id)), event.id, event.event_type, digest);
    if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") return this.applyRefund(event.resource, event.id, event.event_type, digest);
    if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) return this.applyDispute(event.resource, event.id, event.event_type, digest);
    if (event.event_type.startsWith("PAYMENT.CAPTURE.")) {
      const capture = await this.paypal.getCapture(String(event.resource.id));
      const orderId = capture.supplementary_data?.related_ids?.order_id;
      if (!orderId) throw new AppError(409, "PAYPAL_METADATA_MISMATCH", "PayPal capture has no order reference");
      const order = await this.paypal.getOrder(orderId);
      return this.applyCapture(capture, order, event.id, event.event_type, digest);
    }
    return { ignored: true };
  }
  private async applyRefund(resource: Record<string, unknown>, eventId: string, eventType: string, digest: string) {
    const related = resource.supplementary_data as { related_ids?: { capture_id?: string } } | undefined;
    const captureId = related?.related_ids?.capture_id;
    const amount = resource.amount as { currency_code?: string; value?: string } | undefined;
    if (!captureId || !amount?.value || amount.currency_code !== "USD" || typeof resource.id !== "string")
      throw new AppError(409, "PAYPAL_METADATA_MISMATCH", "PayPal refund has no verified capture reference");
    const capture = await this.paypal.getCapture(captureId);
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (!orderId) throw new AppError(409, "PAYPAL_METADATA_MISMATCH", "PayPal capture has no order reference");
    const order = await this.paypal.getOrder(orderId);
    const unit = order.purchase_units[0];
    const attempt = unit?.reference_id ? await PaymentAttempt.findById(unit.reference_id) : undefined;
    if (!attempt || attempt.captureId !== captureId || !unit?.custom_id) throw new AppError(409, "PAYMENT_VERIFICATION_MISMATCH", "PayPal refund does not match payment attempt");
    return this.payments.applyVerifiedEvent(VerifiedProviderEvent.fromVerifiedAdapter({
      provider: "paypal", eventId, eventType, payloadDigest: digest, attemptId: String(attempt._id), donationId: String(attempt.donation), currency: "USD",
      baseDonationCents: attempt.baseDonationCents, feeContributionCents: attempt.feeContributionCents, totalChargeCents: attempt.totalChargeCents,
      status: "succeeded", providerReference: { field: "captureId", value: captureId },
      adjustment: { type: "refund", status: resource.status === "COMPLETED" ? "succeeded" : resource.status === "FAILED" ? "failed" : "pending", amountCents: cents(amount.value), providerReference: resource.id, occurredAt: new Date() },
    }));
  }
  private async applyDispute(resource: Record<string, unknown>, eventId: string, eventType: string, digest: string) {
    const transactions = resource.disputed_transactions as Array<{ seller_transaction_id?: string }> | undefined;
    const captureId = transactions?.[0]?.seller_transaction_id;
    const amount = (resource.disputed_amount ?? resource.amount) as { currency_code?: string; value?: string } | undefined;
    const disputeId = typeof resource.dispute_id === "string" ? resource.dispute_id : typeof resource.id === "string" ? resource.id : undefined;
    if (!captureId || !amount?.value || amount.currency_code !== "USD" || !disputeId)
      throw new AppError(409, "PAYPAL_METADATA_MISMATCH", "PayPal dispute has no verified capture reference");
    const capture = await this.paypal.getCapture(captureId);
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (!orderId) throw new AppError(409, "PAYPAL_METADATA_MISMATCH", "PayPal capture has no order reference");
    const order = await this.paypal.getOrder(orderId);
    const unit = order.purchase_units[0];
    const attempt = unit?.reference_id ? await PaymentAttempt.findById(unit.reference_id) : undefined;
    if (!attempt || attempt.captureId !== captureId || !unit?.custom_id) throw new AppError(409, "PAYMENT_VERIFICATION_MISMATCH", "PayPal dispute does not match payment attempt");
    const providerStatus = String(resource.status ?? "");
    const adjustmentStatus = providerStatus.includes("BUYER_FAVOR") || providerStatus === "LOST" ? "succeeded" : providerStatus.includes("SELLER_FAVOR") || providerStatus === "WON" ? "failed" : "pending";
    return this.payments.applyVerifiedEvent(VerifiedProviderEvent.fromVerifiedAdapter({
      provider: "paypal", eventId, eventType, payloadDigest: digest, attemptId: String(attempt._id), donationId: String(attempt.donation), currency: "USD",
      baseDonationCents: attempt.baseDonationCents, feeContributionCents: attempt.feeContributionCents, totalChargeCents: attempt.totalChargeCents,
      status: "succeeded", providerReference: { field: "captureId", value: captureId },
      adjustment: { type: "dispute", status: adjustmentStatus, amountCents: cents(amount.value), providerReference: disputeId, reasonCode: typeof resource.reason === "string" ? resource.reason : undefined, occurredAt: new Date() },
    }));
  }
  digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
}
