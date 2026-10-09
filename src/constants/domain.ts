export const MIN_DONATION_CENTS = 100;
export const MAX_DONATION_CENTS = 1000000;
export const BCRYPT_COST = 12;
export const donationTypes = ["general", "event"] as const;
export const paymentMethods = [
  "paypal",
  "bank_transfer",
  "offline",
  "card",
  "ach",
  "venmo",
] as const;
export const statuses = ["pending", "completed", "rejected"] as const;
export const paymentProviders = ["stripe", "paypal"] as const;
export const paymentMethodFamilies = ["card", "ach", "paypal", "venmo"] as const;
export const paymentAttemptStatuses = [
  "created",
  "requires_action",
  "verification_pending",
  "processing",
  "succeeded",
  "failed",
  "canceled",
] as const;
export const webhookProcessingStatuses = [
  "received",
  "processing",
  "processed",
  "failed",
] as const;
export const paymentAdjustmentTypes = [
  "refund",
  "ach_return",
  "dispute",
  "reversal",
] as const;
export const paymentAdjustmentStatuses = [
  "pending",
  "succeeded",
  "failed",
] as const;
