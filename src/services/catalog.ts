import { Giving } from "../models/giving.js";
import { Event } from "../models/event.js";
import { Donation } from "../models/donation.js";
import { GivingCategory } from "../models/giving-category.js";
import type { GivingInput, EventInput } from "../validators/catalog.js";
import type { GivingCategoryInput } from "../validators/catalog.js";
import type { ListQuery } from "../validators/common.js";
import { paginate, escapeRegex } from "../utils/pagination.js";
import { missing, AppError } from "../utils/errors.js";
import type { ImageStorage } from "./image-storage.js";
import {ImageCleanupService} from "./image-cleanup.js";
export class CatalogService {
  private readonly cleanup: ImageCleanupService;
  constructor(images?: ImageStorage) {this.cleanup = new ImageCleanupService(images);}

  private async createWithSlug<T>(kind: "giving" | "event", title: string, requested: string | undefined, create: (slug: string) => Promise<T>): Promise<T> {
    if (requested) return create(requested);
    const base = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 150).replace(/-$/g, "") || kind;
    for (let attempt = 1; attempt <= 100; attempt++) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const candidate = `${base.slice(0, 160 - suffix.length)}${suffix}`;
      try {return await create(candidate);} catch (error) {
        if ((error as {code?: number}).code !== 11000) throw error;
      }
    }
    throw new AppError(409, "SLUG_CONFLICT", "Could not allocate a unique URL slug");
  }

  private async validateCategory(categoryId: string | undefined, status: string) {
    if (!categoryId) return;
    const category = await GivingCategory.findById(categoryId);
    if (!category || (status === "active" && category.status !== "active"))
      throw new AppError(422, "INVALID_CATEGORY", "Choose an active Giving category");
  }
  private async givingCategoryFor(input: GivingInput, current?: {category?: string; festivalGroup?: string}) {
    const section = input.category ?? current?.category ?? "general";
    const festival = section === "utsav" ? input.festivalGroup ?? current?.festivalGroup : "";
    const slug = section === "daily_seva" ? "daily-seva" : section === "general" ? "general-donation" : festival;
    if (!slug) throw new AppError(422, "INVALID_CATEGORY", "Choose a festival group for Utsav");
    const category = await GivingCategory.findOne({slug});
    if (!category || (input.status === "active" && category.status !== "active"))
      throw new AppError(422, "INVALID_CATEGORY", "The category for this catalog section or festival is unavailable. Contact the developer.");
    if (input.categoryId && input.categoryId !== String(category._id))
      throw new AppError(422, "CATEGORY_MISMATCH", "Giving category must match the catalog section and festival group");
    return category._id;
  }
  async listGivingCategories(query: ListQuery & {status?: string}, admin = false) {
    return paginate(GivingCategory, {
      ...(admin ? (query.status ? {status: query.status} : {}) : {status: "active"}),
      ...(query.search ? {name: {$regex: escapeRegex(query.search), $options: "i"}} : {}),
    }, query, {displayOrder: 1, _id: 1});
  }
  async getGivingCategory(key: string, admin = false) {
    const doc = await GivingCategory.findOne({...(admin ? {_id: key} : {slug: key, status: "active"})});
    return doc ?? missing("Giving Category");
  }
  async createGivingCategory(input: GivingCategoryInput) {
    return this.createWithSlug("giving", input.name, input.slug, slug => GivingCategory.create({...input, slug}));
  }
  async replaceGivingCategory(id: string, input: GivingCategoryInput) {
    const doc = await GivingCategory.findById(id);
    if (!doc) missing("Giving Category");
    if (await Giving.exists({categoryId: id, status: "active", deletedAt: null}) && input.status === "inactive")
      throw new AppError(409, "CATEGORY_HAS_GIVINGS", "Deactivate or remap its Giving records first");
    const cleanup = await this.cleanup.schedule(doc.image !== input.image ? [doc.image] : []);
    doc.set({...input, slug: input.slug ?? doc.slug});
    const saved = await doc.save();
    await this.cleanup.process(cleanup);
    return saved;
  }
  async statusGivingCategory(id: string, status: string) {
    if (status === "inactive" && await Giving.exists({categoryId: id, status: "active", deletedAt: null}))
      throw new AppError(409, "CATEGORY_HAS_GIVINGS", "Deactivate or remap its Giving records first");
    const doc = await GivingCategory.findByIdAndUpdate(id, {$set: {status}}, {returnDocument: "after", runValidators: true});
    return doc ?? missing("Giving Category");
  }
  async removeGivingCategory(id: string) {
    if (await Giving.exists({categoryId: id})) throw new AppError(409, "CATEGORY_HAS_GIVINGS", "Category is assigned to Giving records");
    const doc = await GivingCategory.findById(id);
    if (!doc) missing("Giving Category");
    const cleanup = await this.cleanup.schedule([doc.image]);
    await doc.deleteOne();
    await this.cleanup.process(cleanup);
  }
  async listGiving(
    query: ListQuery & {
      status?: string;
      categoryId?: string;
    },
    admin = false,
  ) {
    const activeIds = admin ? [] : await GivingCategory.find({status: "active"}).distinct("_id");
    return paginate(
      Giving,
      {
        deletedAt: null,
        ...(query.categoryId ? {categoryId: query.categoryId} : {}),
        ...(!admin ? {$or: [{categoryId: {$exists: false}}, {categoryId: null}, {categoryId: {$in: activeIds}}]} : {}),
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
    if (!admin && kind === "giving" && doc && "categoryId" in doc && doc.categoryId) await this.validateCategory(String(doc.categoryId), "active");
    return doc ?? missing(kind);
  }
  async createGiving(input: GivingInput) {
    const categoryId = await this.givingCategoryFor(input);
    return this.createWithSlug("giving", input.title, input.slug, slug => Giving.create({
      title: input.title,
      categoryId,
      slug,
      category: input.category ?? "general",
      festivalGroup: input.festivalGroup ?? "",
      description: input.description,
      image: input.image,
      amountType: input.amountType,
      fixedAmountsCents:
        input.amountType === "custom" ? [] : input.fixedAmountsCents,
      status: input.status,
      displayOrder: input.displayOrder,
    }));
  }
  async createEvent(input: EventInput) {
    return this.createWithSlug("event", input.title, input.slug, slug => Event.create({
      title: input.title,
      slug,
      shortDescription: input.shortDescription,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      image: input.image,
      gallery: input.gallery,
      status: input.status,
    }));
  }
  async replaceGiving(id: string, input: GivingInput) {
    const doc = await Giving.findOne({ _id: id, deletedAt: null });
    if (!doc) missing("Giving");
    const categoryId = await this.givingCategoryFor(input, doc);
    const cleanup = await this.cleanup.schedule(doc.image !== input.image ? [doc.image] : []);
    doc.set({
      title: input.title,
      categoryId,
      slug: input.slug ?? doc.slug,
      category: input.category ?? doc.category,
      festivalGroup: (input.category ?? doc.category) === "utsav" ? input.festivalGroup ?? doc.festivalGroup : "",
      description: input.description,
      image: input.image,
      amountType: input.amountType,
      fixedAmountsCents:
        input.amountType === "custom" ? [] : input.fixedAmountsCents,
      status: input.status,
      displayOrder: input.displayOrder,
    });
    const saved = await doc.save();
    await this.cleanup.process(cleanup);
    return saved;
  }
  async replaceEvent(id: string, input: EventInput) {
    const doc = await Event.findOne({ _id: id, deletedAt: null });
    if (!doc) missing("Event");
    const nextImages = new Set([input.image, ...(input.gallery ?? doc.gallery).map(row => row.url)]);
    const cleanup = await this.cleanup.schedule([doc.image, ...doc.gallery.map(row => row.url)].filter(url => !nextImages.has(url)));
    doc.set({
      title: input.title,
      slug: input.slug ?? doc.slug,
      shortDescription: input.shortDescription,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      image: input.image,
      ...(input.gallery !== undefined ? {gallery: input.gallery} : {}),
      status: input.status,
    });
    const saved = await doc.save();
    await this.cleanup.process(cleanup);
    return saved;
  }
  async status(kind: "giving" | "event", id: string, status: string) {
    if (kind === "giving") {
      const giving = await Giving.findOne({_id: id, deletedAt: null});
      if (!giving) missing("Giving");
      await this.validateCategory(giving.categoryId ? String(giving.categoryId) : undefined, status);
    }
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
    const original = kind === "giving" ? await Giving.findOne({_id: id, deletedAt: null}) : await Event.findOne({_id: id, deletedAt: null});
    if (!original) missing(kind);
    const cleanup = await this.cleanup.schedule([original.image, ...("gallery" in original ? original.gallery.map(row => row.url) : [])]);
    const doc =
      kind === "giving"
        ? await Giving.findOneAndUpdate(
            { _id: id, deletedAt: null },
            { $set: { status: "inactive", deletedAt: new Date(), image: "" } },
          )
        : await Event.findOneAndUpdate(
            { _id: id, deletedAt: null },
            { $set: { status: "inactive", deletedAt: new Date(), image: "", gallery: [] } },
          );
    if (!doc) missing(kind);
    await this.cleanup.process(cleanup);
  }
}
