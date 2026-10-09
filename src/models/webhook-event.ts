import { Schema, model } from "mongoose";
import {
  paymentProviders,
  webhookProcessingStatuses,
} from "../constants/domain.js";

const schema = new Schema(
  {
    provider: { type: String, enum: paymentProviders, required: true },
    eventId: { type: String, required: true, maxlength: 255 },
    eventType: { type: String, required: true, maxlength: 255 },
    attempt: { type: Schema.Types.ObjectId, ref: "PaymentAttempt" },
    payloadDigest: { type: String, required: true, maxlength: 64 },
    status: {
      type: String,
      enum: webhookProcessingStatuses,
      default: "received",
      required: true,
    },
    receivedAt: { type: Date, default: Date.now, required: true },
    processedAt: Date,
    lastAttemptAt: Date,
    processingAttempts: { type: Number, default: 0, min: 0 },
    failure: {
      code: { type: String, maxlength: 100 },
      message: { type: String, maxlength: 500 },
      retryable: Boolean,
      occurredAt: Date,
    },
  },
  { timestamps: true },
);

schema.index({ provider: 1, eventId: 1 }, { unique: true });
schema.index({ status: 1, lastAttemptAt: 1 });
schema.index({ attempt: 1, receivedAt: -1 });

export const WebhookEvent = model("WebhookEvent", schema);
