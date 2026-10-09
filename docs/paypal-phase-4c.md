# PayPal Phase 4C operations

Phase 4C adds server-side PayPal Orders v2 for one-time USD donations. It preserves legacy `Donation.paymentMethod: paypal` intent records: only a new `PaymentAttempt.provider: paypal` with an authoritative Order/Capture reference can confirm a donation.

## Configuration and sandbox

Set `PAYPAL_ENABLED=true` only with sandbox/live client credentials, webhook ID, merchant ID, return/cancel URLs, and `PAYMENT_STATUS_TOKEN_SECRET`. `PAYPAL_ENVIRONMENT` selects `sandbox` or `live`; credentials never leave the backend. Create a sandbox merchant and buyer account, configure an HTTPS webhook destination for `/api/v1/webhooks/paypal`, and subscribe to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, and supported dispute events.

`POST /api/v1/payments/paypal/orders` requires a 16–200 character `Idempotency-Key` and the donor/designation fields used by Stripe, except no client payment method or totals. It creates an Orders v2 `CAPTURE` order with server-calculated USD cents and returns `orderId`, a trusted PayPal approval URL, attempt ID, amount breakdown, and a guest-only status token. It does not complete a Donation.

`POST /api/v1/payments/paypal/orders/:orderId/capture` requires the authenticated owner or the guest `X-Payment-Status-Token`. It retrieves the Order first, requires PayPal `APPROVED` or `COMPLETED`, then uses a stable capture request ID. A browser result alone cannot authorize a capture or payment completion.

## Webhooks, lifecycle, and reconciliation

The webhook route keeps the raw body, passes original PayPal transmission headers and event body to PayPal’s verification endpoint, and rejects anything not verified. Verified events are deduplicated in the shared ledger and must match order/capture references, USD amount, Donation, attempt, and configured merchant ID. Approved Orders remain pending; capture completed confirms; pending remains pending; denied/failed remains unconfirmed. Full/partial verified capture refunds create separate adjustment records. PayPal dashboard refunds remain the only refund initiation path.

Run `npm run payments:reconcile:paypal` from a secured worker with database and PayPal credentials. It reconciles a bounded stale batch through the same verified state-machine boundary, records failures, and never creates another order or capture. Schedule it externally and alert on failures.

## Venmo

Venmo is a PayPal funding source, not a separate provider. Phase 4D should load the PayPal JavaScript SDK with `enable-funding=venmo` only when `PAYPAL_VENMO_ENABLED=true`, then render it only if the SDK eligibility API permits it. Merchant approval, US buyer/region, device/browser, and PayPal capability decide availability; backend records `actualFundingSource: venmo` only when the authoritative completed Order says so. Sandbox behavior differs from live eligibility.

Before production: activate/approve PayPal and Venmo, configure live URLs/webhook ID/merchant ID, test buyer approval/capture/pending/denial/refund/dispute/retry paths, run indexes on a MongoDB replica set, approve fee settings, and schedule reconciliation. No frontend checkout UI, recurring billing, receipts, admin reporting, or new bank-transfer integration belongs to this phase.
