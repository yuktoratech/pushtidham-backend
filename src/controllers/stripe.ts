import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { StripeCheckoutInput } from "../validators/payments.js";
import { PaymentService } from "../services/payments.js";
import { StripeCheckoutService } from "../services/stripe-checkout.js";
import { StripeEventService } from "../services/stripe-events.js";
import type { StripeGateway } from "../services/stripe-gateway.js";

export function stripeController(
  config: Config,
  gateway: StripeGateway | undefined,
  checkout: StripeCheckoutService | undefined,
  events: StripeEventService | undefined,
  payments = new PaymentService(),
) {
  const create: RequestHandler = async (req, res) => {
    if (!checkout) throw new AppError(503, "STRIPE_UNAVAILABLE", "Stripe checkout is not configured");
    const idempotency = req.get("Idempotency-Key") ?? "";
    res.status(201).json({
      success: true,
      data: await checkout.create(
        req.validated.body as StripeCheckoutInput,
        idempotency,
        req.principal?.id,
      ),
    });
  };
  const webhook: RequestHandler = async (req, res) => {
    if (!gateway || !events || !config.STRIPE_WEBHOOK_SECRET)
      throw new AppError(503, "STRIPE_WEBHOOK_UNAVAILABLE", "Stripe webhook is not configured");
    if (!Buffer.isBuffer(req.body))
      throw new AppError(400, "INVALID_WEBHOOK_BODY", "Stripe webhook requires a raw body");
    const signature = req.get("Stripe-Signature");
    if (!signature)
      throw new AppError(400, "INVALID_STRIPE_SIGNATURE", "Stripe signature is required");
    let event;
    try {
      event = gateway.constructWebhookEvent(
        req.body,
        signature,
        config.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      throw new AppError(400, "INVALID_STRIPE_SIGNATURE", "Stripe signature verification failed");
    }
    const result = await events.process(
      event,
      createHash("sha256").update(req.body).digest("hex"),
    );
    res.json({ success: true, data: result });
  };
  const status: RequestHandler = async (req, res) => {
    const id = (req.validated.params as { id: string }).id;
    const data = req.principal
      ? await payments.findOwnedAttempt(id, req.principal.id)
      : await payments.findGuestAttempt(id, req.get("X-Payment-Status-Token") ?? "");
    res.json({ success: true, data });
  };
  return { create, webhook, status };
}
