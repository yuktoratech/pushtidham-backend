# Phase 4A payment foundation

Phase 4B now supplies the Stripe adapter described by this foundation. Its deployment and API guide is in `stripe-phase-4b.md`; the provider-neutral invariants below still apply.

Phase 4A is provider-neutral infrastructure only. It does not load Stripe or PayPal SDKs, create provider checkout sessions/orders, verify provider signatures, expose webhooks, or offer a client-controlled success path.

## Existing contracts retained

- `Donation.amountCents` remains the base donation in integer USD cents. Historical documents need none of the new optional fields.
- Existing `pending`, `completed`, and `rejected` donation statuses remain unchanged.
- Existing public `paypal` and `bank_transfer` payloads and offline admin donation behavior remain unchanged.
- General donations reference active, non-deleted Giving. Fixed-only choices remain server-controlled; custom and fixed-plus-custom accept the existing $1–$10,000 policy.
- Public Event eligibility means published and non-deleted, regardless of date. Offline historical Event lookup still accepts any retained Event.
- Authenticated donations are owned only by their stored user ID. Guest email matching never attaches history to a user.

## Persistence

`PaymentAttempt` stores one provider interaction: provider/method family, state history, USD base donation, optional estimated fee contribution, authorized total, actual provider fee/net when known, safe failure data, provider references, a provider-scoped idempotency key and a hashed guest status token. Stripe supports card/ACH families; PayPal supports PayPal/Venmo families. Unique partial indexes protect provider identifiers without colliding on absent historical values.

`WebhookEvent` is the durable delivery ledger. `(provider,eventId)` is unique. Only a provider adapter that has authenticated an event may construct `VerifiedProviderEvent`. The ledger stores a payload digest, not the raw payload, and records processing attempts, retry-safe failures and completion.

`PaymentAdjustment` stores refunds (including partial refunds), ACH returns, disputes and reversals separately from the immutable original payment. Provider/type/reference is unique. Adjustments do not rewrite the original donation or turn an ACH return into a claim that the original confirmation never occurred.

New optional Donation fields link the one confirmed attempt and distinguish fee contribution, total charge, actual provider fee and net proceeds. A unique partial index prevents an attempt from confirming multiple donations.

Run `npm run db:indexes` before production traffic. It creates new indexes without dropping data. Existing documents require no backfill. Index creation must be reviewed for pre-existing duplicate provider identifiers before provider integrations go live.

## State and concurrency rules

Attempt states are `created`, `requires_action`, `verification_pending`, `processing`, `succeeded`, `failed`, and `canceled`. ACH verification or initiation is not success; only a verified `succeeded` event completes the Donation. Processing and verification-pending amounts therefore stay outside confirmed donation totals.

Succeeded is monotonic. Lower or out-of-order states cannot regress it. A verified success may arrive after failed/canceled browser flow and still wins. Retrying a failed/canceled attempt uses a new idempotency key and attempt. A second distinct successful attempt for an already completed Donation raises `DUPLICATE_PAYMENT_INCIDENT` for explicit handling.

Verified event application checks provider, attempt, Donation, currency, base amount, fee contribution, total and provider reference. It runs attempt, Donation, webhook ledger and adjustment writes in a MongoDB transaction. Unique indexes and conditional event claims handle real multi-process concurrency; there are no process-local locks. Deploy MongoDB as a replica set (Atlas qualifies). A standalone MongoDB server cannot provide these multi-document guarantees.

Events stuck in processing may be reclaimed after five minutes. Retryable failures may be replayed; deterministic verification conflicts are retained as non-retryable failures. The event ledger is written before the transaction, so rollback leaves an auditable failed delivery rather than losing it.

## Fee coverage

`calculateFeeCoverage` is opt-in. Opt-out always adds zero. Opt-in fails with `FEE_COVERAGE_UNAVAILABLE` unless an enabled policy is explicitly supplied. Policies use percentage basis points plus fixed cents, an optional processing-fee cap, and an optional separately configured bank-verification amount. Integer-cent ceiling is used and the final total is checked against the existing $10,000 maximum. The result is always labeled estimated; actual provider fees are stored separately after provider reporting.

No provider price is built in. Before Phase 4D exposes the checkbox, operations must configure and approve current provider/method policies, including whether a verification cost is eligible for donor coverage.

## Provider API boundaries

Stripe Phase 4B implements the Stripe and status boundaries below. PayPal and admin reporting remain deferred:

- `POST /payments/stripe/checkout-sessions`: authenticated or guest initiation with a required idempotency key; creates a Stripe-hosted Checkout Session and an unguessable guest status token.
- `POST /payments/paypal/orders` and `POST /payments/paypal/orders/:id/capture`: same scoped ownership; provider response remains non-authoritative until verified.
- `GET /payments/attempts/:id/status`: authenticated Donation owner or the random guest status token; returns a PII-minimized status DTO.
- `POST /webhooks/stripe`: raw-body Stripe signature verification before constructing `VerifiedProviderEvent`; PayPal remains deferred.
- Admin reconciliation and donor/admin payment history endpoints with role/ownership checks and PII-minimized serializers.

Do not reuse Donation IDs as guest bearer credentials. Do not expose webhook internals, raw payloads, provider secrets, failure details containing PII, or any endpoint that accepts a client-supplied authoritative payment status.

## Provider configuration

The Stripe settings in `.env.example` are used by Phase 4B. PayPal settings remain placeholders. Secrets must come from the deployment secret store, never source control. Test and live environments must be isolated.

Stripe ACH collection and authorization must remain Stripe-hosted. No service may accept or persist raw account/routing numbers, online banking credentials or custom microdeposit data. Future Phase 4B must support Financial Connections instant verification and Stripe-supported microdeposit fallback, with later returns recorded as adjustments.
