import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { PayPalOrderService } from "../services/paypal-orders.js";
import { PayPalEventService } from "../services/paypal-events.js";
import type { PayPalGateway } from "../services/paypal-gateway.js";

export function paypalController(config: Config, gateway?: PayPalGateway, _orders?: PayPalOrderService, events?: PayPalEventService) {
  const create: RequestHandler = async () => {
    throw new AppError(410, "PAYPAL_RETIRED", "New PayPal donations are unavailable");
  };
  const capture: RequestHandler = async () => {
    throw new AppError(410, "PAYPAL_RETIRED", "New PayPal captures are unavailable");
  };
  const webhook: RequestHandler = async (req, res) => {
    if (!gateway || !events || !config.PAYPAL_WEBHOOK_ID) throw new AppError(503, "PAYPAL_WEBHOOK_UNAVAILABLE", "PayPal webhook is not configured");
    if (!Buffer.isBuffer(req.body)) throw new AppError(400, "INVALID_WEBHOOK_BODY", "PayPal webhook requires a raw body");
    let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
    try { event = JSON.parse(req.body.toString("utf8")); } catch { throw new AppError(400, "INVALID_WEBHOOK_BODY", "PayPal webhook JSON is invalid"); }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
    if (!event.id || !event.event_type || !event.resource || !(await gateway.verifyWebhook(headers, event))) throw new AppError(400, "INVALID_PAYPAL_WEBHOOK", "PayPal webhook verification failed");
    const data = await events.process(event as { id: string; event_type: string; resource: Record<string, unknown> }, createHash("sha256").update(req.body).digest("hex"));
    res.json({ success: true, data });
  };
  return { create, capture, webhook };
}
