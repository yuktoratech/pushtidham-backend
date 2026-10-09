import { createHash, randomBytes } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { Donation } from "../models/donation.js";
import { PaymentAdjustment } from "../models/payment-adjustment.js";
import { PaymentAttempt } from "../models/payment-attempt.js";
import { WebhookEvent } from "../models/webhook-event.js";
import { AppError, missing } from "../utils/errors.js";
import { calculateFeeCoverage, type FeePolicy } from "./payment-fees.js";
import { VerifiedProviderEvent } from "./verified-provider-event.js";
import type { ClientSession } from "mongoose";

type Provider = "stripe" | "paypal";
type MethodFamily = "card" | "ach" | "paypal" | "venmo";
type AttemptStatus =
  | "created"
  | "requires_action"
  | "verification_pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export type PreparePaymentAttempt = {
  donationId: string;
  provider: Provider;
  methodFamily: MethodFamily;
  idempotencyKey: string;
  coverFees: boolean;
  feePolicy?: FeePolicy;
  actorId?: Types.ObjectId;
  providerIdentity?: {
    checkoutSessionId?: string;
    orderId?: string;
    paymentId?: string;
    captureId?: string;
  };
};

export type PrepareNewDonationAttempt = {
  provider: "stripe" | "paypal";
  donorName: string;
  donorEmail: string;
  donorPhone?: string;
  type: "general" | "event";
  giving?: string;
  event?: string;
  designationTitle: string;
  amountCents: number;
  methodFamily: "card" | "ach" | "paypal";
  idempotencyKey: string;
  requestFingerprint: string;
  coverFees: boolean;
  feePolicy?: FeePolicy;
  actorId?: Types.ObjectId;
  guestStatusToken?: string;
};

const statusRank: Record<AttemptStatus, number> = {
  created: 0,
  requires_action: 1,
  verification_pending: 2,
  processing: 3,
  failed: 4,
  canceled: 4,
  succeeded: 5,
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function sameId(left: unknown, right: string) {
  return String(left) === right;
}

export class PaymentService {
  async prepareNewStripeDonationAttempt(input: Omit<PrepareNewDonationAttempt, "provider">) {
    return this.prepareNewDonationAttempt({ ...input, provider: "stripe" });
  }

  async prepareNewPayPalDonationAttempt(input: Omit<PrepareNewDonationAttempt, "provider" | "methodFamily">) {
    return this.prepareNewDonationAttempt({ ...input, provider: "paypal", methodFamily: "paypal" });
  }

  private async prepareNewDonationAttempt(input: PrepareNewDonationAttempt) {
    if (!/^[A-Za-z0-9._:-]{16,255}$/.test(input.idempotencyKey))
      throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Use a 16 to 255 character idempotency key");
    const existing = await PaymentAttempt.findOne({
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) return this.preparedCheckoutReplay(existing, input);
    const amounts = calculateFeeCoverage(input.amountCents, input.coverFees, input.feePolicy);
    const session = await mongoose.startSession();
    try {
      let createdAttempt: InstanceType<typeof PaymentAttempt> | undefined;
      let createdDonation: InstanceType<typeof Donation> | undefined;
      await session.withTransaction(async () => {
        const replay = await PaymentAttempt.findOne({
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
        }).session(session);
        if (replay) {
          createdAttempt = replay;
          createdDonation = (await Donation.findById(replay.donation).session(session)) ?? undefined;
          return;
        }
        const now = new Date();
        [createdDonation] = await Donation.create(
          [
            {
              donationNumber:
                "PD-" +
                now.toISOString().slice(0, 10).replaceAll("-", "") +
                "-" +
                randomBytes(8).toString("hex").toUpperCase(),
              user: input.actorId,
              donorName: input.donorName,
              donorEmail: input.donorEmail,
              donorPhone: input.donorPhone,
              type: input.type,
              giving: input.giving,
              event: input.event,
              designationTitle: input.designationTitle,
              amountCents: input.amountCents,
              currency: "USD",
              paymentMethod: input.methodFamily,
              status: "pending",
              source: "online",
            },
          ],
          { session },
        );
        [createdAttempt] = await PaymentAttempt.create(
          [
            {
              donation: createdDonation!._id,
              provider: input.provider,
              methodFamily: input.methodFamily,
              status: "created",
              currency: "USD",
              ...amounts,
              donorUser: input.actorId,
              donorNameSnapshot: input.donorName,
              donorEmailSnapshot: input.donorEmail,
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: input.requestFingerprint,
              statusAccessTokenHash: input.guestStatusToken
                ? digest(input.guestStatusToken)
                : undefined,
              stateHistory: [{ status: "created", occurredAt: now }],
            },
          ],
          { session },
        );
      });
      if (!createdAttempt || !createdDonation)
        throw new AppError(503, "PAYMENT_PREPARATION_FAILED", "Unable to prepare payment");
      if (createdAttempt.requestFingerprint !== input.requestFingerprint)
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was used for different checkout details");
      return {
        attempt: createdAttempt,
        donation: createdDonation,
        statusToken: input.actorId ? undefined : input.guestStatusToken,
        replayed: createdAttempt.createdAt.getTime() !== createdAttempt.updatedAt.getTime(),
      };
    } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && error.code === 11000)) throw error;
      const raced = await PaymentAttempt.findOne({ provider: input.provider, idempotencyKey: input.idempotencyKey });
      if (!raced) throw error;
      return this.preparedCheckoutReplay(raced, input);
    } finally {
      await session.endSession();
    }
  }

  private async preparedCheckoutReplay(
    attempt: InstanceType<typeof PaymentAttempt>,
    input: PrepareNewDonationAttempt,
    session?: ClientSession,
  ) {
    if (attempt.requestFingerprint !== input.requestFingerprint)
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was used for different checkout details");
    const query = Donation.findById(attempt.donation);
    if (session) query.session(session);
    const donation = await query;
    if (!donation) missing("Donation");
    return {
      attempt,
      donation,
      statusToken: input.actorId ? undefined : input.guestStatusToken,
      replayed: true,
    };
  }

  async bindStripeCheckout(
    attemptId: string,
    identity: { checkoutSessionId: string; paymentId?: string },
  ) {
    const now = new Date();
    const attempt = await PaymentAttempt.findOneAndUpdate(
      {
        _id: attemptId,
        provider: "stripe",
        $and: [
          { $or: [{ checkoutSessionId: null }, { checkoutSessionId: identity.checkoutSessionId }] },
          ...(identity.paymentId
            ? [{ $or: [{ paymentId: null }, { paymentId: identity.paymentId }] }]
            : []),
        ],
      },
      {
        $set: {
          checkoutSessionId: identity.checkoutSessionId,
          ...(identity.paymentId ? { paymentId: identity.paymentId } : {}),
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!attempt)
      throw new AppError(409, "PROVIDER_IDENTITY_CONFLICT", "Stripe identifiers do not match the payment attempt");
    if (attempt.status === "created")
      await PaymentAttempt.updateOne(
        { _id: attempt._id, status: "created" },
        {
          $set: { status: "requires_action" },
          $push: { stateHistory: { status: "requires_action", occurredAt: now } },
        },
      );
    return PaymentAttempt.findById(attempt._id);
  }

  async bindStripePaymentIntent(attemptId: string, paymentId: string) {
    const attempt = await PaymentAttempt.findOneAndUpdate(
      {
        _id: attemptId,
        provider: "stripe",
        $or: [{ paymentId: null }, { paymentId }],
      },
      { $set: { paymentId } },
      { returnDocument: "after", runValidators: true },
    );
    if (!attempt)
      throw new AppError(409, "PROVIDER_IDENTITY_CONFLICT", "Stripe PaymentIntent does not match the attempt");
    return attempt;
  }

  async bindPayPalOrder(attemptId: string, orderId: string) {
    const attempt = await PaymentAttempt.findOneAndUpdate(
      { _id: attemptId, provider: "paypal", $or: [{ orderId: null }, { orderId }] },
      { $set: { orderId } },
      { returnDocument: "after", runValidators: true },
    );
    if (!attempt) throw new AppError(409, "PROVIDER_IDENTITY_CONFLICT", "PayPal order does not match the payment attempt");
    if (attempt.status === "created")
      await PaymentAttempt.updateOne(
        { _id: attempt._id, status: "created" },
        { $set: { status: "requires_action" }, $push: { stateHistory: { status: "requires_action", occurredAt: new Date() } } },
      );
    return PaymentAttempt.findById(attempt._id);
  }

  async bindPayPalCapture(attemptId: string, captureId: string, fundingSource: "paypal" | "venmo") {
    const attempt = await PaymentAttempt.findOneAndUpdate(
      { _id: attemptId, provider: "paypal", $or: [{ captureId: null }, { captureId }] },
      { $set: { captureId, actualFundingSource: fundingSource } },
      { returnDocument: "after", runValidators: true },
    );
    if (!attempt) throw new AppError(409, "PROVIDER_IDENTITY_CONFLICT", "PayPal capture does not match the payment attempt");
    return attempt;
  }

  async prepareAttempt(input: PreparePaymentAttempt) {
    if (!/^[A-Za-z0-9._:-]{16,255}$/.test(input.idempotencyKey))
      throw new AppError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Use a 16 to 255 character idempotency key",
      );
    const existing = await PaymentAttempt.findOne({
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      const expected = calculateFeeCoverage(
        existing.baseDonationCents,
        input.coverFees,
        input.feePolicy,
      );
      this.assertPreparedAttemptMatches(existing, input, expected);
      return { attempt: existing, statusToken: undefined, replayed: true };
    }
    const donation = await Donation.findById(input.donationId);
    if (!donation) missing("Donation");
    if (donation.source !== "online" || donation.status !== "pending")
      throw new AppError(
        409,
        "DONATION_NOT_PAYABLE",
        "Only pending online donations can start a payment attempt",
      );
    if (
      donation.user &&
      (!input.actorId || !sameId(donation.user, String(input.actorId)))
    )
      throw new AppError(403, "FORBIDDEN", "Donation ownership does not match");
    const amounts = calculateFeeCoverage(
      donation.amountCents,
      input.coverFees,
      input.feePolicy,
    );
    const statusToken = donation.user
      ? undefined
      : randomBytes(32).toString("base64url");
    const now = new Date();
    try {
      const attempt = await PaymentAttempt.create({
        donation: donation._id,
        provider: input.provider,
        methodFamily: input.methodFamily,
        status: "created",
        currency: "USD",
        ...amounts,
        donorUser: donation.user,
        donorNameSnapshot: donation.donorName,
        donorEmailSnapshot: donation.donorEmail,
        idempotencyKey: input.idempotencyKey,
        statusAccessTokenHash: statusToken ? digest(statusToken) : undefined,
        ...input.providerIdentity,
        stateHistory: [{ status: "created", occurredAt: now }],
      });
      return { attempt, statusToken, replayed: false };
    } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && error.code === 11000))
        throw error;
      const raced = await PaymentAttempt.findOne({
        provider: input.provider,
        idempotencyKey: input.idempotencyKey,
      });
      if (!raced) throw error;
      this.assertPreparedAttemptMatches(raced, input, amounts);
      return { attempt: raced, statusToken: undefined, replayed: true };
    }
  }

  private assertPreparedAttemptMatches(
    attempt: { donation: unknown; methodFamily: string },
    input: PreparePaymentAttempt,
    amounts: {
      baseDonationCents: number;
      feeContributionCents: number;
      totalChargeCents: number;
    },
  ) {
    const candidate = attempt as typeof attempt & {
      baseDonationCents: number;
      feeContributionCents: number;
      totalChargeCents: number;
      checkoutSessionId?: string;
      orderId?: string;
      paymentId?: string;
      captureId?: string;
    };
    if (
      !sameId(attempt.donation, input.donationId) ||
      attempt.methodFamily !== input.methodFamily ||
      candidate.baseDonationCents !== amounts.baseDonationCents ||
      candidate.feeContributionCents !== amounts.feeContributionCents ||
      candidate.totalChargeCents !== amounts.totalChargeCents ||
      Object.entries(input.providerIdentity ?? {}).some(
        ([key, value]) =>
          candidate[key as keyof typeof candidate] !== value,
      )
    )
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for different payment details",
      );
  }

  async findGuestAttempt(attemptId: string, statusToken: string) {
    const attempt = await PaymentAttempt.findOne({
      _id: attemptId,
      donorUser: null,
      statusAccessTokenHash: digest(statusToken),
    });
    if (!attempt) missing("Payment attempt");
    return this.statusView(attempt);
  }

  async findOwnedAttempt(attemptId: string, actorId: Types.ObjectId) {
    const attempt = await PaymentAttempt.findOne({
      _id: attemptId,
      donorUser: actorId,
    });
    if (!attempt) missing("Payment attempt");
    return this.statusView(attempt);
  }

  async requirePayPalCaptureAccess(orderId: string, actorId?: Types.ObjectId, statusToken?: string) {
    const attempt = await PaymentAttempt.findOne({ provider: "paypal", orderId }).select("+statusAccessTokenHash");
    if (!attempt) missing("PayPal payment attempt");
    if (actorId && attempt.donorUser && sameId(attempt.donorUser, String(actorId))) return attempt;
    if (!actorId && !attempt.donorUser && statusToken && attempt.statusAccessTokenHash === digest(statusToken)) return attempt;
    throw new AppError(403, "FORBIDDEN", "PayPal capture access denied");
  }

  private statusView(attempt: InstanceType<typeof PaymentAttempt>) {
    return {
      id: String(attempt._id),
      provider: attempt.provider,
      methodFamily: attempt.methodFamily,
      status: attempt.status,
      currency: attempt.currency,
      baseDonationCents: attempt.baseDonationCents,
      feeContributionCents: attempt.feeContributionCents,
      totalChargeCents: attempt.totalChargeCents,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      succeededAt: attempt.succeededAt,
    };
  }

  async applyVerifiedEvent(event: VerifiedProviderEvent) {
    if (!VerifiedProviderEvent.isVerified(event))
      throw new AppError(403, "UNVERIFIED_PROVIDER_EVENT", "Provider verification required");
    const input = event.input;
    if (
      !input.eventId ||
      input.eventId.length > 255 ||
      !input.eventType ||
      input.eventType.length > 255 ||
      !/^[a-fA-F0-9]{64}$/.test(input.payloadDigest) ||
      !Types.ObjectId.isValid(input.attemptId) ||
      !Types.ObjectId.isValid(input.donationId) ||
      !input.providerReference.value ||
      input.providerReference.value.length > 255 ||
      input.actualProviderFeeCents !== undefined &&
        (!Number.isInteger(input.actualProviderFeeCents) ||
          input.actualProviderFeeCents < 0 ||
          input.actualProviderFeeCents > input.totalChargeCents)
    )
      throw new AppError(
        400,
        "INVALID_PROVIDER_EVENT",
        "Verified provider event contains invalid payment metadata",
      );
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);
    let ledger;
    try {
      ledger = await WebhookEvent.findOneAndUpdate(
        { provider: input.provider, eventId: input.eventId },
        {
          $setOnInsert: {
            eventType: input.eventType,
            payloadDigest: input.payloadDigest,
            attempt: input.attemptId,
            status: "received",
            receivedAt: now,
            processingAttempts: 0,
          },
        },
        { upsert: true, returnDocument: "after", runValidators: true },
      );
    } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && error.code === 11000))
        throw error;
      ledger = await WebhookEvent.findOne({
        provider: input.provider,
        eventId: input.eventId,
      });
      if (!ledger) throw error;
    }
    if (
      ledger.eventType !== input.eventType ||
      ledger.payloadDigest !== input.payloadDigest ||
      !sameId(ledger.attempt, input.attemptId)
    )
      throw new AppError(
        409,
        "WEBHOOK_EVENT_CONFLICT",
        "Provider event identity was reused with different content",
      );
    if (ledger.status === "processed") return { duplicate: true };
    const claimed = await WebhookEvent.findOneAndUpdate(
      {
        _id: ledger._id,
        $or: [
          { status: "received" },
          { status: "failed", "failure.retryable": { $ne: false } },
          { status: "processing", lastAttemptAt: { $lt: staleBefore } },
        ],
      },
      {
        $set: { status: "processing", lastAttemptAt: now },
        $inc: { processingAttempts: 1 },
        $unset: { failure: 1 },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      const currentLedger = await WebhookEvent.findById(ledger._id);
      if (currentLedger?.status === "processing" || currentLedger?.status === "processed")
        return { duplicate: true };
      throw new AppError(
        409,
        "WEBHOOK_EVENT_REJECTED",
        "Provider event previously failed deterministic verification",
      );
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const attempt = await PaymentAttempt.findById(input.attemptId).session(session);
        if (!attempt) missing("Payment attempt");
        if (
          attempt.provider !== input.provider ||
          !sameId(attempt.donation, input.donationId) ||
          attempt.currency !== input.currency ||
          attempt.baseDonationCents !== input.baseDonationCents ||
          attempt.feeContributionCents !== input.feeContributionCents ||
          attempt.totalChargeCents !== input.totalChargeCents ||
          attempt[input.providerReference.field] !== input.providerReference.value
        )
          throw new AppError(
            409,
            "PAYMENT_VERIFICATION_MISMATCH",
            "Verified provider details do not match the payment attempt",
          );
        const current = attempt.status as AttemptStatus;
        const shouldAdvance =
          input.status === "succeeded"
            ? current !== "succeeded"
            : current !== "succeeded" &&
              current !== "failed" &&
              current !== "canceled" &&
              statusRank[input.status] >= statusRank[current];
        if (shouldAdvance) {
          attempt.status = input.status;
          attempt.stateHistory.push({
            status: input.status,
            occurredAt: now,
            providerEventId: input.eventId,
          });
          if (input.status === "succeeded") attempt.succeededAt = now;
          if (input.status === "failed") attempt.failedAt = now;
          if (input.status === "canceled") attempt.canceledAt = now;
          if (input.status === "failed" && input.failure)
            attempt.failure = {
              code: input.failure.code,
              message: input.failure.message,
              retryable: input.failure.retryable,
              occurredAt: now,
            };
          if (input.actualProviderFeeCents !== undefined) {
            attempt.actualProviderFeeCents = input.actualProviderFeeCents;
            attempt.netProceedsCents =
              attempt.totalChargeCents - input.actualProviderFeeCents;
          }
          await attempt.save({ session });
        }
        if (input.status === "succeeded") {
          const donation = await Donation.findById(input.donationId).session(session);
          if (!donation) missing("Donation");
          if (
            donation.status === "completed" &&
            !sameId(donation.confirmedPaymentAttempt, input.attemptId)
          )
            throw new AppError(
              409,
              "DUPLICATE_PAYMENT_INCIDENT",
              "Donation already has a different confirmed payment",
            );
          if (
            donation.status === "pending" ||
            (donation.status === "rejected" && donation.source === "online")
          ) {
            donation.status = "completed";
            donation.confirmedPaymentAttempt = attempt._id;
            donation.feeContributionCents = attempt.feeContributionCents;
            donation.totalChargedCents = attempt.totalChargeCents;
            donation.completedAt = now;
            donation.rejectedAt = undefined;
            if (input.actualProviderFeeCents !== undefined) {
              donation.actualProviderFeeCents = input.actualProviderFeeCents;
              donation.netProceedsCents =
                attempt.totalChargeCents - input.actualProviderFeeCents;
            }
            await donation.save({ session });
          }
        }
        if (input.adjustment) {
          if (current !== "succeeded" && input.status !== "succeeded")
            throw new AppError(
              409,
              "ADJUSTMENT_BEFORE_SUCCESS",
              "Financial adjustments require a succeeded payment attempt",
            );
          if (
            !Number.isInteger(input.adjustment.amountCents) ||
            input.adjustment.amountCents < 1 ||
            input.adjustment.amountCents > attempt.totalChargeCents
          )
            throw new AppError(
              409,
              "ADJUSTMENT_AMOUNT_MISMATCH",
              "Adjustment amount exceeds the verified charge",
            );
          if (
            input.adjustment.type === "refund" &&
            input.adjustment.status === "succeeded"
          ) {
            const previous = await PaymentAdjustment.aggregate<{ total: number }>([
              {
                $match: {
                  attempt: attempt._id,
                  type: "refund",
                  status: "succeeded",
                  providerReference: { $ne: input.adjustment.providerReference },
                },
              },
              { $group: { _id: null, total: { $sum: "$amountCents" } } },
            ]).session(session);
            if ((previous[0]?.total ?? 0) + input.adjustment.amountCents > attempt.totalChargeCents)
              throw new AppError(
                409,
                "REFUND_EXCEEDS_CHARGE",
                "Cumulative refunds exceed the verified charge",
              );
          }
          await PaymentAdjustment.findOneAndUpdate(
            {
              provider: input.provider,
              type: input.adjustment.type,
              providerReference: input.adjustment.providerReference,
            },
            {
              $setOnInsert: {
                donation: input.donationId,
                attempt: attempt._id,
                currency: "USD",
                amountCents: input.adjustment.amountCents,
                providerEventId: input.eventId,
                occurredAt: input.adjustment.occurredAt,
              },
              $set: {
                status: input.adjustment.status,
                reasonCode: input.adjustment.reasonCode,
                ...(input.adjustment.status === "succeeded"
                  ? { resolvedAt: now }
                  : {}),
              },
            },
            { upsert: true, session, runValidators: true },
          );
        }
        await WebhookEvent.updateOne(
          { _id: claimed._id },
          { $set: { status: "processed", processedAt: now }, $unset: { failure: 1 } },
          { session },
        );
      });
      return { duplicate: false };
    } catch (error) {
      await WebhookEvent.updateOne(
        { _id: claimed._id, status: "processing" },
        {
          $set: {
            status: "failed",
            failure: {
              code: error instanceof AppError ? error.code : "PROCESSING_FAILED",
              message:
                error instanceof AppError
                  ? error.message
                  : "Provider event processing failed",
              retryable: !(error instanceof AppError) || error.status >= 500,
              occurredAt: new Date(),
            },
          },
        },
      );
      throw error;
    } finally {
      await session.endSession();
    }
  }
}
