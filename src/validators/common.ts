import { z } from "zod";
import { MIN_DONATION_CENTS, MAX_DONATION_CENTS } from "../constants/domain.js";
export const id = z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid resource ID");
export const idParams = z.object({ id }).strict();
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const slugParams = z.object({ slug }).strict();
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const money = z
  .number()
  .int()
  .min(MIN_DONATION_CENTS)
  .max(MAX_DONATION_CENTS);
export const paging = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
};
export const listQuery = z.object(paging).strict();
export type ListQuery = z.infer<typeof listQuery>;
