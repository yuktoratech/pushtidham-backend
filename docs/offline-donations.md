# Admin offline donation entry

The inline Admin > Donations form uses the public Donate category hierarchy and API category IDs. Daily Seva and General Donation have one dependent Giving dropdown; Utsav adds the festival dropdown. Existing historical Event entry remains an explicit optional mode. Fixed/custom validation and Other purpose validation reuse the donation eligibility service.

## API and consistency

- Admin-only GET `/api/v1/admin/donors/search?email=...`: case-insensitive escaped email-prefix search, minimum three characters, maximum eight results, safe donor fields only.
- Admin-only POST `/api/v1/admin/donations/offline`: validated existing offline body plus optional `offlinePaymentMethod` (`cash`, `check`, `other`). Requires a 16–200 character `Idempotency-Key`.
- Existing email accounts are never modified by staff input. Selected user ID must match the authoritative normalized email and the account must be an active donor.
- A MongoDB replica-set transaction creates the User when absent and saves the donation through the existing DonationService. Invalid designation/amount/purpose aborts both writes.
- Idempotency is scoped to admin ID and request key. A deterministic donation number uses the existing unique donationNumber index. A private request hash detects changed payloads. Existing unique User email constraint resolves simultaneous donor creation; transaction retries look up the winning account.
- Historical documents are not migrated. Existing indexes must be present; no new index or catalog migration is required.
- Offline payment subtype is additive; reports retain `paymentMethod=offline`. CSV adds an offline subtype column; receipts use recorded cash/check where available and preserve Other for historical unknowns.

## Account setup and email retry

New donors receive a hash of a cryptographically random, never-disclosed password. They are not logged in, no Session is created, and `emailVerifiedAt` remains unset. Staff cannot set verification flags or roles.

A durable welcome task (`welcomeEmailStatus=pending`) is part of the User transaction. Dispatch is scheduled after the successful save response and commit, so SMTP latency/failure cannot roll back or block donation entry. No token is returned to admin. The existing reset-password flow creates a 30-minute single-use hashed token; successful password setup proves email possession, records email verification and revokes older sessions.

SMTP acceptance is not recipient delivery confirmation. Failure records only `MAIL_UNAVAILABLE`, never the provider error or token. `POST /api/v1/admin/donors/:id/welcome-email` queues a retry without touching donations or creating users. It uses a cooldown, the existing auth limiter and a five-minute atomic send lease. An interrupted send can be retried after lease expiry. A process crash between commit and dispatch leaves a pending task; admin can find the donor again and use **Retry selected donor setup email**. This is a durable on-demand task, not an always-running background queue worker. SMTP delivery is at-least-once; retries issue a new link and invalidate the old link. Already activated accounts cannot be re-invited through this route.

Existing SMTP configuration is reused. No new environment variable is required. Real delivery is not verified by mocked tests; configure a valid sender and accessible frontend reset URL before using the workflow for real donors.

## Focused verification

`npx tsx --test tests/offline-donations.test.ts`

Frontend: `npx playwright test tests/browser/offline-donations.spec.ts --workers=1`

Tests use an isolated local MongoDB replica set and intercepted browser APIs. No Atlas, Stripe, R2 or real email calls are needed.
