# Project handoff

## Architecture and completed scope

Pushtidham Haveli USA consists of a Next.js/React frontend and a separate Express/TypeScript/MongoDB backend. The frontend `backend-integration` branch talks to versioned `/api/v1` endpoints. The backend `main` branch owns authentication, catalog eligibility, donation/payment state and financial reporting. Monetary values are integer USD cents.

Completed work:

- Phase 1: backend foundation, validation, catalog, donations, indexing and safe seed.
- Phase 2: real authentication, refresh rotation, roles and frontend session integration.
- Phase 3: backend Giving/Event catalog and admin CRUD integration.
- Phase 4A: provider-neutral payment attempts, webhook ledger and adjustments.
- Phase 4B: Stripe Checkout for card/eligible wallets and ACH, verified webhooks and reconciliation.
- Phase 4C: PayPal Orders v2, PayPal Wallet, eligible Venmo funding, verified webhooks and reconciliation.
- Phase 4D-1: real frontend checkout, capability discovery and authoritative confirmation.
- Phase 4D-2: donor history, admin donations and financial reporting.
- Phase 4E-1: automated, replica-set, real-browser, security and accounting QA.
- Phase 4E-2A: compatible frontend runtime security updates.

## Payment and donation rules

The backend is authoritative for designation eligibility, amount policy, fee calculation, merchant identity, ownership and status. A browser redirect, SDK callback or provider approval is never proof of payment. Only authenticated provider retrieval plus verified webhook/reconciliation facts may complete an online donation.

Stripe uses hosted Checkout. Card flows can expose Link or eligible wallets through Stripe; ACH remains pending through verification and processing. PayPal uses Orders v2 and server capture. Venmo is an eligible PayPal funding source, not a separate provider. Both integrations use idempotency keys, exact reference/amount/currency checks, raw-body signature/authenticity verification, a durable deduplication ledger, monotonic state transitions and bounded reconciliation. Refunds, returns and disputes are accounting adjustments; this application does not initiate refunds.

Guests may initiate payments and receive a browser-scoped status grant. Authenticated donations are linked by the authenticated user ID, never by matching email. Donor history enforces ownership and omits administrative/provider-private fields. Administrators can record or finalize eligible offline records, but cannot manually mark provider-backed online payments complete.

Financial reporting separates base donation, fee contribution, gross charge, known provider fee, verified losses/reversals and retained proceeds. Pending amounts are not confirmed income, and unknown fees remain unknown rather than zero.

Legacy PayPal and bank-transfer donation records remain compatible but are classified separately from verified provider attempts. Their historical status is not upgraded merely by label or browser state.

## QA and security evidence

The latest completed validation reported:

- Backend: lint, typecheck and build passed; 52 replica-set tests passed; `npm audit` reported zero vulnerabilities.
- Frontend: lint and typecheck passed; production build passed; 19 contract tests passed.
- Real Chrome: 9 deterministic Playwright tests passed at 320, 375, 390, 430, 768, 1024 and 1440 pixels.
- Total: 80 tests passed.
- Next.js 16.3.8 and React/React DOM/RSC 19.2.8.
- Frontend production-only audit: zero vulnerabilities.

The full frontend dependency tree still reports 20 development/build/deployment advisories: 10 high and 10 moderate. A Cloudflare/Vite plugin remediation requires `@cloudflare/workers-types` major 5 while the project pins major 4. That cross-major migration was deliberately not forced. Other remaining paths include `braces`/`fast-glob`, Cloudflare Miniflare `undici`/`ws`, legacy Drizzle Kit tooling and Vinext tooling. The Phase 4E-2A overall security gate is therefore **blocked** even though the runtime production subset is clean.

Detailed evidence is in `phase-4e1-qa.md` and `phase-4e2a-dependency-security.md`.

## Readiness limits

Real Stripe card/ACH settlement, PayPal buyer approval/capture, eligible Venmo UI, provider webhook delivery, refunds/disputes, fee settlement and reconciliation have not yet been exercised with operator-supplied sandbox accounts. Automated tests use mock providers and deterministic browser fixtures.

Production readiness is not approved. There has been no production deployment, live payment activation, provider credential provisioning, operational scheduler approval or sensitive-data migration.

## Exact next phase

The next phase is **Phase 4E-2B**. It should make an explicit decision on the Cloudflare Workers types v5/tooling migration (or removal/waiting path), rerun all audits and regression suites, and then perform separately authorized real-provider sandbox validation with sanitized evidence.

Phase 4E-2B must not enable live credentials, activate live payments, migrate production data or deploy to production without separate explicit approval.

For second-laptop setup, environment recreation and safe data handling, follow `LAPTOP_MIGRATION.md`.
