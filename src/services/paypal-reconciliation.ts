import type { Config } from "../config/env.js";
import { PaymentAttempt } from "../models/payment-attempt.js";
import { PayPalEventService } from "./paypal-events.js";
import type { PayPalGateway } from "./paypal-gateway.js";

export class PayPalReconciliationService {
  constructor(private readonly config: Config, private readonly paypal: PayPalGateway, private readonly events = new PayPalEventService(paypal, config.PAYPAL_MERCHANT_ID ?? "")) {}
  async run() {
    const cutoff = new Date(Date.now() - this.config.PAYPAL_RECONCILIATION_MIN_AGE_MINUTES * 60_000);
    const attempts = await PaymentAttempt.find({ provider: "paypal", status: { $in: ["created", "requires_action", "processing"] }, orderId: { $type: "string" }, updatedAt: { $lte: cutoff }, $or: [{ lastReconciledAt: null }, { lastReconciledAt: { $lte: cutoff } }] }).sort({ updatedAt: 1, _id: 1 }).limit(this.config.PAYPAL_RECONCILIATION_BATCH_SIZE);
    const summary = { scanned: attempts.length, processed: 0, failed: 0 };
    for (const attempt of attempts) {
      await PaymentAttempt.updateOne({ _id: attempt._id }, { $set: { lastReconciledAt: new Date() }, $inc: { reconciliationAttempts: 1 }, $unset: { reconciliationFailure: 1 } });
      try {
        const order = await this.paypal.getOrder(attempt.orderId!);
        await this.events.applyOrder(order, `reconcile:${order.id}:${order.status}`, "paypal.reconciliation", this.events.digest(`${order.id}:${order.status}`));
        summary.processed++;
      } catch (error) {
        summary.failed++;
        await PaymentAttempt.updateOne({ _id: attempt._id }, { $set: { reconciliationFailure: { code: "PAYPAL_RECONCILIATION_FAILED", message: "PayPal reconciliation failed", retryable: true, occurredAt: new Date() } } });
        if (error instanceof Error && error.name === "MongoServerError") throw error;
      }
    }
    return summary;
  }
}
