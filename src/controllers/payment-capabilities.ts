import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";

export function paymentCapabilitiesController(
  config: Config,
  stripeAvailable: boolean,
): RequestHandler {
  return (_req, res) => {
    res.json({
      success: true,
      data: {
        stripe: {
          card: config.STRIPE_CARD_ENABLED && !!config.STRIPE_CARD_PAYMENT_METHOD_CONFIGURATION && stripeAvailable,
        },
      },
    });
  };
}
