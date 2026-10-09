import { z } from "zod";
import { donationTypes } from "../constants/domain.js";
import { email, id, money } from "./common.js";

const references = (value: { type: string; giving?: string; event?: string }) =>
  value.type === "general"
    ? !!value.giving && !value.event
    : !!value.event && !value.giving;

export const stripeCheckoutBody = z
  .object({
    donorName: z.string().trim().min(1).max(120),
    donorEmail: email,
    donorPhone: z.string().trim().max(40).optional(),
    type: z.enum(donationTypes),
    giving: id.optional(),
    event: id.optional(),
    amountCents: money,
    currency: z.literal("USD").default("USD"),
    methodFamily: z.enum(["card", "ach"]),
    coverFees: z.boolean().default(false),
  })
  .strict()
  .refine(references, {
    path: ["type"],
    message: "General requires only Giving; Event requires only Event",
  });

export type StripeCheckoutInput = z.infer<typeof stripeCheckoutBody>;

export const paypalOrderBody = z
  .object({
    donorName: z.string().trim().min(1).max(120), donorEmail: email,
    donorPhone: z.string().trim().max(40).optional(), type: z.enum(donationTypes),
    giving: id.optional(), event: id.optional(), amountCents: money,
    currency: z.literal("USD").default("USD"), coverFees: z.boolean().default(false),
  })
  .strict()
  .refine(references, { path: ["type"], message: "General requires only Giving; Event requires only Event" });
export const paypalCaptureBody = z.object({}).strict();
export const paypalOrderParams = z.object({ orderId: z.string().trim().min(3).max(255).regex(/^[A-Za-z0-9-]+$/) }).strict();
export type PayPalOrderInput = z.infer<typeof paypalOrderBody>;
