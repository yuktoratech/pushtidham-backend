import { createHash, createHmac } from "node:crypto";
import type Stripe from "stripe";
import type { Config } from "../config/env.js";
import type { StripeCheckoutInput } from "../validators/payments.js";
import { AppError } from "../utils/errors.js";
import { resolveDonationDesignation } from "./donation-eligibility.js";
import type { FeePolicy } from "./payment-fees.js";
import { PaymentService } from "./payments.js";
import type { StripeGateway } from "./stripe-gateway.js";
import type { Types } from "mongoose";

function feePolicy(config: Config, method: "card" | "ach"): FeePolicy | undefined {
  if (method === "card") {
    if (config.STRIPE_CARD_FEE_BPS === undefined || config.STRIPE_CARD_FEE_FIXED_CENTS === undefined)
      return undefined;
    return {
      enabled: true,
      percentageBasisPoints: config.STRIPE_CARD_FEE_BPS,
      fixedCents: config.STRIPE_CARD_FEE_FIXED_CENTS,
    };
  }
  if (config.STRIPE_ACH_FEE_BPS === undefined || config.STRIPE_ACH_FEE_FIXED_CENTS === undefined)
    return undefined;
  return {
    enabled: true,
    percentageBasisPoints: config.STRIPE_ACH_FEE_BPS,
    fixedCents: config.STRIPE_ACH_FEE_FIXED_CENTS,
    capCents: config.STRIPE_ACH_FEE_CAP_CENTS,
    bankVerificationCents: config.STRIPE_ACH_VERIFICATION_CENTS,
    includeBankVerificationCost: config.STRIPE_ACH_COVER_VERIFICATION_COST,
  };
}

function objectId(value: string | Stripe.PaymentIntent | null) {
  return typeof value === "string" ? value : value?.id;
}

export class StripeCheckoutService {
  constructor(
    private readonly config: Config,
    private readonly stripe: StripeGateway,
    private readonly payments = new PaymentService(),
  ) {}

  async create(
    input: StripeCheckoutInput,
    idempotencyKey: string,
    actorId?: Types.ObjectId,
  ) {
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey))
      throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Provide a 16 to 200 character Idempotency-Key header");
    if (
      !this.config.STRIPE_SECRET_KEY ||
      !this.config.STRIPE_CHECKOUT_SUCCESS_URL ||
      !this.config.STRIPE_CHECKOUT_CANCEL_URL ||
      !this.config.PAYMENT_STATUS_TOKEN_SECRET
    )
      throw new AppError(503, "STRIPE_UNAVAILABLE", "Stripe checkout is not configured");
    if (
      (input.methodFamily === "card" && !this.config.STRIPE_CARD_ENABLED) ||
      (input.methodFamily === "ach" && !this.config.STRIPE_ACH_ENABLED)
    )
      throw new AppError(422, "PAYMENT_METHOD_UNAVAILABLE", "Selected Stripe payment method is unavailable");

    const designation = await resolveDonationDesignation(input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          donorName: input.donorName,
          donorEmail: input.donorEmail,
          donorPhone: input.donorPhone ?? "",
          type: input.type,
          giving: input.giving ?? "",
          event: input.event ?? "",
          amountCents: input.amountCents,
          methodFamily: input.methodFamily,
          coverFees: input.coverFees,
        }),
      )
      .digest("hex");
    const statusToken = actorId
      ? undefined
      : createHmac("sha256", this.config.PAYMENT_STATUS_TOKEN_SECRET)
          .update(`stripe:${idempotencyKey}:${fingerprint}`)
          .digest("base64url");
    const prepared = await this.payments.prepareNewStripeDonationAttempt({
      ...input,
      designationTitle: designation.title,
      idempotencyKey,
      requestFingerprint: fingerprint,
      feePolicy: feePolicy(this.config, input.methodFamily),
      actorId,
      guestStatusToken: statusToken,
    });
    const attempt = prepared.attempt;
    const metadata = {
      attemptId: String(attempt._id),
      donationId: String(prepared.donation._id),
      baseDonationCents: String(attempt.baseDonationCents),
      feeContributionCents: String(attempt.feeContributionCents),
      totalChargeCents: String(attempt.totalChargeCents),
      methodFamily: input.methodFamily,
    };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      ui_mode: "hosted_page",
      success_url: this.config.STRIPE_CHECKOUT_SUCCESS_URL,
      cancel_url: this.config.STRIPE_CHECKOUT_CANCEL_URL,
      client_reference_id: String(attempt._id),
      customer_email: input.donorEmail,
      allowed_payment_method_types:
        input.methodFamily === "card"
          ? ["card", "link"]
          : ["us_bank_account"],
      ...(input.methodFamily === "ach"
        ? {
            payment_method_options: {
              us_bank_account: {
                verification_method: this.config.STRIPE_FINANCIAL_CONNECTIONS_ENABLED
                  ? ("automatic" as const)
                  : ("microdeposits" as const),
                ...(this.config.STRIPE_FINANCIAL_CONNECTIONS_ENABLED
                  ? { financial_connections: { permissions: ["payment_method" as const] } }
                  : {}),
              },
            },
          }
        : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: attempt.totalChargeCents,
            product_data: { name: `Donation — ${prepared.donation.designationTitle}` },
          },
        },
      ],
      metadata,
      payment_intent_data: {
        description: `Donation ${prepared.donation.donationNumber}`,
        metadata,
      },
      submit_type: "donate",
    };
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.createCheckoutSession(
        params,
        `pushtidham:${idempotencyKey}`,
      );
    } catch {
      throw new AppError(503, "STRIPE_CHECKOUT_FAILED", "Stripe checkout could not be created; retry with the same idempotency key");
    }
    if (
      !session.url ||
      session.currency?.toLowerCase() !== "usd" ||
      session.amount_total !== attempt.totalChargeCents
    )
      throw new AppError(502, "STRIPE_SESSION_MISMATCH", "Stripe Checkout Session does not match the prepared payment");
    await this.payments.bindStripeCheckout(String(attempt._id), {
      checkoutSessionId: session.id,
      paymentId: objectId(session.payment_intent),
    });
    return {
      sessionId: session.id,
      checkoutUrl: session.url,
      attemptId: String(attempt._id),
      status: "requires_action",
      baseDonationCents: attempt.baseDonationCents,
      feeContributionCents: attempt.feeContributionCents,
      totalChargeCents: attempt.totalChargeCents,
      currency: "USD" as const,
      ...(prepared.statusToken ? { statusToken: prepared.statusToken } : {}),
    };
  }
}
