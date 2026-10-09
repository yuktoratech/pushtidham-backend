import {
  MAX_DONATION_CENTS,
  MIN_DONATION_CENTS,
} from "../constants/domain.js";
import { AppError } from "../utils/errors.js";

export type FeePolicy = {
  enabled: boolean;
  percentageBasisPoints: number;
  fixedCents: number;
  capCents?: number;
  bankVerificationCents?: number;
  includeBankVerificationCost?: boolean;
};

export type FeeCalculation = {
  baseDonationCents: number;
  feeContributionCents: number;
  totalChargeCents: number;
  estimated: boolean;
};

function validatePolicy(policy: FeePolicy) {
  if (
    !Number.isInteger(policy.percentageBasisPoints) ||
    policy.percentageBasisPoints < 0 ||
    policy.percentageBasisPoints >= 10_000 ||
    !Number.isInteger(policy.fixedCents) ||
    policy.fixedCents < 0 ||
    (policy.capCents !== undefined &&
      (!Number.isInteger(policy.capCents) || policy.capCents < 0)) ||
    (policy.bankVerificationCents !== undefined &&
      (!Number.isInteger(policy.bankVerificationCents) ||
        policy.bankVerificationCents < 0))
  )
    throw new AppError(500, "INVALID_FEE_POLICY", "Payment fee policy is invalid");
}

function processingFee(totalCents: number, policy: FeePolicy) {
  const percentage = Math.ceil(
    (totalCents * policy.percentageBasisPoints) / 10_000,
  );
  const fee = percentage + policy.fixedCents;
  return policy.capCents === undefined ? fee : Math.min(fee, policy.capCents);
}

export function calculateFeeCoverage(
  baseDonationCents: number,
  optedIn: boolean,
  policy?: FeePolicy,
): FeeCalculation {
  if (
    !Number.isInteger(baseDonationCents) ||
    baseDonationCents < MIN_DONATION_CENTS ||
    baseDonationCents > MAX_DONATION_CENTS
  )
    throw new AppError(
      400,
      "INVALID_AMOUNT",
      "Donation must be an integer USD amount from $1 to $10,000",
    );
  if (!optedIn)
    return {
      baseDonationCents,
      feeContributionCents: 0,
      totalChargeCents: baseDonationCents,
      estimated: false,
    };
  if (!policy?.enabled)
    throw new AppError(
      422,
      "FEE_COVERAGE_UNAVAILABLE",
      "Fee coverage is unavailable for this payment method",
    );
  validatePolicy(policy);
  const verification = policy.includeBankVerificationCost
    ? (policy.bankVerificationCents ?? 0)
    : 0;
  let total = baseDonationCents + processingFee(baseDonationCents, policy) + verification;
  for (let count = 0; count < 20; count++) {
    const next = baseDonationCents + processingFee(total, policy) + verification;
    if (next === total) break;
    total = next;
  }
  if (total > MAX_DONATION_CENTS)
    throw new AppError(
      400,
      "TOTAL_AMOUNT_EXCEEDS_LIMIT",
      "Donation plus estimated fee contribution exceeds the $10,000 limit",
    );
  return {
    baseDonationCents,
    feeContributionCents: total - baseDonationCents,
    totalChargeCents: total,
    estimated: true,
  };
}
