import mongoose, {Types} from "mongoose";
import {createHash} from "node:crypto";
import {Donation} from "../models/donation.js";
import {DonationCorrection} from "../models/donation-correction.js";
import {DonationReceipt} from "../models/donation-receipt.js";
import {User} from "../models/user.js";
import {Giving} from "../models/giving.js";
import {PaymentAttempt} from "../models/payment-attempt.js";
import {PaymentAdjustment} from "../models/payment-adjustment.js";
import {offlineEditBody, type OfflineEditInput} from "../validators/donation.js";
import {resolveDonationDesignation, validateDonationPurpose} from "./donation-eligibility.js";
import {saveReceiptSnapshot} from "./receipts.js";
import {AppError, missing} from "../utils/errors.js";

const conflict = () => new AppError(409, "CORRECTION_CONFLICT", "This donation changed. Close the editor and reload its details before reviewing a new correction. Your draft has not been discarded.");
function scalar(value: unknown): string | number | boolean | null {
 if (value === null || value === undefined || value === "") return null;
 if (value instanceof Date) return value.toISOString();
 if (typeof value === "number" || typeof value === "boolean") return value;
 return String(value);
}
export class OfflineDonationCorrectionService {
 async history(id: string) {
  if (!(await Donation.exists({_id: id}))) missing("Donation");
  const row = await Donation.findById(id).lean();
  const entries = await DonationCorrection.find({donation: id}).sort({version: -1}).lean();
  const receipts = await DonationReceipt.find({donation: id}).sort({revision: -1}).lean();
  return {entries: entries.map(item => ({id: String(item._id), actor: String(item.actor), version: item.version, reason: item.reason, changes: item.changes, receiptImpact: item.receiptImpact, receiptRevision: item.receiptRevision ?? null, createdAt: item.createdAt})), receipts: receipts.map(item => ({revision: item.revision, previousRevision: item.previousRevision ?? null, sha256: item.sha256, createdAt: item.createdAt, superseded: item.revision !== row?.receiptRevision}))};
 }
 async edit(id: string, raw: OfflineEditInput, actor: Types.ObjectId, key: string) {
  const input = offlineEditBody.parse(raw);
  if (!/^[a-zA-Z0-9_-]{16,200}$/.test(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid correction request key is required");
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const execute = () => mongoose.connection.transaction(async session => {
   const replay = await DonationCorrection.findOne({donation: id, actor, requestKey: key}).select("+requestHash").session(session);
   if (replay) {
    if (replay.requestHash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "The correction request key was already used with different values");
    return {id, version: replay.version, replayed: true};
   }
   const row = await Donation.findById(id).session(session);
   if (!row) missing("Donation");
   if (row.source !== "offline" || row.paymentMethod !== "offline" || !["pending", "completed", "rejected"].includes(row.status)) throw new AppError(409, "OFFLINE_EDIT_ONLY", "Only Pending, Completed and Rejected offline donations can be corrected");
   if ((row.correctionVersion ?? 0) !== input.expectedVersion) throw conflict();
   if (row.confirmedPaymentAttempt || await PaymentAttempt.exists({donation: id}).session(session) || await PaymentAdjustment.exists({donation: id}).session(session)) throw new AppError(409, "FINANCIAL_REVIEW_REQUIRED", "This record has payment lifecycle data and requires a separate financial review");
   const previousUser = row.user ? String(row.user) : null;
   const reassigned = input.donorId !== previousUser;
   if (reassigned && (!input.donorId || !input.confirmDonorReassignment)) throw new AppError(422, "DONOR_CONFIRMATION_REQUIRED", "Confirm reassignment to the selected existing donor account");
   let donorName = input.donorName, donorEmail = input.donorEmail, donorPhone = input.donorPhone;
   const identityChanged = donorName !== row.donorName || donorEmail !== row.donorEmail || donorPhone !== (row.donorPhone ?? "");
   if (input.donorId && (reassigned || identityChanged)) {
    const donor = await User.findOne({_id: input.donorId, status: "active", role: "donor"}).session(session);
    if (!donor) missing("Active donor");
    // Unchanged identity snapshots remain stable. A changed snapshot must match the account.
    donorName = donor.name; donorEmail = donor.email; donorPhone = donor.phone ?? "";
   }
   const designationChanged = input.type !== row.type || (input.giving ?? null) !== (row.giving ? String(row.giving) : null) || (input.event ?? null) !== (row.event ? String(row.event) : null) || input.amountCents !== row.amountCents;
   const designation = designationChanged ? await resolveDonationDesignation(input, true, session) : {title: row.designationTitle, festivalTitle: row.festivalTitle, donationOptionTitle: row.donationOptionTitle, giving: row.giving ? await Giving.findById(row.giving).session(session) : undefined};
   const purpose = validateDonationPurpose(input.donationPurpose, designation);
   const donationDate = new Date(input.donationDate);
   const values: Record<string, unknown> = {user: input.donorId, donorName, donorEmail, donorPhone, type: input.type, giving: input.giving, event: input.event, designationTitle: designation.title, festivalTitle: designation.festivalTitle, donationOptionTitle: designation.donationOptionTitle, donationPurpose: purpose, amountCents: input.amountCents, donationDate, offlinePaymentMethod: input.offlinePaymentMethod, offlineReference: input.offlineReference, adminNote: input.adminNote};
   if (input.amountCents !== row.amountCents && typeof row.totalChargedCents === "number") values.totalChargedCents = input.amountCents + (row.feeContributionCents ?? 0);
   if (input.amountCents !== row.amountCents && typeof row.netProceedsCents === "number") values.netProceedsCents = row.netProceedsCents + input.amountCents - row.amountCents;
   const before = {...row.toObject(), donationDate: row.donationDate ?? row.createdAt} as Record<string, unknown>;
   const changes: Record<string, {before: ReturnType<typeof scalar>; after: ReturnType<typeof scalar>}> = {};
   for (const [field, value] of Object.entries(values)) if (scalar(before[field]) !== scalar(value)) changes[field] = {before: scalar(before[field]), after: scalar(value)};
   if (!Object.keys(changes).length) throw new AppError(422, "NO_CORRECTION_CHANGES", "Change at least one field before saving a correction");
   const receiptImpact = Object.keys(changes).some(field => field !== "adminNote");
   let revision = row.receiptRevision ?? 0;
   if (row.status === "completed" && receiptImpact) {
    await Donation.updateOne({_id: row._id}, {$inc: {receiptLock: 1}}, {session, timestamps: false});
    if (!row.verifiedBy || !row.verifiedAt) throw new AppError(409, "RECEIPT_NOT_ELIGIBLE", "The completed offline donation must have verified provenance");
    if (!row.receiptHistoryTracked) throw new AppError(409, "HISTORICAL_RECEIPT_UNAVAILABLE", "The original issued receipt was not archived. Receipt-impacting corrections are blocked until its original content can be reliably recovered. Internal notes can still be corrected.");
    if (!revision) {await saveReceiptSnapshot(row.toObject(), 1, session); revision = 1;}
    else {
     const snapshot = await DonationReceipt.findOne({donation: id, revision}).select("+bytes").session(session);
     if (!snapshot || createHash("sha256").update(Buffer.from(snapshot.bytes)).digest("hex") !== snapshot.sha256) throw new AppError(409, "RECEIPT_SNAPSHOT_MISSING", "The original receipt snapshot is missing or fails integrity verification; correction blocked");
    }
   }
   const set: Record<string, unknown> = {}, unset: Record<string, ""> = {};
   for (const field of Object.keys(changes)) {
    if (values[field] === undefined || values[field] === null || values[field] === "") unset[field] = "";
    else set[field] = values[field];
   }
   if (row.status !== "completed") set.receiptHistoryTracked = true;
   if (row.status === "completed" && receiptImpact) set.receiptRevision = ++revision;
   // Offline monetary derivatives, when present, track the corrected base without inventing fees.
   const updated = await Donation.findOneAndUpdate({_id: id, source: "offline", status: row.status, $expr: {$eq: [{$ifNull: ["$correctionVersion", 0]}, input.expectedVersion]}}, {$set: set, ...(Object.keys(unset).length ? {$unset: unset} : {}), $inc: {correctionVersion: 1}}, {session, returnDocument: "after", runValidators: true});
   if (!updated) throw conflict();
   if (row.status === "completed" && receiptImpact) await saveReceiptSnapshot(updated.toObject(), revision, session);
   await DonationCorrection.create([{donation: row._id, actor, version: updated.correctionVersion, requestKey: key, requestHash: hash, reason: input.reason, changes, receiptImpact, receiptRevision: revision || undefined}], {session});
   return {id, version: updated.correctionVersion, replayed: false};
  });
  try {return await execute();} catch (error) {
   // A unique-key race is retried only if the committed request identity already exists.
   if (typeof error === "object" && error && "code" in error && error.code === 11000 && await DonationCorrection.exists({donation: id, actor, requestKey: key})) return execute();
   throw error;
  }
 }
}
