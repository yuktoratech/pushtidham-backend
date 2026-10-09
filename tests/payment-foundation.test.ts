import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Donation } from "../src/models/donation.js";
import { Event } from "../src/models/event.js";
import { Giving } from "../src/models/giving.js";
import { PaymentAdjustment } from "../src/models/payment-adjustment.js";
import { PaymentAttempt } from "../src/models/payment-attempt.js";
import { User } from "../src/models/user.js";
import { WebhookEvent } from "../src/models/webhook-event.js";
import { resolveDonationDesignation } from "../src/services/donation-eligibility.js";
import { calculateFeeCoverage } from "../src/services/payment-fees.js";
import { PaymentService } from "../src/services/payments.js";
import { VerifiedProviderEvent } from "../src/services/verified-provider-event.js";
import { AppError } from "../src/utils/errors.js";

let replica: MongoMemoryReplSet;
const payments = new PaymentService();
const stripePolicy = {
  enabled: true,
  percentageBasisPoints: 290,
  fixedCents: 30,
};

before(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri(), { dbName: "payment_foundation" });
  await Promise.all([
    User.init(),
    Giving.init(),
    Event.init(),
    Donation.init(),
    PaymentAttempt.init(),
    WebhookEvent.init(),
    PaymentAdjustment.init(),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({}),
    ),
  );
});

async function designation(mode: "fixed" | "custom" | "fixed_and_custom" = "fixed") {
  return Giving.create({
    title: "General Support",
    slug: `general-${mode.replaceAll("_", "-")}-${new Types.ObjectId()}`,
    amountType: mode,
    fixedAmountsCents: mode === "custom" ? [] : [2500, 5000],
    status: "active",
  });
}

async function donation(options: { user?: Types.ObjectId; amountCents?: number } = {}) {
  const giving = await designation();
  return Donation.create({
    donationNumber: `PD-TEST-${new Types.ObjectId()}`,
    user: options.user,
    donorName: "Payment Donor",
    donorEmail: "payment@example.test",
    type: "general",
    giving: giving._id,
    designationTitle: giving.title,
    amountCents: options.amountCents ?? 2500,
    currency: "USD",
    paymentMethod: "paypal",
    status: "pending",
    source: "online",
  });
}

async function attemptFor(
  source: Awaited<ReturnType<typeof donation>>,
  options: { methodFamily?: "card" | "ach"; suffix?: string } = {},
) {
  return payments.prepareAttempt({
    donationId: String(source._id),
    provider: "stripe",
    methodFamily: options.methodFamily ?? "card",
    idempotencyKey: `payment-test-key-${options.suffix ?? new Types.ObjectId()}`,
    coverFees: false,
    providerIdentity: { paymentId: `pi_${options.suffix ?? new Types.ObjectId()}` },
  });
}

function verified(
  attempt: Awaited<ReturnType<typeof attemptFor>>["attempt"],
  status: "verification_pending" | "processing" | "succeeded" | "failed" | "canceled",
  eventId: string,
  extra: Partial<Parameters<typeof VerifiedProviderEvent.fromVerifiedAdapter>[0]> = {},
) {
  return VerifiedProviderEvent.fromVerifiedAdapter({
    provider: "stripe",
    eventId,
    eventType: `payment.${status}`,
    payloadDigest: createHash("sha256").update(eventId).digest("hex"),
    attemptId: String(attempt._id),
    donationId: String(attempt.donation),
    currency: "USD",
    baseDonationCents: attempt.baseDonationCents,
    feeContributionCents: attempt.feeContributionCents,
    totalChargeCents: attempt.totalChargeCents,
    status,
    providerReference: { field: "paymentId", value: attempt.paymentId! },
    ...extra,
  });
}

test("historical donations remain readable without payment foundation fields", async () => {
  const giving = await designation();
  const id = new Types.ObjectId();
  await mongoose.connection.collection("donations").insertOne({
    _id: id,
    donationNumber: "PD-HISTORICAL",
    donorName: "Historical Guest",
    donorEmail: "historical@example.test",
    type: "general",
    giving: giving._id,
    designationTitle: giving.title,
    amountCents: 2500,
    currency: "USD",
    paymentMethod: "bank_transfer",
    status: "completed",
    source: "online",
  });
  const historical = await Donation.findById(id).lean();
  assert.equal(historical?.amountCents, 2500);
  assert.equal(historical?.confirmedPaymentAttempt, undefined);
  assert.equal(historical?.feeContributionCents, undefined);
});

test("eligibility preserves fixed/custom/combined Giving and published Event rules", async () => {
  const fixed = await designation("fixed");
  await assert.rejects(
    resolveDonationDesignation({
      type: "general",
      giving: String(fixed._id),
      amountCents: 2600,
    }),
    (error: AppError) => error.code === "INVALID_AMOUNT",
  );
  for (const mode of ["custom", "fixed_and_custom"] as const) {
    const giving = await designation(mode);
    assert.equal(
      (
        await resolveDonationDesignation({
          type: "general",
          giving: String(giving._id),
          amountCents: 2637,
        })
      ).title,
      "General Support",
    );
  }
  const published = await Event.create({
    title: "Past but published",
    slug: "past-published-payment",
    startsAt: new Date("2020-01-01T00:00:00Z"),
    location: "Haveli",
    status: "published",
  });
  assert.equal(
    (
      await resolveDonationDesignation({
        type: "event",
        event: String(published._id),
        amountCents: 100,
      })
    ).title,
    "Past but published",
  );
  published.status = "inactive";
  await published.save();
  await assert.rejects(
    resolveDonationDesignation({
      type: "event",
      event: String(published._id),
      amountCents: 100,
    }),
  );
  assert.equal(
    (
      await resolveDonationDesignation(
        { type: "event", event: String(published._id), amountCents: 100 },
        true,
      )
    ).title,
    "Past but published",
  );
});

test("fee coverage is opt-in, configurable, rounded, capped and limit checked", () => {
  assert.deepEqual(calculateFeeCoverage(100, false), {
    baseDonationCents: 100,
    feeContributionCents: 0,
    totalChargeCents: 100,
    estimated: false,
  });
  assert.throws(
    () => calculateFeeCoverage(100, true),
    (error: AppError) => error.code === "FEE_COVERAGE_UNAVAILABLE",
  );
  const card = calculateFeeCoverage(100, true, stripePolicy);
  assert.deepEqual(card, {
    baseDonationCents: 100,
    feeContributionCents: 34,
    totalChargeCents: 134,
    estimated: true,
  });
  const ach = calculateFeeCoverage(100_000, true, {
    enabled: true,
    percentageBasisPoints: 80,
    fixedCents: 0,
    capCents: 500,
    bankVerificationCents: 150,
    includeBankVerificationCost: true,
  });
  assert.equal(ach.feeContributionCents, 650);
  assert.throws(
    () => calculateFeeCoverage(1_000_000, true, stripePolicy),
    (error: AppError) => error.code === "TOTAL_AMOUNT_EXCEEDS_LIMIT",
  );
});

test("guest and donor attempts snapshot identity without email ownership matching", async () => {
  const guestDonation = await donation();
  const guest = await payments.prepareAttempt({
    donationId: String(guestDonation._id),
    provider: "paypal",
    methodFamily: "paypal",
    idempotencyKey: "guest-payment-attempt-0001",
    coverFees: false,
    providerIdentity: { orderId: "ORDER_GUEST_1" },
  });
  assert.ok(guest.statusToken);
  assert.equal(guest.attempt.donorUser, undefined);
  const status = await payments.findGuestAttempt(
    String(guest.attempt._id),
    guest.statusToken!,
  );
  assert.equal(status.id, String(guest.attempt._id));
  assert.equal("donorEmailSnapshot" in status, false);
  assert.equal("idempotencyKey" in status, false);
  assert.equal("statusAccessTokenHash" in status, false);
  await assert.rejects(payments.findGuestAttempt(String(guest.attempt._id), "wrong"));
  const user = await User.create({
    name: "Owner",
    email: "payment@example.test",
    passwordHash: "not-used-in-foundation-test",
    role: "donor",
  });
  const ownedDonation = await donation({ user: user._id });
  await assert.rejects(
    payments.prepareAttempt({
      donationId: String(ownedDonation._id),
      provider: "stripe",
      methodFamily: "card",
      idempotencyKey: "wrong-owner-attempt-0001",
      coverFees: false,
      actorId: new Types.ObjectId(),
    }),
    (error: AppError) => error.code === "FORBIDDEN",
  );
});

test("attempt preparation is idempotent and conflicting reuse is rejected", async () => {
  const source = await donation();
  const input = {
    donationId: String(source._id),
    provider: "stripe" as const,
    methodFamily: "card" as const,
    idempotencyKey: "stable-idempotency-key-0001",
    coverFees: true,
    feePolicy: stripePolicy,
    providerIdentity: { paymentId: "pi_idempotent" },
  };
  const first = await payments.prepareAttempt(input);
  const replay = await payments.prepareAttempt(input);
  assert.equal(String(first.attempt._id), String(replay.attempt._id));
  assert.equal(replay.replayed, true);
  await assert.rejects(
    payments.prepareAttempt({ ...input, methodFamily: "ach" }),
    (error: AppError) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("ACH verification and processing are pending until verified success", async () => {
  const source = await donation();
  const { attempt } = await attemptFor(source, { methodFamily: "ach", suffix: "ach" });
  await payments.applyVerifiedEvent(verified(attempt, "verification_pending", "evt_ach_verify"));
  assert.equal((await Donation.findById(source._id))?.status, "pending");
  await payments.applyVerifiedEvent(verified(attempt, "processing", "evt_ach_processing"));
  assert.equal((await Donation.findById(source._id))?.status, "pending");
  await payments.applyVerifiedEvent(
    verified(attempt, "succeeded", "evt_ach_success", { actualProviderFeeCents: 20 }),
  );
  const completed = await Donation.findById(source._id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.actualProviderFeeCents, 20);
  assert.equal(completed?.netProceedsCents, 2480);
});

test("out-of-order events do not regress success and duplicate success is idempotent", async () => {
  const source = await donation();
  const { attempt } = await attemptFor(source, { suffix: "order" });
  const success = verified(attempt, "succeeded", "evt_success_once");
  assert.deepEqual(await payments.applyVerifiedEvent(success), { duplicate: false });
  assert.deepEqual(await payments.applyVerifiedEvent(success), { duplicate: true });
  await payments.applyVerifiedEvent(verified(attempt, "processing", "evt_late_processing"));
  assert.equal((await PaymentAttempt.findById(attempt._id))?.status, "succeeded");
  assert.equal((await Donation.findById(source._id))?.status, "completed");
});

test("late verified success wins after canceled or failed attempts and retries use a new attempt", async () => {
  for (const terminal of ["canceled", "failed"] as const) {
    const source = await donation();
    const { attempt } = await attemptFor(source, { suffix: terminal });
    await payments.applyVerifiedEvent(verified(attempt, terminal, `evt_${terminal}`));
    assert.equal((await Donation.findById(source._id))?.status, "pending");
    await payments.applyVerifiedEvent(verified(attempt, "succeeded", `evt_${terminal}_late_success`));
    assert.equal((await Donation.findById(source._id))?.status, "completed");
  }
  const retryDonation = await donation();
  const first = await attemptFor(retryDonation, { suffix: "retry-first" });
  await payments.applyVerifiedEvent(verified(first.attempt, "failed", "evt_retry_failed"));
  const second = await attemptFor(retryDonation, { suffix: "retry-second" });
  assert.notEqual(String(first.attempt._id), String(second.attempt._id));
});

test("amount, currency, Donation and provider-reference mismatches roll back", async () => {
  const cases: Array<{
    name: string;
    change: Partial<Parameters<typeof VerifiedProviderEvent.fromVerifiedAdapter>[0]>;
  }> = [
    { name: "amount", change: { totalChargeCents: 2501 } },
    { name: "currency", change: { currency: "CAD" as "USD" } },
    { name: "donation", change: { donationId: String(new Types.ObjectId()) } },
    {
      name: "reference",
      change: { providerReference: { field: "paymentId", value: "pi_wrong" } },
    },
  ];
  for (const item of cases) {
    const source = await donation();
    const { attempt } = await attemptFor(source, { suffix: `mismatch-${item.name}` });
    const eventId = `evt_mismatch_${item.name}`;
    await assert.rejects(
      payments.applyVerifiedEvent(
        verified(attempt, "succeeded", eventId, item.change),
      ),
      (error: AppError) => error.code === "PAYMENT_VERIFICATION_MISMATCH",
    );
    assert.equal((await Donation.findById(source._id))?.status, "pending");
    assert.equal((await PaymentAttempt.findById(attempt._id))?.status, "created");
    const ledger = await WebhookEvent.findOne({ eventId });
    assert.equal(ledger?.status, "failed");
    assert.equal(ledger?.failure?.retryable, false);
  }
});

test("concurrent success events cannot double-apply a payment", async () => {
  const source = await donation();
  const { attempt } = await attemptFor(source, { suffix: "concurrent" });
  await Promise.all([
    payments.applyVerifiedEvent(verified(attempt, "succeeded", "evt_concurrent_a")),
    payments.applyVerifiedEvent(verified(attempt, "succeeded", "evt_concurrent_b")),
  ]);
  const completed = await Donation.findById(source._id);
  assert.equal(completed?.status, "completed");
  assert.equal(String(completed?.confirmedPaymentAttempt), String(attempt._id));
  assert.equal(
    await PaymentAttempt.countDocuments({ donation: source._id, status: "succeeded" }),
    1,
  );
});

test("concurrent duplicate delivery is deduplicated by the database ledger", async () => {
  const source = await donation();
  const { attempt } = await attemptFor(source, { suffix: "same-event" });
  const event = verified(attempt, "succeeded", "evt_same_concurrent");
  const results = await Promise.all([
    payments.applyVerifiedEvent(event),
    payments.applyVerifiedEvent(event),
  ]);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  assert.equal((await Donation.findById(source._id))?.status, "completed");
  assert.equal(
    await WebhookEvent.countDocuments({ eventId: "evt_same_concurrent" }),
    1,
  );
});

test("refunds, partial refunds, disputes and ACH returns remain separate audit records", async () => {
  const source = await donation();
  const { attempt } = await attemptFor(source, { suffix: "adjustments" });
  await payments.applyVerifiedEvent(verified(attempt, "succeeded", "evt_adjust_success"));
  for (const [index, type] of [
    "refund",
    "refund",
    "dispute",
    "ach_return",
    "reversal",
  ].entries()) {
    await payments.applyVerifiedEvent(
      verified(attempt, "succeeded", `evt_adjust_${type}_${index}`, {
        adjustment: {
          type: type as "refund" | "dispute" | "ach_return" | "reversal",
          status: "succeeded",
          amountCents: index === 0 ? 500 : index === 1 ? 2000 : 2500,
          providerReference: `adjust_${type}_${index}`,
          occurredAt: new Date(),
        },
      }),
    );
  }
  assert.equal(await PaymentAdjustment.countDocuments({ donation: source._id }), 5);
  assert.equal((await Donation.findById(source._id))?.status, "completed");
  assert.equal((await PaymentAttempt.findById(attempt._id))?.status, "succeeded");
});

test("payment persistence contains no raw bank account or routing fields", () => {
  const paths = Object.keys(PaymentAttempt.schema.paths).join(" ");
  assert.doesNotMatch(paths, /accountNumber|routingNumber|bankCredentials/i);
});
