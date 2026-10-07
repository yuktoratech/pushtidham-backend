import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { Donation } from "../models/donation.js";
import { Giving } from "../models/giving.js";
import { Event } from "../models/event.js";
import { User } from "../models/user.js";
import type { DonationInput, DonationQuery } from "../validators/donation.js";
import { AppError, missing } from "../utils/errors.js";
import { paginate, escapeRegex } from "../utils/pagination.js";
export class DonationService {
  async create(input: DonationInput, actor?: Types.ObjectId, offline = false) {
    let title: string;
    if (input.type === "general") {
      const giving = await Giving.findOne({
        _id: input.giving,
        deletedAt: null,
        status: "active",
      });
      if (!giving) missing("Active Giving");
      if (
        giving.amountType === "fixed" &&
        !giving.fixedAmountsCents.includes(input.amountCents)
      )
        throw new AppError(
          400,
          "INVALID_AMOUNT",
          "Amount must match a configured fixed amount",
        );
      title = giving.title;
    } else {
      const event = await Event.findOne({
        _id: input.event,
        ...(offline ? {} : { deletedAt: null, status: "published" }),
      });
      if (!event) missing(offline ? "Event" : "Published Event");
      title = event.title;
    }
    const user =
      offline && "user" in input && input.user
        ? new Types.ObjectId(input.user)
        : offline
          ? undefined
          : actor;
    if (user && !(await User.exists({ _id: user, status: "active" })))
      missing("Active user");
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
  async list(query: DonationQuery, user?: Types.ObjectId) {
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
    return {
      ...result,
      data: user ? result.data.map((d) => this.donorView(d)) : result.data,
    };
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
  async get(id: string, user?: Types.ObjectId) {
    const doc = await Donation.findOne({
      _id: id,
      ...(user ? { user } : {}),
    }).lean();
    if (!doc) missing("Donation");
    return user ? this.donorView(doc) : doc;
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
