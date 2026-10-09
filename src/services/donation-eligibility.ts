import { Types } from "mongoose";
import { Event } from "../models/event.js";
import { Giving } from "../models/giving.js";
import { User } from "../models/user.js";
import { AppError, missing } from "../utils/errors.js";

export type DonationDesignation = {
  type: "general" | "event";
  giving?: string;
  event?: string;
  amountCents: number;
};

export async function resolveDonationDesignation(
  input: DonationDesignation,
  offline = false,
) {
  if (input.type === "general") {
    if (!input.giving || input.event)
      throw new AppError(400, "INVALID_DESIGNATION", "General requires only Giving");
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
    return { title: giving.title, giving };
  }
  if (!input.event || input.giving)
    throw new AppError(400, "INVALID_DESIGNATION", "Event requires only Event");
  const event = await Event.findOne({
    _id: input.event,
    ...(offline ? {} : { deletedAt: null, status: "published" }),
  });
  if (!event) missing(offline ? "Event" : "Published Event");
  return { title: event.title, event };
}

export async function requireActiveDonationUser(user?: Types.ObjectId) {
  if (user && !(await User.exists({ _id: user, status: "active" })))
    missing("Active user");
}
