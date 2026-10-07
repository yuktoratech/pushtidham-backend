import { Schema, model } from "mongoose";
import { MIN_DONATION_CENTS, MAX_DONATION_CENTS } from "../constants/domain.js";
const schema = new Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: "" },
    amountType: {
      type: String,
      enum: ["fixed", "custom", "fixed_and_custom"],
      required: true,
    },
    fixedAmountsCents: {
      type: [Number],
      default: [],
      validate: {
        validator: (a: number[]) =>
          a.every(
            (n) =>
              Number.isInteger(n) &&
              n >= MIN_DONATION_CENTS &&
              n <= MAX_DONATION_CENTS,
          ),
        message: "Invalid amounts",
      },
    },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    displayOrder: { type: Number, default: 0 },
    deletedAt: Date,
  },
  { timestamps: true },
);
schema.pre("validate", function () {
  if (this.amountType !== "custom" && !this.fixedAmountsCents.length)
    this.invalidate("fixedAmountsCents", "Fixed amounts required");
});
schema.index({ slug: 1 }, { unique: true });
schema.index({ status: 1, deletedAt: 1, displayOrder: 1, _id: 1 });
export const Giving = model("Giving", schema);
