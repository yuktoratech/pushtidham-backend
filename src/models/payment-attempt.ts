import { Schema, model } from "mongoose";
import {
  MAX_DONATION_CENTS,
  MIN_DONATION_CENTS,
  paymentAttemptStatuses,
  paymentMethodFamilies,
  paymentProviders,
} from "../constants/domain.js";

const failureSchema = new Schema(
  {
    code: { type: String, maxlength: 100 },
    message: { type: String, maxlength: 500 },
    retryable: Boolean,
    occurredAt: Date,
  },
  { _id: false },
);

const historySchema = new Schema(
  {
    status: { type: String, enum: paymentAttemptStatuses, required: true },
    occurredAt: { type: Date, required: true },
    providerEventId: { type: String, maxlength: 255 },
  },
  { _id: false },
);

const schema = new Schema(
  {
    donation: { type: Schema.Types.ObjectId, ref: "Donation", required: true },
    provider: { type: String, enum: paymentProviders, required: true },
    methodFamily: {
      type: String,
      enum: paymentMethodFamilies,
      required: true,
    },
    status: {
      type: String,
      enum: paymentAttemptStatuses,
      default: "created",
      required: true,
    },
    currency: { type: String, enum: ["USD"], default: "USD", required: true },
    baseDonationCents: {
      type: Number,
      required: true,
      min: MIN_DONATION_CENTS,
      max: MAX_DONATION_CENTS,
      validate: Number.isInteger,
    },
    feeContributionCents: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_DONATION_CENTS,
      validate: Number.isInteger,
    },
    totalChargeCents: {
      type: Number,
      required: true,
      min: MIN_DONATION_CENTS,
      max: MAX_DONATION_CENTS,
      validate: Number.isInteger,
    },
    actualProviderFeeCents: { type: Number, min: 0, validate: Number.isInteger },
    netProceedsCents: { type: Number, validate: Number.isInteger },
    donorUser: { type: Schema.Types.ObjectId, ref: "User" },
    donorNameSnapshot: { type: String, required: true, maxlength: 120 },
    donorEmailSnapshot: { type: String, required: true, maxlength: 254 },
    idempotencyKey: { type: String, required: true, minlength: 16, maxlength: 255 },
    requestFingerprint: { type: String, maxlength: 64 },
    statusAccessTokenHash: { type: String, maxlength: 64, select: false },
    checkoutSessionId: { type: String, maxlength: 255 },
    orderId: { type: String, maxlength: 255 },
    paymentId: { type: String, maxlength: 255 },
    captureId: { type: String, maxlength: 255 },
    actualFundingSource: { type: String, enum: ["paypal", "venmo"], maxlength: 32 },
    failure: failureSchema,
    stateHistory: { type: [historySchema], default: [] },
    succeededAt: Date,
    failedAt: Date,
    canceledAt: Date,
    lastReconciledAt: Date,
    reconciliationAttempts: { type: Number, default: 0, min: 0 },
    reconciliationFailure: failureSchema,
  },
  { timestamps: true },
);

schema.pre("validate", function () {
  if (this.baseDonationCents + this.feeContributionCents !== this.totalChargeCents)
    this.invalidate("totalChargeCents", "Total must equal donation plus fee contribution");
  const allowed =
    (this.provider === "stripe" && ["card", "ach"].includes(this.methodFamily)) ||
    (this.provider === "paypal" && ["paypal", "venmo"].includes(this.methodFamily));
  if (!allowed) this.invalidate("methodFamily", "Method is not supported by provider");
});

schema.index({ provider: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ donation: 1, createdAt: -1, _id: -1 });
schema.index({ provider: 1, status: 1, updatedAt: 1 });
schema.index({ provider: 1, status: 1, lastReconciledAt: 1, updatedAt: 1 });
schema.index(
  { provider: 1, checkoutSessionId: 1 },
  { unique: true, partialFilterExpression: { checkoutSessionId: { $type: "string" } } },
);
schema.index(
  { provider: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: "string" } } },
);
schema.index(
  { provider: 1, paymentId: 1 },
  { unique: true, partialFilterExpression: { paymentId: { $type: "string" } } },
);
schema.index(
  { provider: 1, captureId: 1 },
  { unique: true, partialFilterExpression: { captureId: { $type: "string" } } },
);
schema.index(
  { statusAccessTokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: { statusAccessTokenHash: { $type: "string" } },
  },
);

export const PaymentAttempt = model("PaymentAttempt", schema);
