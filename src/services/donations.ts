import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { Donation } from "../models/donation.js";
import type { DonationInput, DonationQuery } from "../validators/donation.js";
import { AppError, missing } from "../utils/errors.js";
import { paginate, escapeRegex } from "../utils/pagination.js";
import {
  requireActiveDonationUser,
  resolveDonationDesignation,
} from "./donation-eligibility.js";
import { donationViews } from "./donation-views.js";
export class DonationService {
  async create(input: DonationInput, actor?: Types.ObjectId, offline = false) {
    const { title } = await resolveDonationDesignation(input, offline);
    const user =
      offline && "user" in input && input.user
        ? new Types.ObjectId(input.user)
        : offline
          ? undefined
          : actor;
    await requireActiveDonationUser(user);
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
      amountCents: input.amountCents,
      currency: "USD" as const,
      paymentMethod: offline
        ? ("offline" as const)
        : "paymentMethod" in input
          ? input.paymentMethod
          : ("offline" as const),
      source: offline ? ("offline" as const) : ("online" as const),
      status,
      bankReference: "bankReference" in input ? input.bankReference : undefined,
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
        return await Donation.create({
          ...base,
          donationNumber:
            "PD-" +
            now.toISOString().slice(0, 10).replaceAll("-", "") +
            "-" +
            randomBytes(8).toString("hex").toUpperCase(),
        });
      } catch (error) {
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
    const filter: Record<string, unknown> = {};
    if (user) filter.user = user;
    for (const key of [
      "type",
      "paymentMethod",
      "status",
      "source",
      "giving",
      "event",
    ] as const)
      if (query[key]) filter[key] = query[key];
    if (query.from || query.to)
      filter.createdAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    if (query.search) {
      const regex = { $regex: escapeRegex(query.search), $options: "i" };
      filter.$or = [
        { donationNumber: regex },
        { donorName: regex },
        { donorEmail: regex },
      ];
    }
    const result = await paginate(Donation, filter, query);
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
