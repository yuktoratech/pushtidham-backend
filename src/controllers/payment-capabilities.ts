import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";

export function paymentCapabilitiesController(
  config: Config,
  providers: { stripe: boolean; paypal: boolean },
): RequestHandler {
  return (_req, res) => {
    const paypalEnabled = config.PAYPAL_ENABLED && providers.paypal;
    res.json({
      success: true,
      data: {
        stripe: {
          card: config.STRIPE_CARD_ENABLED && providers.stripe,
          ach: config.STRIPE_ACH_ENABLED && providers.stripe,
        },
        paypal: {
          enabled: paypalEnabled,
          clientId: paypalEnabled ? config.PAYPAL_CLIENT_ID : undefined,
          environment: config.PAYPAL_ENVIRONMENT,
          venmo: paypalEnabled && config.PAYPAL_VENMO_ENABLED,
        },
      },
    });
  };
}
