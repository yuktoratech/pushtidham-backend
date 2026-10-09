import type { Config } from "../config/env.js";
import { PaymentAttempt } from "../models/payment-attempt.js";
import { StripeEventService } from "./stripe-events.js";
import type { StripeGateway } from "./stripe-gateway.js";

export class StripeReconciliationService {
  constructor(
    private readonly config: Config,
    private readonly stripe: StripeGateway,
    private readonly events = new StripeEventService(stripe),
  ) {}

  async run() {
    const cutoff = new Date(
      Date.now() - this.config.STRIPE_RECONCILIATION_MIN_AGE_MINUTES * 60_000,
    );
    const attempts = await PaymentAttempt.find({
      provider: "stripe",
      status: {
        $in: [
          "created",
          "requires_action",
          "verification_pending",
          "processing",
        ],
      },
      checkoutSessionId: { $type: "string" },
      updatedAt: { $lte: cutoff },
      $or: [
        { lastReconciledAt: null },
        { lastReconciledAt: { $lte: cutoff } },
      ],
    })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(this.config.STRIPE_RECONCILIATION_BATCH_SIZE);
    const summary = { scanned: attempts.length, processed: 0, failed: 0 };
    for (const attempt of attempts) {
      const now = new Date();
      await PaymentAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: { lastReconciledAt: now },
          $inc: { reconciliationAttempts: 1 },
          $unset: { reconciliationFailure: 1 },
        },
      );
      try {
        const session = await this.stripe.retrieveCheckoutSession(
          attempt.checkoutSessionId!,
        );
        await this.events.reconcileSession(session);
        summary.processed++;
      } catch (error) {
        summary.failed++;
        await PaymentAttempt.updateOne(
          { _id: attempt._id },
          {
            $set: {
              reconciliationFailure: {
                code: "STRIPE_RECONCILIATION_FAILED",
                message: "Stripe reconciliation failed",
                retryable: true,
                occurredAt: new Date(),
              },
            },
          },
        );
        if (error instanceof Error && error.name === "MongoServerError") throw error;
      }
    }
    return summary;
  }
}
