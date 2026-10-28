import { Types, type ClientSession } from "mongoose";
import { Event } from "../models/event.js";
import { Giving } from "../models/giving.js";
import { GivingCategory } from "../models/giving-category.js";
import { User } from "../models/user.js";
import { AppError, missing } from "../utils/errors.js";
import {festivalGroups} from "../content/client-catalog.js";

export type DonationDesignation = {
  type: "general" | "event";
  giving?: string;
  categoryId?: string;
  event?: string;
  amountCents: number;
};

export async function resolveDonationDesignation(
  input: DonationDesignation,
  offline = false,
  session?: ClientSession,
) {
  if (input.giving) {
    if (input.event)
      throw new AppError(400, "INVALID_DESIGNATION", "General requires only Giving");
    const giving = await Giving.findOne({
      _id: input.giving,
      deletedAt: null,
      status: "active",
    }).session(session ?? null);
    if (!giving) missing("Active Giving");
    if (giving.slug === "other" && (giving.category !== "general" || giving.amountType !== "custom" || giving.fixedAmountsCents.length))
      throw new AppError(409, "INVALID_OTHER_CONFIGURATION", "Other Giving must be a custom-only General Donation");
    if (input.categoryId && String(giving.categoryId) !== input.categoryId)
      throw new AppError(422, "CATEGORY_MISMATCH", "Giving does not belong to the selected category");
    if (!offline && giving.categoryId && !(await GivingCategory.exists({_id: giving.categoryId, status: "active"})))
      throw new AppError(422, "INVALID_CATEGORY", "Giving category is inactive");
    const utsav = giving.category === "utsav";
    if ((input.type === "event") !== utsav) throw new AppError(400, "INVALID_DESIGNATION", "Utsav options require Event; other Giving requires General");
    if (utsav && (giving.amountType !== "fixed" || giving.fixedAmountsCents.length !== 1)) throw new AppError(400, "INVALID_DESIGNATION", "Festival option must have one configured fixed amount");
    if (
      giving.amountType === "fixed" &&
      !giving.fixedAmountsCents.includes(input.amountCents)
    )
      throw new AppError(
        400,
        "INVALID_AMOUNT",
        "Amount must match a configured fixed amount",
      );
    const festivalTitle = utsav ? festivalGroups[giving.festivalGroup as keyof typeof festivalGroups] : undefined;
    if (utsav && !festivalTitle) throw new AppError(400, "INVALID_DESIGNATION", "Festival configuration is invalid");
    return { title: festivalTitle ? `${festivalTitle} — ${giving.title}` : giving.title, giving, festivalTitle, donationOptionTitle: festivalTitle ? giving.title : undefined };
  }
  if (input.type !== "event" || !input.event || input.giving)
    throw new AppError(400, "INVALID_DESIGNATION", "Event requires only Event");
  if (!offline)
    throw new AppError(409, "EVENT_DONATIONS_DISABLED", "Event pages are informational; select a Giving category");
  const event = await Event.findOne({
    _id: input.event,
    ...(offline ? {} : { deletedAt: null, status: "published" }),
  }).session(session ?? null);
  if (!event) missing(offline ? "Event" : "Published Event");
  return { title: event.title, event };
}

export async function requireActiveDonationUser(user?: Types.ObjectId, session?: ClientSession) {
  if (user && !(await User.exists({ _id: user, status: "active" }).session(session ?? null)))
    missing("Active user");
}

export function validateDonationPurpose(
  purpose: string | undefined,
  designation: Awaited<ReturnType<typeof resolveDonationDesignation>>,
) {
  const normalized = purpose?.trim();
  const isOther = "giving" in designation && designation.giving?.slug === "other";
  if (isOther && !normalized)
    throw new AppError(422, "DONATION_PURPOSE_REQUIRED", "Donation purpose is required for Other");
  if (normalized && normalized.length > 500)
    throw new AppError(422, "INVALID_DONATION_PURPOSE", "Donation purpose must be 500 characters or fewer");
  return normalized || undefined;
}
