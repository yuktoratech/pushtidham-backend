import { Schema, model } from "mongoose";
const galleryEntry = new Schema({
  url: {type: String, required: true, maxlength: 2000},
  alt: {type: String, default: "", maxlength: 300},
  displayOrder: {type: Number, min: 0, max: 1000, required: true, validate: Number.isInteger},
}, {_id: false});
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
    gallery: {type: [galleryEntry], default: []},
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
