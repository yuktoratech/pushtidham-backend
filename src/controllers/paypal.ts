import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { PayPalOrderInput } from "../validators/payments.js";
import { PayPalOrderService } from "../services/paypal-orders.js";
import { PayPalEventService } from "../services/paypal-events.js";
import type { PayPalGateway } from "../services/paypal-gateway.js";
import { PaymentService } from "../services/payments.js";

export function paypalController(config: Config, gateway?: PayPalGateway, orders?: PayPalOrderService, events?: PayPalEventService, payments = new PaymentService()) {
  const create: RequestHandler = async (req, res) => {
    if (!orders) throw new AppError(503, "PAYPAL_UNAVAILABLE", "PayPal checkout is not configured");
    const data = await orders.create(req.validated.body as PayPalOrderInput, req.get("Idempotency-Key") ?? "", req.principal?.id);
    res.status(201).json({ success: true, data });
  };
  const capture: RequestHandler = async (req, res) => {
    if (!gateway || !events) throw new AppError(503, "PAYPAL_UNAVAILABLE", "PayPal checkout is not configured");
    const orderId = (req.validated.params as { orderId: string }).orderId;
    const attempt = await payments.requirePayPalCaptureAccess(orderId, req.principal?.id, req.get("X-Payment-Status-Token"));
    const authoritative = await gateway.getOrder(orderId);
    if (authoritative.status !== "APPROVED" && authoritative.status !== "COMPLETED") throw new AppError(409, "PAYPAL_ORDER_NOT_APPROVED", "PayPal order is not approved for capture");
    const order = authoritative.status === "COMPLETED" ? authoritative : await gateway.captureOrder(orderId, `capture:${attempt._id}`);
    await events.applyOrder(order, `capture:${order.id}:${order.status}`, "paypal.capture.reconciliation", createHash("sha256").update(`${order.id}:${order.status}`).digest("hex"));
    res.json({ success: true, data: { orderId: order.id, attemptId: String(attempt._id), status: order.status } });
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
