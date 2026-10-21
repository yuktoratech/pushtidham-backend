import { z } from "zod";
import { id, slug, money, paging } from "./common.js";
import {festivalKeys} from "../content/client-catalog.js";
const catalogImage = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (v) => !v || /^https?:\/\//.test(v) || /^\/[a-zA-Z0-9/_.,-]+$/.test(v),
    "Use HTTP(S) URL or asset path",
  )
  .default("");
const galleryEntry = z.object({url: catalogImage.refine(value => Boolean(value), "Image URL is required"), alt: z.string().max(300).default(""), displayOrder: z.number().int().min(0).max(1000)}).strict();
export const givingCategoryBody = z.object({
  name: z.string().trim().min(1).max(160),
  slug: slug.optional(),
  description: z.string().max(10000).default(""),
  image: catalogImage,
  status: z.enum(["active", "inactive"]).default("active"),
  displayOrder: z.number().int().min(0).max(100000).default(0),
}).strict();
export const givingCategoryStatus = z.object({status: z.enum(["active", "inactive"])}).strict();
export const givingCategoryQuery = z.object({...paging, status: z.enum(["active", "inactive"]).optional()}).strict();
export const givingBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    categoryId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
    category: z.enum(["general", "daily_seva", "utsav"]).optional(),
    festivalGroup: z.enum(["", ...festivalKeys]).optional(),
    slug: slug.optional(),
    description: z.string().max(10000).default(""),
    image: catalogImage,
    amountType: z.enum(["fixed", "custom", "fixed_and_custom"]),
    fixedAmountsCents: z
      .array(money)
      .max(50)
      .default([])
      .transform((a) => [...new Set(a)].sort((a, b) => a - b)),
    status: z.enum(["active", "inactive"]).default("active"),
    displayOrder: z.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .refine((v) => v.amountType === "custom" || v.fixedAmountsCents.length > 0, {
    path: ["fixedAmountsCents"],
    message: "Fixed amounts required",
  }).superRefine((v, ctx) => {
    if (v.category === "utsav" && (!v.festivalGroup || v.amountType !== "fixed" || v.fixedAmountsCents.length !== 1)) ctx.addIssue({code: "custom", path: ["festivalGroup"], message: "Choose a festival and one fixed amount for Utsav"});
    if (v.category && v.category !== "utsav" && v.festivalGroup) ctx.addIssue({code: "custom", path: ["festivalGroup"], message: "Festival group is only for Utsav"});
  });
export const eventBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    slug: slug.optional(),
    shortDescription: z.string().max(500).default(""),
    description: z.string().max(20000).default(""),
    startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    endsAt: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
    location: z.string().trim().min(1).max(500),
    image: catalogImage,
    gallery: z.array(galleryEntry).max(30).optional(),
    status: z.enum(["draft", "published", "inactive"]).default("draft"),
  })
  .strict()
  .refine((v) => !v.endsAt || v.endsAt >= v.startsAt, {
    path: ["endsAt"],
    message: "End must follow start",
  });
export const givingStatus = z
  .object({ status: z.enum(["active", "inactive"]) })
  .strict();
export const eventStatus = z
  .object({ status: z.enum(["draft", "published", "inactive"]) })
  .strict();
export const imageKindParams = z
  .object({ kind: z.enum(["giving", "events", "categories"]) })
  .strict();
const uploadOwnerSlug = z.string().trim().min(1).max(160)
  .refine(value => !/[\\/]/.test(value) && !value.includes("..") && ![...value].some(character => {const code=character.charCodeAt(0);return code<32||code===127;}), "Unsafe path characters are not allowed")
  .transform(value => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 160).replace(/-$/g, ""))
  .pipe(z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
export const imageUploadQuery = z.object({
  slug: uploadOwnerSlug.optional(),
  placement: z.enum(["cover", "gallery"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.placement && !value.slug)
    ctx.addIssue({code: "custom", path: ["slug"], message: "A safe entity slug is required for an image placement"});
});
export const imageDeleteBody = z
  .object({ url: z.string().url().max(2000) })
  .strict();
export const publicGivingQuery = z.object({...paging, categoryId: id.optional()}).strict();
export const givingQuery = z
  .object({ ...paging, categoryId: id.optional(), status: z.enum(["active", "inactive"]).optional() })
  .strict();
export const eventQuery = z
  .object({
    ...paging,
    status: z.enum(["draft", "published", "inactive"]).optional(),
  })
  .strict();
export type GivingInput = z.infer<typeof givingBody>;
export type EventInput = z.infer<typeof eventBody>;
export type GivingCategoryInput = z.infer<typeof givingCategoryBody>;
