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
  categoryId: id.optional(),
  giving: id.optional(),
  event: id.optional(),
  amountCents: money,
  donationPurpose: z.string().trim().min(1).max(500).optional(),
  currency: z.literal("USD").default("USD"),
};
const references = (v: { type: string; giving?: string; event?: string }) =>
  v.type === "general" ? !!v.giving && !v.event : Boolean(v.event) !== Boolean(v.giving);
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
    message: "General requires Giving; Event requires exactly one scheduled Event or Utsav option",
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
export const donationExportQuery = donationQuery.safeExtend({
  provider: z.enum(["stripe", "paypal", "offline", "legacy_paypal", "legacy_bank_transfer"]).optional(),
});
export const statusBody = z
  .object({
    status: z.enum(["completed", "rejected"]),
    adminNote: z.string().max(2000).optional(),
  })
  .strict();
export const financialReportQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  provider: z.enum(["stripe","paypal","offline","legacy_paypal","legacy_bank_transfer"]).optional(),
  paymentMethod: z.enum(paymentMethods).optional(),
  type: z.enum(donationTypes).optional(),
  status: z.enum(statuses).optional(),
}).strict().refine((v)=>!v.from||!v.to||new Date(v.from)<=new Date(v.to),{path:["to"],message:"Invalid date range"});
export type DonationInput = z.infer<typeof offlineBody>;
export type DonationQuery = z.infer<typeof donationQuery>;
export type DonationExportQuery = z.infer<typeof donationExportQuery>;
export type FinancialReportQuery = z.infer<typeof financialReportQuery>;
