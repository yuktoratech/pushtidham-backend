# Stripe Phase 4B operations

Phase 4B supports one-time USD donations through Stripe-hosted Checkout. Card Checkout requests `card` and `link`; eligible Apple Pay and Google Pay are rendered by Stripe on supported devices and domains. ACH requests `us_bank_account`. No endpoint collects bank credentials, confirms a payment from the browser, starts a refund, or retries a debit.

## Test-mode setup

1. Use a Stripe test-mode secret key and create a test-mode webhook destination for `POST https://<api-host>/api/v1/webhooks/stripe`.
2. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.processing`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, and `charge.dispute.closed`.
3. Put the destination signing secret in `STRIPE_WEBHOOK_SECRET`. Stripe CLI forwarding uses its own temporary `whsec_...`; do not confuse it with the Dashboard destination secret.
4. Activate cards, Link, wallets, and US bank account payments in the Stripe test account. ACH and Financial Connections availability depend on the account, business location, currency, and Stripe approval.
5. Set `STRIPE_CARD_ENABLED` and/or `STRIPE_ACH_ENABLED` only after verifying account eligibility. With `STRIPE_FINANCIAL_CONNECTIONS_ENABLED=true`, Checkout requests automatic ACH verification and Financial Connections payment-method permission. With it false, Checkout explicitly uses Stripe-hosted microdeposit verification.
6. Run `npm run db:indexes`, using the same replica-set deployment as the API. Review unique-index failures rather than dropping or rebuilding data destructively.

For local webhook work, run the API and use Stripe CLI forwarding to the endpoint above. Use Stripe's current test cards, test bank accounts, microdeposit test amounts/descriptors, failure scenarios, and dispute/refund controls from the Stripe testing documentation; do not copy production credentials into local files. Wallet buttons require Stripe/device/browser/domain eligibility and may not appear in every test browser.

## Environment

Required when either Stripe method is enabled:

- `STRIPE_SECRET_KEY`: server-only test/live secret key.
- `STRIPE_API_VERSION=2026-09-30.endive`: SDK/API contract pinned by this release.
- `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`: absolute URLs; HTTPS is enforced in production. The success URL may contain `{CHECKOUT_SESSION_ID}` for display/status lookup, never as proof of success.
- `PAYMENT_STATUS_TOKEN_SECRET`: independent random secret of at least 16 characters for deterministic, unguessable guest status grants.

Webhook processing additionally requires `STRIPE_WEBHOOK_SECRET`. Method toggles are `STRIPE_CARD_ENABLED`, `STRIPE_ACH_ENABLED`, and `STRIPE_FINANCIAL_CONNECTIONS_ENABLED`. Fee estimates use method-specific BPS/fixed/cap/verification settings from `.env.example`; absent policies reject fee opt-in instead of guessing a provider price. `STRIPE_RECONCILIATION_MIN_AGE_MINUTES` is 5–10080 and batch size is 1–100.

Keep all secrets in a deployment secret manager. Never expose secret keys, signing secrets, status-token secret, or reconciliation environment to frontend bundles or logs. Keep Stripe test/live credentials and webhook destinations isolated.

## Checkout and status contracts

`POST /api/v1/payments/stripe/checkout-sessions` allows an optional bearer access token and requires `Idempotency-Key: 16-200 URL-safe characters`.

```json
{
  "donorName": "Donor Name",
  "donorEmail": "donor@example.org",
  "donorPhone": "+1 555 555 5555",
  "type": "general",
  "giving": "<giving ObjectId>",
  "amountCents": 2500,
  "currency": "USD",
  "methodFamily": "card",
  "coverFees": false
}
```

Event donations use `type:"event"` and `event` instead of `giving`. The server resolves the designation, enforces active/published eligibility and fixed/custom amount policy, calculates any opted-in fee contribution, and creates Donation/PaymentAttempt records transactionally. A successful response contains only `sessionId`, hosted `checkoutUrl`, `attemptId`, status, integer amount components, and currency. Guest responses also contain `statusToken`; authenticated responses do not. Reusing the same key and body returns the same attempt/session identity; reusing it with different checkout details returns `409 IDEMPOTENCY_CONFLICT`.

`GET /api/v1/payments/attempts/:id/status` requires either the owning bearer token or the guest token in `X-Payment-Status-Token`. It returns a PII-minimized status view. Phase 4D should poll this endpoint after redirect and treat `verification_pending` and `processing` as pending. It must not use the redirect, Session ID, mandate acceptance, bank connection, or client-supplied state as confirmation.

## Verification and lifecycle

The webhook route is registered with `express.raw({type:'application/json'})` before the application JSON parser. The official SDK verifies `Stripe-Signature` against the exact raw bytes. Invalid/missing signatures are rejected before ledger creation. The adapter retrieves authoritative Checkout Session, PaymentIntent, and Charge objects when needed, then verifies attempt ID, donation ID, provider references, USD currency, base donation, fee contribution, and total.

The durable `(provider,eventId)` ledger deduplicates deliveries and retains retryable failures. Processing uses MongoDB transactions and monotonic states: `created -> requires_action -> verification_pending/processing -> succeeded`; failed/canceled terminal browser flows can still accept a later verified success, while a succeeded attempt cannot regress. ACH remains pending during verification, mandate acceptance, debit initiation, and processing. Failed verification/debits and expired Sessions remain unconfirmed. No bank/routing number, credentials, mandate payload, or raw webhook body is persisted.

Successful full/partial refunds are separate adjustment rows keyed by Stripe refund ID. Disputes update a Stripe dispute-keyed adjustment; an ACH dispute is recorded as an `ach_return`. Won/closed disputes retain the original history and add a reversal row. Expanded balance transactions provide actual provider fees when Stripe makes them available; net proceeds are stored separately from the gross confirmed charge. Pending ACH is never counted as completed.

## Reconciliation

Run `npm run payments:reconcile:stripe` from a secured worker environment with database and Stripe credentials. It selects only a bounded batch of stale Stripe attempts in incomplete states, records attempt/failure metadata, retrieves the authoritative Checkout Session and PaymentIntent, and applies the result through the same verified state-machine boundary. It never creates a Checkout Session, PaymentIntent, charge, or repeat debit.

There is no scheduler in this repository. Production operations should invoke the command periodically with single-run process isolation and monitoring; choose the interval based on the configured minimum age and Stripe limits. Re-running is idempotent. Alert on nonzero exit, persistent reconciliation failures, webhook backlog, signature failures, adjustment mismatches, and unusually old pending ACH attempts.

## Production checklist

- Confirm the Stripe account, USD settlement, cards/Link/wallet domains, ACH, Financial Connections, and microdeposit fallback in the live account.
- Approve current fee policies; they are configuration, not hard-coded claims about Stripe pricing.
- Use distinct live keys and a live webhook destination; rotate any exposed credential.
- Require HTTPS for API and redirect URLs, configure the exact frontend origin, and keep endpoint secrets server-only.
- Deploy MongoDB as a replica set, back up first, run the non-destructive index command, and inspect unique-index results.
- Exercise test-mode card success/failure, ACH instant/microdeposit/processing/failure/return, duplicate and delayed webhooks, refunds, disputes, and reconciliation before live activation.
- Schedule and monitor reconciliation; monitor webhook delivery health and retain adjustment history.
- Keep the legacy bank-transfer route until its separately approved migration. Do not enable PayPal/Venmo or build refund/admin-reporting UI as part of this phase.
