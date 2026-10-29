import {Schema, model} from "mongoose";

// A durable retry record is written before changing a catalog image reference.
const schema = new Schema({
  _id: {type: String, required: true},
  url: {type: String, required: true},
  nextAttemptAt: {type: Date, required: true},
  leaseUntil: {type: Date, default: () => new Date(0)},
}, {timestamps: true});
schema.index({nextAttemptAt: 1});
export const ImageCleanup = model("ImageCleanup", schema);
