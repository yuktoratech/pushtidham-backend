import type {
  paymentAdjustmentStatuses,
  paymentAdjustmentTypes,
  paymentAttemptStatuses,
  paymentProviders,
} from "../constants/domain.js";

type Provider = (typeof paymentProviders)[number];
type AttemptStatus = (typeof paymentAttemptStatuses)[number];
type AdjustmentType = (typeof paymentAdjustmentTypes)[number];
type AdjustmentStatus = (typeof paymentAdjustmentStatuses)[number];

export type VerifiedProviderEventInput = {
  provider: Provider;
  eventId: string;
  eventType: string;
  payloadDigest: string;
  attemptId: string;
  donationId: string;
  currency: "USD";
  baseDonationCents: number;
  feeContributionCents: number;
  totalChargeCents: number;
  status: AttemptStatus;
  providerReference: {
    field: "checkoutSessionId" | "orderId" | "paymentId" | "captureId";
    value: string;
  };
  actualProviderFeeCents?: number;
  failure?: { code?: string; message?: string; retryable?: boolean };
  adjustment?: {
    type: AdjustmentType;
    status: AdjustmentStatus;
    amountCents: number;
    providerReference: string;
    reasonCode?: string;
    occurredAt: Date;
  };
};

const verified = new WeakSet<object>();

export class VerifiedProviderEvent {
  private constructor(readonly input: VerifiedProviderEventInput) {}

  /** Provider adapters may call this only after authenticating the provider event. */
  static fromVerifiedAdapter(input: VerifiedProviderEventInput) {
    const event = new VerifiedProviderEvent(input);
    verified.add(event);
    return event;
  }

  static isVerified(event: VerifiedProviderEvent) {
    return verified.has(event);
  }
}
