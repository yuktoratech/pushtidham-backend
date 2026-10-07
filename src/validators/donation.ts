import { z } from "zod";
import { id, email, money, paging } from "./common.js";
import {
  donationTypes,
  paymentMethods,
  statuses,
} from "../constants/domain.js";
const fields = {
  donorName: z.string().trim().min(1).max(120),
  donorEmail: email,
  donorPhone: z.string().trim().max(40).optional(),
  type: z.enum(donationTypes),
  giving: id.optional(),
  event: id.optional(),
  amountCents: money,
  currency: z.literal("USD").default("USD"),
};
const references = (v: { type: string; giving?: string; event?: string }) =>
  v.type === "general" ? !!v.giving && !v.event : !!v.event && !v.giving;
export const onlineBody = z
  .object({
    ...fields,
    paymentMethod: z.enum(["paypal", "bank_transfer"]),
    bankReference: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine(references, {
    path: ["type"],
    message: "General requires only Giving; Event requires only Event",
  })
  .refine((v) => v.paymentMethod === "bank_transfer" || !v.bankReference, {
    path: ["bankReference"],
    message: "Only bank transfers accept a bank reference",
  });
export const offlineBody = z
  .object({
    ...fields,
    user: id.optional(),
    status: z.enum(statuses).default("pending"),
    offlineReference: z.string().trim().max(200).optional(),
    adminNote: z.string().max(2000).optional(),
  })
  .strict()
  .refine(references, {
    path: ["type"],
    message: "General requires only Giving; Event requires only Event",
  });
export const donationQuery = z
  .object({
    ...paging,
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    type: z.enum(donationTypes).optional(),
    paymentMethod: z.enum(paymentMethods).optional(),
    status: z.enum(statuses).optional(),
    source: z.enum(["online", "offline"]).optional(),
    giving: id.optional(),
    event: id.optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    path: ["to"],
    message: "Invalid date range",
  });
export const statusBody = z
  .object({
    status: z.enum(["completed", "rejected"]),
    adminNote: z.string().max(2000).optional(),
  })
  .strict();
export type DonationInput =
  z.infer<typeof onlineBody> | z.infer<typeof offlineBody>;
export type DonationQuery = z.infer<typeof donationQuery>;
