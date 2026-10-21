import {Schema, model} from "mongoose";

const schema = new Schema({
  name: {type: String, required: true, trim: true, maxlength: 160},
  slug: {type: String, required: true, lowercase: true, trim: true, maxlength: 160, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/},
  description: {type: String, default: "", maxlength: 10000},
  image: {type: String, default: "", maxlength: 2000},
  status: {type: String, enum: ["active", "inactive"], default: "active"},
  displayOrder: {type: Number, default: 0, min: 0, max: 100000, validate: Number.isInteger},
}, {timestamps: true});

schema.index({slug: 1}, {unique: true});
schema.index({status: 1, displayOrder: 1, _id: 1});

export const GivingCategory = model("GivingCategory", schema);
