import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: "", maxlength: 30 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["donor", "admin"], default: "donor" },
    canManageGivingCategories: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    passwordChangedAt: Date,
    passwordSetupRequired: { type: Boolean, default: false },
    emailVerifiedAt: Date,
    welcomeEmailStatus: { type: String, enum: ["pending", "sending", "sent", "failed"] },
    welcomeEmailLeaseUntil: Date,
    welcomeEmailLastAttemptAt: Date,
    welcomeEmailAttempts: { type: Number, default: 0 },
    welcomeEmailErrorCode: { type: String, enum: ["MAIL_UNAVAILABLE"] },
    resetTokenHash: { type: String, select: false },
    resetExpiresAt: { type: Date, select: false },
  },
  { timestamps: true },
);
schema.index({ email: 1 }, { unique: true });
schema.set("toJSON", {
  transform: (_doc, ret) => {
    Reflect.deleteProperty(ret, "passwordHash");
    Reflect.deleteProperty(ret, "resetTokenHash");
    Reflect.deleteProperty(ret, "resetExpiresAt");
    return ret;
  },
});
export const User = model("User", schema);
