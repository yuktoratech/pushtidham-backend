import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    shortDescription: { type: String, default: "" },
    description: { type: String, default: "" },
    startsAt: { type: Date, required: true },
    endsAt: Date,
    location: { type: String, required: true },
    image: { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "published", "inactive"],
      default: "draft",
    },
    deletedAt: Date,
  },
  { timestamps: true },
);
schema.pre("validate", function () {
  if (this.endsAt && this.endsAt < this.startsAt)
    this.invalidate("endsAt", "End must follow start");
});
schema.index({ slug: 1 }, { unique: true });
schema.index({ status: 1, deletedAt: 1, startsAt: 1, _id: 1 });
export const Event = model("Event", schema);
