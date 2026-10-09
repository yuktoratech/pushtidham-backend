import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { AppError, missing } from "../utils/errors.js";
import { PaymentService } from "./payments.js";
import type { StripeGateway } from "./stripe-gateway.js";
import {
  VerifiedProviderEvent,
  type VerifiedProviderEventInput,
} from "./verified-provider-event.js";

type AttemptStatus = VerifiedProviderEventInput["status"];

const idOf = <T extends { id: string }>(value: string | T | null) =>
  typeof value === "string" ? value : value?.id;

function requiredMetadata(
  metadata: Stripe.Metadata,
  totalFromProvider: number | null,
) {
  const baseDonationCents = Number(metadata.baseDonationCents);
  const feeContributionCents = Number(metadata.feeContributionCents);
  const totalChargeCents = Number(metadata.totalChargeCents);
  if (
    !metadata.attemptId ||
    !metadata.donationId ||
    !Number.isInteger(baseDonationCents) ||
    !Number.isInteger(feeContributionCents) ||
    !Number.isInteger(totalChargeCents) ||
    totalFromProvider === null ||
    totalFromProvider !== totalChargeCents
  )
    throw new AppError(
      409,
      "STRIPE_METADATA_MISMATCH",
      "Stripe payment metadata does not match the authoritative amount",
    );
  return {
    attemptId: metadata.attemptId,
    donationId: metadata.donationId,
    baseDonationCents,
    feeContributionCents,
    totalChargeCents,
  };
}

function actualFees(intent: Stripe.PaymentIntent) {
  const charge =
    typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const balance =
    charge && typeof charge.balance_transaction === "object"
      ? charge.balance_transaction
      : null;
  return balance ? { actualProviderFeeCents: balance.fee } : {};
}

function safeFailure(intent: Stripe.PaymentIntent) {
  const error = intent.last_payment_error;
  return error
    ? {
        code: error.code?.slice(0, 100),
        message: (error.decline_code || error.type || "Stripe payment failed").slice(
          0,
          500,
        ),
        retryable: error.type === "api_error",
      }
    : undefined;
}

export class StripeEventService {
  constructor(
    private readonly stripe: StripeGateway,
    private readonly payments = new PaymentService(),
  ) {}

  async process(event: Stripe.Event, payloadDigest: string) {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const object = event.data.object as Stripe.Checkout.Session;
        const session = await this.stripe.retrieveCheckoutSession(object.id);
        return this.applyCheckoutSession(session, event.id, event.type, payloadDigest);
      }
      case "payment_intent.processing":
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed": {
        const object = event.data.object as Stripe.PaymentIntent;
        const intent = await this.stripe.retrievePaymentIntent(object.id);
        return this.applyPaymentIntent(intent, event.id, event.type, payloadDigest);
      }
      case "charge.refunded": {
        const object = event.data.object as Stripe.Charge;
        return this.applyRefunds(
          await this.stripe.retrieveCharge(object.id),
          event.id,
          payloadDigest,
        );
      }
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
        return this.applyDispute(
          event.data.object as Stripe.Dispute,
          event.id,
          event.type,
          payloadDigest,
        );
      default:
        return { ignored: true };
    }
  }

  async reconcileSession(session: Stripe.Checkout.Session) {
    const paymentId = idOf(session.payment_intent);
    const intent = paymentId
      ? await this.stripe.retrievePaymentIntent(paymentId)
      : undefined;
    const identity = [
      session.status,
      session.payment_status,
      intent?.status ?? "none",
    ].join(":");
    return this.applyCheckoutSession(
      session,
      `reconcile:${session.id}:${identity}`,
      "stripe.reconciliation",
      createHash("sha256").update(`${session.id}:${identity}`).digest("hex"),
      intent,
    );
  }

  private async applyCheckoutSession(
    session: Stripe.Checkout.Session,
    eventId: string,
    eventType: string,
    payloadDigest: string,
    suppliedIntent?: Stripe.PaymentIntent,
  ) {
    const metadata = requiredMetadata(session.metadata ?? {}, session.amount_total);
    if (session.currency?.toLowerCase() !== "usd")
      throw new AppError(409, "STRIPE_CURRENCY_MISMATCH", "Stripe currency must be USD");
    const paymentId = idOf(session.payment_intent);
    await this.payments.bindStripeCheckout(metadata.attemptId, {
      checkoutSessionId: session.id,
      paymentId,
    });
    const intent =
      suppliedIntent ??
      (paymentId ? await this.stripe.retrievePaymentIntent(paymentId) : undefined);
    let status: AttemptStatus = "requires_action";
    if (session.status === "expired") status = "canceled";
    else if (session.payment_status === "paid") status = "succeeded";
    else if (intent?.status === "succeeded") status = "succeeded";
    else if (intent?.status === "processing") status = "processing";
    else if (intent?.status === "requires_action")
      status =
        intent.next_action?.type === "verify_with_microdeposits"
          ? "verification_pending"
          : "requires_action";
    else if (intent?.status === "canceled") status = "canceled";
    else if (intent?.status === "requires_payment_method") status = "failed";
    else if (session.status === "complete")
      status = session.payment_method_types.includes("us_bank_account")
        ? "processing"
        : "requires_action";
    const reference = paymentId
      ? { field: "paymentId" as const, value: paymentId }
      : { field: "checkoutSessionId" as const, value: session.id };
    return this.payments.applyVerifiedEvent(
      VerifiedProviderEvent.fromVerifiedAdapter({
        provider: "stripe",
        eventId,
        eventType,
        payloadDigest,
        ...metadata,
        currency: "USD",
        status,
        providerReference: reference,
        ...(intent ? actualFees(intent) : {}),
        ...(intent && status === "failed" ? { failure: safeFailure(intent) } : {}),
      }),
    );
  }

  private async applyPaymentIntent(
    intent: Stripe.PaymentIntent,
    eventId: string,
    eventType: string,
    payloadDigest: string,
  ) {
    const metadata = requiredMetadata(intent.metadata, intent.amount);
    if (intent.currency.toLowerCase() !== "usd")
      throw new AppError(409, "STRIPE_CURRENCY_MISMATCH", "Stripe currency must be USD");
    await this.payments.bindStripePaymentIntent(metadata.attemptId, intent.id);
    const status: AttemptStatus =
      intent.status === "succeeded"
        ? "succeeded"
        : intent.status === "processing"
          ? "processing"
          : intent.status === "requires_action" &&
              intent.next_action?.type === "verify_with_microdeposits"
            ? "verification_pending"
            : intent.status === "canceled"
              ? "canceled"
              : intent.status === "requires_payment_method"
                ? "failed"
                : "requires_action";
    return this.payments.applyVerifiedEvent(
      VerifiedProviderEvent.fromVerifiedAdapter({
        provider: "stripe",
        eventId,
        eventType,
        payloadDigest,
        ...metadata,
        currency: "USD",
        status,
        providerReference: { field: "paymentId", value: intent.id },
        ...actualFees(intent),
        ...(status === "failed" ? { failure: safeFailure(intent) } : {}),
      }),
    );
  }

  private async paymentContext(charge: Stripe.Charge) {
    const paymentId = idOf(charge.payment_intent);
    if (!paymentId) missing("Stripe PaymentIntent");
    const intent = await this.stripe.retrievePaymentIntent(paymentId);
    const metadata = requiredMetadata(intent.metadata, intent.amount);
    const attempt = await this.payments.bindStripePaymentIntent(
      metadata.attemptId,
      intent.id,
    );
    return { intent, metadata, attempt };
  }

  private async applyRefunds(
    charge: Stripe.Charge,
    eventId: string,
    payloadDigest: string,
  ) {
    const { intent, metadata } = await this.paymentContext(charge);
    const results = [];
    for (const refund of charge.refunds?.data ?? []) {
      results.push(
        await this.payments.applyVerifiedEvent(
          VerifiedProviderEvent.fromVerifiedAdapter({
            provider: "stripe",
            eventId: `${eventId}:${refund.id}`,
            eventType: "charge.refunded",
            payloadDigest,
            ...metadata,
            currency: "USD",
            status: "succeeded",
            providerReference: { field: "paymentId", value: intent.id },
            ...actualFees(intent),
            adjustment: {
              type: "refund",
              status:
                refund.status === "succeeded"
                  ? "succeeded"
                  : refund.status === "failed"
                    ? "failed"
                    : "pending",
              amountCents: refund.amount,
              providerReference: refund.id,
              occurredAt: new Date(refund.created * 1000),
            },
          }),
        ),
      );
    }
    return { adjustments: results.length };
  }

  private async applyDispute(
    dispute: Stripe.Dispute,
    eventId: string,
    eventType: string,
    payloadDigest: string,
  ) {
    const chargeId = idOf(dispute.charge);
    if (!chargeId) missing("Stripe charge");
    const charge = await this.stripe.retrieveCharge(chargeId);
    const { intent, metadata, attempt } = await this.paymentContext(charge);
    const won = dispute.status === "won" || dispute.status === "warning_closed";
    const lost = dispute.status === "lost";
    const type = attempt.methodFamily === "ach" ? "ach_return" : "dispute";
    await this.payments.applyVerifiedEvent(
      VerifiedProviderEvent.fromVerifiedAdapter({
        provider: "stripe",
        eventId: `${eventId}:outcome`,
        eventType,
        payloadDigest,
        ...metadata,
        currency: "USD",
        status: "succeeded",
        providerReference: { field: "paymentId", value: intent.id },
        ...actualFees(intent),
        adjustment: {
          type,
          status: won ? "failed" : lost || type === "ach_return" ? "succeeded" : "pending",
          amountCents: dispute.amount,
          providerReference: dispute.id,
          reasonCode: dispute.reason,
          occurredAt: new Date(dispute.created * 1000),
        },
      }),
    );
    if (won)
      await this.payments.applyVerifiedEvent(
        VerifiedProviderEvent.fromVerifiedAdapter({
          provider: "stripe",
          eventId: `${eventId}:reversal`,
          eventType,
          payloadDigest,
          ...metadata,
          currency: "USD",
          status: "succeeded",
          providerReference: { field: "paymentId", value: intent.id },
          adjustment: {
            type: "reversal",
            status: "succeeded",
            amountCents: dispute.amount,
            providerReference: `${dispute.id}:reversal`,
            reasonCode: dispute.reason,
            occurredAt: new Date(),
          },
        }),
      );
    return { adjustment: type, reversed: won };
  }
}
