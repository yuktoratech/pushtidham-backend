export const MIN_DONATION_CENTS = 100;
export const MAX_DONATION_CENTS = 1000000;
export const BCRYPT_COST = 12;
export const donationTypes = ["general", "event"] as const;
export const paymentMethods = ["paypal", "bank_transfer", "offline"] as const;
export const statuses = ["pending", "completed", "rejected"] as const;
