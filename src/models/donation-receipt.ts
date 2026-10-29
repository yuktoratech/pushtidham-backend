import {Schema, model} from "mongoose";
const schema = new Schema({
 donation: {type: Schema.Types.ObjectId, ref: "Donation", required: true, immutable: true},
 revision: {type: Number, required: true, immutable: true},
 previousRevision: {type: Number, immutable: true},
 bytes: {type: Buffer, required: true, select: false, immutable: true},
 sha256: {type: String, required: true, immutable: true},
 createdAt: {type: Date, default: Date.now, immutable: true},
}, {versionKey: false});
schema.index({donation: 1, revision: 1}, {unique: true});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const)
 schema.pre(operation, function () {throw new Error("Receipt snapshots are immutable");});
export const DonationReceipt = model("DonationReceipt", schema);
