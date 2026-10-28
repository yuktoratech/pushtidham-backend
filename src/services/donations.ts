import { randomBytes } from "node:crypto";
import { Types, type ClientSession } from "mongoose";
import { Donation } from "../models/donation.js";
import type { DonationInput, DonationQuery } from "../validators/donation.js";
import { AppError, missing } from "../utils/errors.js";
import { paginate, escapeRegex } from "../utils/pagination.js";
import {
  requireActiveDonationUser,
  resolveDonationDesignation,
  validateDonationPurpose,
} from "./donation-eligibility.js";
import { donationViews } from "./donation-views.js";
import {donationStatusStages} from './donation-status.js';
export class DonationService {
  async create(input: DonationInput, actor?: Types.ObjectId, offline = false, options: {session?: ClientSession; donationNumber?: string; requestHash?: string} = {}) {
    if (!offline)
      throw new AppError(422, "PAYMENT_METHOD_UNAVAILABLE", "Public donations require Card checkout");
    const designation = await resolveDonationDesignation(input, offline, options.session);
    const { title, festivalTitle, donationOptionTitle } = designation;
    const donationPurpose = validateDonationPurpose(input.donationPurpose, designation);
    const user =
      offline && "user" in input && input.user
        ? new Types.ObjectId(input.user)
        : offline
          ? undefined
          : actor;
    await requireActiveDonationUser(user, options.session);
    const status = offline && "status" in input ? input.status : "pending";
    const now = new Date();
    const base = {
      user,
      donorName: input.donorName,
      donorEmail: input.donorEmail,
      donorPhone: input.donorPhone,
      type: input.type,
      giving: input.giving,
      event: input.event,
      designationTitle: title,
      donationPurpose,
      festivalTitle,
      donationOptionTitle,
      amountCents: input.amountCents,
      currency: "USD" as const,
      paymentMethod: "offline" as const,
      offlinePaymentMethod: input.offlinePaymentMethod ?? "other",
      offlineRequestHash: options.requestHash,
      source: "offline" as const,
      status,
      offlineReference:
        "offlineReference" in input ? input.offlineReference : undefined,
      adminNote: "adminNote" in input ? input.adminNote : undefined,
      ...(offline && status !== "pending"
        ? {
            verifiedBy: actor,
            verifiedAt: now,
            ...(status === "completed"
              ? { completedAt: now }
              : { rejectedAt: now }),
          }
        : {}),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = new Donation({
          ...base,
          donationNumber: options.donationNumber ??
            "PD-" +
            now.toISOString().slice(0, 10).replaceAll("-", "") +
            "-" +
            randomBytes(8).toString("hex").toUpperCase(),
        });
        return await doc.save({session: options.session});
      } catch (error) {
        if (options.session) throw error;
        if (!(
          typeof error === "object" &&
          error &&
          "code" in error &&
          error.code === 11000 &&
          "keyPattern" in error &&
          JSON.stringify(error.keyPattern).includes("donationNumber")
        ))
          throw error;
      }
    }
    throw new AppError(
      503,
      "REFERENCE_UNAVAILABLE",
      "Please retry donation creation",
    );
  }
  async list(query: DonationQuery, user?: Types.ObjectId, admin = false) {
    const filter = donationFilter(query, user);
    let result;
    if (query.status) {
      const [facet] = await Donation.aggregate([
        {$match: filter}, ...donationStatusStages(), {$match: {_displayStatus: query.status}},
        {$facet: {data: [{$sort: {createdAt: -1, _id: -1}}, {$skip: (query.page - 1) * query.limit}, {$limit: query.limit}, {$unset: ['_statusAttempts', '_statusAttempt', '_displayStatus']}], count: [{$count: 'total'}]}},
      ]);
      const total = Number(facet?.count[0]?.total ?? 0);
      result = {data: facet?.data ?? [], pagination: {page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit)}};
    } else result = await paginate(Donation, filter, query);
    return { ...result, data: await donationViews(result.data as unknown as Array<Record<string,unknown> & {_id:Types.ObjectId}>, admin) };
  }
  donorView(doc: Record<string, unknown>) {
    const {
      _id,
      donationNumber,
      donorName,
      donorEmail,
      donorPhone,
      type,
      giving,
      event,
      designationTitle,
      amountCents,
      currency,
      paymentMethod,
      status,
      source,
      createdAt,
      updatedAt,
      completedAt,
      rejectedAt,
    } = doc;
    return {
      _id,
      donationNumber,
      donorName,
      donorEmail,
      donorPhone,
      type,
      giving,
      event,
      designationTitle,
      amountCents,
      currency,
      paymentMethod,
      status,
      source,
      createdAt,
      updatedAt,
      completedAt,
      rejectedAt,
    };
  }
  async get(id: string, user?: Types.ObjectId, admin = false) {
    const doc = await Donation.findOne({
      _id: id,
      ...(user ? { user } : {}),
    }).lean();
    if (!doc) missing("Donation");
    return (await donationViews([doc as unknown as Record<string,unknown> & {_id:Types.ObjectId}],admin))[0];
  }
  async status(
    id: string,
    input: {
      status: "completed" | "rejected";
      adminNote?: string;
    },
    actor: Types.ObjectId,
  ) {
    const current = await Donation.findById(id);
    if (!current) missing("Donation");
    if (input.status === "completed" && current.source !== "offline")
      throw new AppError(
        409,
        "PAYMENT_NOT_IMPLEMENTED",
        "Online completion requires a future payment verification integration",
      );
    const now = new Date();
    const doc = await Donation.findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: input.status,
          verifiedBy: actor,
          verifiedAt: now,
          ...(input.status === "completed"
            ? { completedAt: now }
            : { rejectedAt: now }),
          ...(input.adminNote !== undefined
            ? { adminNote: input.adminNote }
            : {}),
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!doc)
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        "Only pending donations can transition to a final status",
      );
    return doc;
  }
}
export function donationFilter(query: DonationQuery, user?: Types.ObjectId) {
  const filter: Record<string, unknown> = {};
  if (user) filter.user = user;
  for (const key of ["type", "paymentMethod", "source", "giving", "event"] as const)
    if (query[key]) filter[key] = key === 'giving' || key === 'event' ? new Types.ObjectId(query[key]) : query[key];
  if (query.from || query.to) filter.createdAt = {...(query.from ? {$gte: new Date(query.from)} : {}), ...(query.to ? {$lte: new Date(query.to)} : {})};
  if (query.search) {
    const regex = {$regex: escapeRegex(query.search), $options: "i"};
    filter.$or = [{donationNumber: regex}, {donorName: regex}, {donorEmail: regex}];
  }
  return filter;
}
