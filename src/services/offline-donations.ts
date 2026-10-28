import {createHash, randomBytes} from "node:crypto";
import bcrypt from "bcrypt";
import mongoose, {Types} from "mongoose";
import {User} from "../models/user.js";
import {Donation} from "../models/donation.js";
import {BCRYPT_COST} from "../constants/domain.js";
import {AppError, missing} from "../utils/errors.js";
import {escapeRegex} from "../utils/pagination.js";
import {offlineBody, type DonationInput} from "../validators/donation.js";
import {DonationService} from "./donations.js";
import {AuthService} from "./auth.js";
import type {MailSender} from "./mail.js";

const publicDonation = (doc: InstanceType<typeof Donation>) => {
  const record = doc.toObject();
  Reflect.deleteProperty(record, "offlineRequestHash");
  return record;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const donorView = (user: { _id: Types.ObjectId; name: string; email: string; phone?: string; passwordSetupRequired?: boolean; welcomeEmailStatus?: string | null }) => ({
  id: String(user._id), name: user.name, email: user.email, phone: user.phone ?? "",
  setupRequired: user.passwordSetupRequired === true,
  welcomeEmailStatus: user.welcomeEmailStatus ?? null,
});

/** Durable welcome task is stored with the new User in the donation transaction.
 * Dispatch runs only after commit. Crashed/failed tasks remain available to admin retry.
 * SMTP is at-least-once; the lease prevents parallel sends and never retries donation creation.
 */
export class OfflineDonationService {
  constructor(private donations: DonationService, private auth: AuthService, private mail: MailSender | undefined, private frontendUrl: string) {}

  async search(email: string) {
    const normalized = email.trim().toLowerCase();
    if (normalized.length < 3 || normalized.length > 254) return [];
    const users = await User.find({role: "donor", status: "active", email: {$regex: "^" + escapeRegex(normalized), $options: "i"}})
      .select("name email phone passwordSetupRequired welcomeEmailStatus").sort({email: 1}).limit(8).lean();
    return users.map(donorView);
  }

  async create(raw: DonationInput, actor: Types.ObjectId, key: string) {
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key))
      throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key is required");
    const input = offlineBody.parse(raw);
    const requestHash = digest(JSON.stringify(input));
    // Existing unique donationNumber index provides cross-process deduplication, without a migration.
    const number = "PD-OFF-" + digest(String(actor) + ":" + key).slice(0, 40).toUpperCase();
    for (let retry = 0; retry < 3; retry++) {
      try {
        const result = await mongoose.connection.transaction(async session => {
          const existing = await Donation.findOne({donationNumber: number}).select("+offlineRequestHash").session(session);
          if (existing) {
            if (existing.offlineRequestHash !== requestHash)
              throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This request was already used for different donation details");
            const user = await User.findById(existing.user).session(session);
            if (!user) missing("Donor");
            return {...publicDonation(existing), id: String(existing._id), donationNumber: existing.donationNumber, donor: donorView(user), replayed: true};
          }
          // Never link by client supplied ID alone, or overwrite an existing account's details.
          let user = await User.findOne({email: input.donorEmail}).session(session);
          if (input.user && (!user || String(user._id) !== input.user))
            throw new AppError(422, "DONOR_MISMATCH", "Selected donor and email do not match");
          if (user && (user.role !== "donor" || user.status !== "active"))
            throw new AppError(409, "DONOR_UNAVAILABLE", "This email cannot be used for a donor account");
          if (!user) {
            const passwordHash = await bcrypt.hash(randomBytes(48).toString("base64url"), BCRYPT_COST);
            const [created] = await User.create([{
              name: input.donorName, email: input.donorEmail, phone: input.donorPhone ?? "",
              passwordHash, role: "donor", status: "active", passwordSetupRequired: true, welcomeEmailStatus: "pending",
            }], {session});
            user = created ?? null;
          }
          if (!user) throw new AppError(503, "DONOR_UNAVAILABLE", "Unable to prepare donor account");
          const donation = await this.donations.create({...input, user: String(user._id), donorName: user.name,
            donorEmail: user.email, donorPhone: user.phone}, actor, true, {session, donationNumber: number, requestHash});
          return {...publicDonation(donation), id: String(donation._id), donationNumber: donation.donationNumber, donor: donorView(user), replayed: false};
        });
        return result;
      } catch (error) {
        // A simultaneous submission can win the existing unique email or reference index.
        // The failed transaction is aborted; resolve the winner in a fresh transaction.
        if (retry < 2 && error && typeof error === "object" && "code" in error && error.code === 11000) continue;
        throw error;
      }
    }
    throw new AppError(503, "OFFLINE_SAVE_RETRY", "Please retry with the same request");
  }

  dispatch(userId: string) {
    // No email before commit and no email latency in the save response.
    setImmediate(() => { void this.deliverWelcome(userId).catch(() => { /* Lease expiry permits safe admin retry. No credentials or tokens logged. */ }); });
  }

  async retryWelcome(userId: string) {
    const user = await User.findOne({_id: userId, role: "donor", status: "active", passwordSetupRequired: true});
    if (!user) throw new AppError(409, "SETUP_NOT_REQUIRED", "This account no longer needs password setup");
    if (user.welcomeEmailLastAttemptAt && Date.now() - user.welcomeEmailLastAttemptAt.getTime() < 60_000)
      throw new AppError(429, "RETRY_LATER", "Wait one minute before retrying the setup email");
    // Sending an already queued task is safe; deliverWelcome claims it atomically.
    await User.updateOne({_id: user._id, passwordSetupRequired: true, welcomeEmailStatus: {$ne: "sending"}},
      {$set: {welcomeEmailStatus: "pending"}, $unset: {welcomeEmailErrorCode: 1}});
    this.dispatch(userId);
    return {queued: true};
  }

  async deliverWelcome(userId: string) {
    const now = new Date();
    const lease = new Date(now.getTime() + 5 * 60_000);
    const user = await User.findOneAndUpdate({_id: userId, role: "donor", status: "active", passwordSetupRequired: true,
      $or: [{welcomeEmailStatus: {$in: ["pending", "failed"]}}, {welcomeEmailStatus: "sending", welcomeEmailLeaseUntil: {$lt: now}}]},
      {$set: {welcomeEmailStatus: "sending", welcomeEmailLeaseUntil: lease, welcomeEmailLastAttemptAt: now}, $inc: {welcomeEmailAttempts: 1}},
      {returnDocument: "after"});
    if (!user) return;
    try {
      await this.auth.requestPasswordReset(user.email, this.mail, this.frontendUrl, true);
      await User.updateOne({_id: user._id, welcomeEmailLeaseUntil: lease},
        {$set: {welcomeEmailStatus: "sent"}, $unset: {welcomeEmailLeaseUntil: 1, welcomeEmailErrorCode: 1}});
    } catch {
      await User.updateOne({_id: user._id, welcomeEmailLeaseUntil: lease},
        {$set: {welcomeEmailStatus: "failed", welcomeEmailErrorCode: "MAIL_UNAVAILABLE"}, $unset: {welcomeEmailLeaseUntil: 1}});
    }
  }
}
