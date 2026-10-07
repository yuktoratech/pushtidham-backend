import { Giving } from "../models/giving.js";
import { Event } from "../models/event.js";
import { Donation } from "../models/donation.js";
import type { GivingInput, EventInput } from "../validators/catalog.js";
import type { ListQuery } from "../validators/common.js";
import { paginate, escapeRegex } from "../utils/pagination.js";
import { missing, AppError } from "../utils/errors.js";
export class CatalogService {
  async listGiving(
    query: ListQuery & {
      status?: string;
    },
    admin = false,
  ) {
    return paginate(
      Giving,
      {
        deletedAt: null,
        ...(admin
          ? query.status
            ? { status: query.status }
            : {}
          : { status: "active" }),
        ...(query.search
          ? { title: { $regex: escapeRegex(query.search), $options: "i" } }
          : {}),
      },
      query,
      { displayOrder: 1, _id: 1 },
    );
  }
  async listEvents(
    query: ListQuery & {
      status?: string;
    },
    admin = false,
  ) {
    return paginate(
      Event,
      {
        deletedAt: null,
        ...(admin
          ? query.status
            ? { status: query.status }
            : {}
          : { status: "published" }),
        ...(query.search
          ? { title: { $regex: escapeRegex(query.search), $options: "i" } }
          : {}),
      },
      query,
      { startsAt: 1, _id: 1 },
    );
  }
  async get(kind: "giving" | "event", key: string, admin = false) {
    const filter: Record<string, unknown> = {
      ...(admin
        ? { _id: key }
        : { slug: key, status: kind === "giving" ? "active" : "published" }),
      deletedAt: null,
    };
    const doc =
      kind === "giving"
        ? await Giving.findOne(filter)
        : await Event.findOne(filter);
    return doc ?? missing(kind);
  }
  async createGiving(input: GivingInput) {
    return Giving.create({
      title: input.title,
      slug: input.slug,
      description: input.description,
      amountType: input.amountType,
      fixedAmountsCents:
        input.amountType === "custom" ? [] : input.fixedAmountsCents,
      status: input.status,
      displayOrder: input.displayOrder,
    });
  }
  async createEvent(input: EventInput) {
    return Event.create({
      title: input.title,
      slug: input.slug,
      shortDescription: input.shortDescription,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      image: input.image,
      status: input.status,
    });
  }
  async replaceGiving(id: string, input: GivingInput) {
    const doc = await Giving.findOne({ _id: id, deletedAt: null });
    if (!doc) missing("Giving");
    doc.set({
      title: input.title,
      slug: input.slug,
      description: input.description,
      amountType: input.amountType,
      fixedAmountsCents:
        input.amountType === "custom" ? [] : input.fixedAmountsCents,
      status: input.status,
      displayOrder: input.displayOrder,
    });
    return doc.save();
  }
  async replaceEvent(id: string, input: EventInput) {
    const doc = await Event.findOne({ _id: id, deletedAt: null });
    if (!doc) missing("Event");
    doc.set({
      title: input.title,
      slug: input.slug,
      shortDescription: input.shortDescription,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      image: input.image,
      status: input.status,
    });
    return doc.save();
  }
  async status(kind: "giving" | "event", id: string, status: string) {
    const update = { $set: { status } };
    const doc =
      kind === "giving"
        ? await Giving.findOneAndUpdate({ _id: id, deletedAt: null }, update, {
            returnDocument: "after",
            runValidators: true,
          })
        : await Event.findOneAndUpdate({ _id: id, deletedAt: null }, update, {
            returnDocument: "after",
            runValidators: true,
          });
    return doc ?? missing(kind);
  }
  async remove(kind: "giving" | "event", id: string) {
    if (await Donation.exists({ [kind]: id }))
      throw new AppError(
        409,
        "HAS_DONATIONS",
        "Deactivate this designation to preserve donation history",
      );
    const doc =
      kind === "giving"
        ? await Giving.findOneAndUpdate(
            { _id: id, deletedAt: null },
            { $set: { status: "inactive", deletedAt: new Date() } },
          )
        : await Event.findOneAndUpdate(
            { _id: id, deletedAt: null },
            { $set: { status: "inactive", deletedAt: new Date() } },
          );
    if (!doc) missing(kind);
  }
}
