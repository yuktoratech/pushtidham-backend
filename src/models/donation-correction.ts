import {Schema, model} from "mongoose";
const schema = new Schema({
 donation: {type: Schema.Types.ObjectId, ref: "Donation", required: true, immutable: true},
 actor: {type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true},
 version: {type: Number, required: true, immutable: true},
 requestKey: {type: String, required: true, immutable: true, select: false},
 requestHash: {type: String, required: true, immutable: true, select: false},
 reason: {type: String, required: true, maxlength: 1000, immutable: true},
 changes: {type: Schema.Types.Mixed, required: true, immutable: true},
 receiptImpact: {type: Boolean, required: true, immutable: true},
 receiptRevision: {type: Number, immutable: true},
 createdAt: {type: Date, default: Date.now, immutable: true},
}, {versionKey: false});
schema.index({donation: 1, version: 1}, {unique: true});
schema.index({donation: 1, actor: 1, requestKey: 1}, {unique: true});
// Append-only application ledger. There are no update/delete HTTP endpoints.
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const)
 schema.pre(operation, function () {throw new Error("Donation corrections are append-only");});
export const DonationCorrection = model("DonationCorrection", schema);
