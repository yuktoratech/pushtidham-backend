import { z } from "zod";
import { slug, money, paging } from "./common.js";
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
export const givingBody = z
  .object({
    title: z.string().trim().min(1).max(160),
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
  .object({ kind: z.enum(["giving", "events"]) })
  .strict();
export const imageDeleteBody = z
  .object({ url: z.string().url().max(2000) })
  .strict();
export const givingQuery = z
  .object({ ...paging, status: z.enum(["active", "inactive"]).optional() })
  .strict();
export const eventQuery = z
  .object({
    ...paging,
    status: z.enum(["draft", "published", "inactive"]).optional(),
  })
  .strict();
export type GivingInput = z.infer<typeof givingBody>;
export type EventInput = z.infer<typeof eventBody>;
