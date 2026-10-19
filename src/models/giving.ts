import { Schema, model } from "mongoose";
import { MIN_DONATION_CENTS, MAX_DONATION_CENTS } from "../constants/domain.js";
import {festivalKeys} from "../content/client-catalog.js";
const schema = new Schema(
  {
    title: { type: String, required: true },
    category: {type: String, enum: ["general", "daily_seva", "utsav"], default: "general"},
    festivalGroup: {type: String, enum: ["", ...festivalKeys], default: ""},
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
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
  if ((this.category === "utsav") !== Boolean(this.festivalGroup)) this.invalidate("festivalGroup", "Only Utsav options require a festival group");
  if (this.category === "utsav" && (this.amountType !== "fixed" || this.fixedAmountsCents.length !== 1)) this.invalidate("amountType", "Utsav options require one fixed amount");
  if (this.amountType !== "custom" && !this.fixedAmountsCents.length)
    this.invalidate("fixedAmountsCents", "Fixed amounts required");
});
schema.index({ slug: 1 }, { unique: true });
schema.index({ status: 1, deletedAt: 1, displayOrder: 1, _id: 1 });
export const Giving = model("Giving", schema);
