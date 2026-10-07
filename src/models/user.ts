import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["donor", "admin"], default: "donor" },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    passwordChangedAt: Date,
  },
  { timestamps: true },
);
schema.index({ email: 1 }, { unique: true });
schema.set("toJSON", {
  transform: (_doc, ret) => {
    Reflect.deleteProperty(ret, "passwordHash");
    return ret;
  },
});
export const User = model("User", schema);
