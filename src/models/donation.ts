import { Schema, model } from "mongoose";
import {
  MIN_DONATION_CENTS,
  MAX_DONATION_CENTS,
  donationTypes,
  paymentMethods,
  statuses,
} from "../constants/domain.js";
const schema = new Schema(
  {
    donationNumber: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    donorName: { type: String, required: true },
    donorEmail: { type: String, required: true, lowercase: true },
    donorPhone: String,
    type: { type: String, enum: donationTypes, required: true },
    giving: { type: Schema.Types.ObjectId, ref: "Giving" },
    event: { type: Schema.Types.ObjectId, ref: "Event" },
    designationTitle: { type: String, required: true },
    amountCents: {
      type: Number,
      required: true,
      min: MIN_DONATION_CENTS,
      max: MAX_DONATION_CENTS,
      validate: Number.isInteger,
    },
    currency: { type: String, enum: ["USD"], default: "USD" },
    paymentMethod: { type: String, enum: paymentMethods, required: true },
    status: { type: String, enum: statuses, default: "pending" },
    source: { type: String, enum: ["online", "offline"], required: true },
    externalReference: String,
    bankReference: String,
    offlineReference: String,
    adminNote: String,
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: Date,
    completedAt: Date,
    rejectedAt: Date,
  },
  { timestamps: true },
);
schema.pre("validate", function () {
  if (
    this.type === "general"
      ? !this.giving || !!this.event
      : !this.event || !!this.giving
  )
    this.invalidate("type", "Exactly one matching designation required");
  if ((this.source === "offline") !== (this.paymentMethod === "offline"))
    this.invalidate("source", "Payment method and source mismatch");
});
schema.index({ donationNumber: 1 }, { unique: true });
schema.index({ user: 1, createdAt: -1, _id: -1 });
schema.index({ createdAt: -1, _id: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ giving: 1, createdAt: -1 });
schema.index({ event: 1, createdAt: -1 });
export const Donation = model("Donation", schema);
