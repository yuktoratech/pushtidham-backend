# Current development handoff — October 19, 2026

Backend branch: `main`. Frontend branch: `backend-integration`; do not merge into
the frontend demo-only `main` branch automatically.

## First action on the next laptop: payment safety

**Unresolved blocker:** the current development environment has
`STRIPE_CARD_ENABLED=true`. Direct API Stripe Card Checkout initiation is
reachable, including guest checkout. The configured key was verified as test-mode,
not live-mode. The frontend client-demo gate only hides checkout details/review;
it does not disable the backend endpoint. ACH, Financial Connections, PayPal and
Venmo were disabled during the last inspection.

Do not describe backend payments as disabled. Do not initiate payments or change
provider flags without separate approval. Review and resolve this blocker before
continuing payment-related QA or considering production readiness. Credentials
and payment settings are not part of this handoff commit.

## Catalog migration already applied

The guarded transaction was applied to development Atlas database
`pushtidham_payment_sandbox`: seven originals updated, sixteen Giving records
inserted. Verified totals: 25 Giving / 23 active, seven Events, two Donations and
four Users. Protected record fingerprints were unchanged. This is not a pending
migration; **do not run apply or rollback automatically on the next laptop**.

The private rollback manifest remains on the original laptop at
`.local-migrations/client-catalog-v1.ejson`, mode 0600 in a 0700 directory.
It is intentionally Git-ignored and is not available by cloning GitHub. Preserve
it and transfer securely outside Git if recovery on another laptop is required.
Never create a substitute manifest for the already-applied migration.

## QA boundaries and remaining work

Catalog prices/groups, selection URL/storage context, fixture-backed receipts,
history and CSV snapshots passed focused QA. Checkout details/review remain
blocked by the existing client-demo gate. Live authenticated admin verification
remains pending; previous editor tests used mocked authentication.

Repeated public navigation reached the shared per-IP limit of 120 requests per
minute. No limiter adjustment was made; consider a separately bounded public
catalog GET limiter without weakening authentication/admin/payment protections.
Twenty-two active catalog records have no assigned image; existing fallbacks
rendered without broken images. No image uploads are required for setup.

Local environment files must be configured securely on the new laptop, never
copied into source control. Consult `auth-email-receipts.md`,
`catalog-image-uploads.md` and `client-catalog-migration.md` for implementation
details. Do not seed Atlas, run migrations, send email or modify R2 as setup steps.
