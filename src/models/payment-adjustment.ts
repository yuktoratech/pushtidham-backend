import { Schema, model } from "mongoose";
import {
  paymentAdjustmentStatuses,
  paymentAdjustmentTypes,
  paymentProviders,
} from "../constants/domain.js";

const schema = new Schema(
  {
    donation: { type: Schema.Types.ObjectId, ref: "Donation", required: true },
    attempt: { type: Schema.Types.ObjectId, ref: "PaymentAttempt", required: true },
    provider: { type: String, enum: paymentProviders, required: true },
    type: { type: String, enum: paymentAdjustmentTypes, required: true },
    status: {
      type: String,
      enum: paymentAdjustmentStatuses,
      required: true,
    },
    currency: { type: String, enum: ["USD"], default: "USD", required: true },
    amountCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    providerReference: { type: String, required: true, maxlength: 255 },
    providerEventId: { type: String, maxlength: 255 },
    reasonCode: { type: String, maxlength: 100 },
    occurredAt: { type: Date, required: true },
    resolvedAt: Date,
  },
  { timestamps: true },
);

schema.index(
  { provider: 1, type: 1, providerReference: 1 },
  { unique: true },
);
schema.index({ donation: 1, occurredAt: -1, _id: -1 });
schema.index({ attempt: 1, occurredAt: -1 });
schema.index({ status: 1, updatedAt: 1 });

export const PaymentAdjustment = model("PaymentAdjustment", schema);
