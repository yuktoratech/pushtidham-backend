import { z } from "zod";
import { donationTypes } from "../constants/domain.js";
import { email, id, money } from "./common.js";

const references = (value: { type: string; giving?: string; event?: string }) =>
  value.type === "general"
    ? !!value.giving && !value.event
    : Boolean(value.event) !== Boolean(value.giving);

export const stripeCheckoutBody = z
  .object({
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
    methodFamily: z.literal("card"),
    coverFees: z.boolean().default(false),
  })
  .strict()
  .refine(references, {
    path: ["type"],
    message: "General requires only Giving; Event requires only Event",
  });

export type StripeCheckoutInput = z.infer<typeof stripeCheckoutBody>;
