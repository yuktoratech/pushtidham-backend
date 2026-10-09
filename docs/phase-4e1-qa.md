# Phase 4E-1 QA report

## Scope and environment

Phase 4E-1 validates the existing Phase 4A–4D-2 implementation only. Tests use Node 25.3.0, npm 11.7.0, isolated `MongoMemoryReplSet` databases, mocked Stripe/PayPal gateways, and headless Google Chrome. No production endpoint, credential, payment, or shared database is used.

## Requirement-to-test matrix

| Area | Automated evidence | Result |
| --- | --- | --- |
| Auth/session/roles | `api.test.ts`; browser protected donor/admin routes | Pass |
| Giving/Event eligibility and cents validation | `api.test.ts`, `payment-foundation.test.ts`, `stripe.test.ts`; browser catalog/detail/checkout | Pass |
| Stripe card/ACH initiation, signatures, lifecycle, reconciliation | `stripe.test.ts` | Pass (mock provider) |
| PayPal create/capture, authenticity, grant, reconciliation | `paypal.test.ts` | Pass (mock provider) |
| Idempotency, concurrency, rollback, deduplication | `payment-foundation.test.ts`, `stripe.test.ts` | Pass on real in-memory replica set |
| ACH delayed success/failure/return | `stripe.test.ts`; browser pending history | Pass (mock provider) |
| Refund/dispute/return accounting | `payment-foundation.test.ts`, `stripe.test.ts`, `donation-reporting.test.ts` | Pass |
| Donor ownership/PII minimization/admin authorization | `api.test.ts`, `donation-reporting.test.ts` | Pass |
| Pagination, stable sorting, index use | `donation-reporting.test.ts` with 250 additional records and `explain("executionStats")` | Pass |
| Responsive and keyboard behavior | `tests/browser/phase4e1.spec.ts` | Pass |
| Real Stripe/PayPal/ACH settlement | Not authorized; Phase 4E-2 | Skipped |

## Browser coverage

Real Chrome ran at 320, 375, 390, 430, 768, 1024, and 1440 pixels. It visited Home, Giving list/detail, Events list/detail, Donate, Checkout, login/register, donor account/history, admin dashboard/donations/details, and financial reports. The suite checks document overflow, checkout validation, fixed selection and refresh persistence, PayPal eligibility with ineligible Venmo suppression, pending ACH messaging, unknown fee presentation, and keyboard focus visibility. Screenshots are written to `/tmp` at 320, 768, and 1440 pixels and are not repository artifacts.

Provider and API responses are deterministic browser-level network fixtures. This is real-browser UI testing, not real-provider testing. Card/ACH redirect outcomes, provider-hosted UI, browser back/forward across provider origins, and live network timeout recovery remain Phase 4E-2.

## Security and financial findings

- Raw Stripe signatures and PayPal authenticity failures are rejected; duplicate and concurrent events are database-deduplicated.
- Server-side eligibility, currency, amount, donation mapping, merchant/payee identity, idempotency fingerprints, guest grants, ownership, and roles are covered.
- ACH verification and processing remain pending; only verified success completes a donation. Reconciliation does not initiate a second debit.
- All financial values are integer cents. Confirmed base, fee contribution, charged gross, known fee, adjustment loss, retained proceeds, pending, and failed/canceled totals remain distinct. Unknown fees remain unknown. Reversals are bounded so they cannot create artificial gains.
- Donor DTOs omit admin/private fields; guest email does not claim ownership; verified online records cannot be manually completed.
- No raw bank fields, webhook payloads, secrets, or sensitive provider objects are persisted or returned by tested contracts.

## Findings

- **Critical:** frontend dependency audit reports vulnerable `next@16.3.4` (including an RCE advisory). Upgrade to a patched compatible release and rerun all frontend/browser validation before production readiness.
- **High:** frontend audit reports high-severity advisories in direct/transitive build dependencies (`react-server-dom-webpack`, Cloudflare/Vite/Vinext tooling and related packages). Triage and controlled upgrades are required; no automatic major/downgrade fix was applied during QA.
- **Medium:** some frontend development-tool advisories remain. They are not accepted as safe merely because they are development dependencies.
- **Low:** provider URL safety is based on backend/provider trust; no attacker-controlled redirect path was demonstrated. A deployment review should still verify allowed return origins and provider configuration.
- Backend `npm audit` reports zero vulnerabilities.

No product defect was reproduced during the browser pass. Early browser failures were test-harness issues (missing test API origin, CORS origin mismatch, duplicate custom-element constructor, and a fixture using cents for the USD `choice` query field) and were corrected only in test infrastructure.

## Final validation

- Backend: 52 passed, 0 failed, 0 skipped; lint, standalone typecheck, and build passed.
- Frontend contract tests: 19 passed, 0 failed, 0 skipped.
- Frontend real-browser tests: 9 passed, 0 failed, 0 skipped.
- Frontend lint passed with 0 errors and 12 pre-existing `no-img-element` warnings; standalone typecheck and production build passed.
- `git diff --check` passed in both repositories. Nothing is staged, committed, or pushed.

## Phase 4E-2 handoff

Before Phase 4E-2: resolve the frontend dependency advisories; provision isolated Stripe and PayPal sandbox accounts and webhook endpoints; verify card redirect/return and failure/cancel paths; verify PayPal and eligible Venmo provider UI; run ACH Financial Connections or microdeposit verification through delayed settlement and return; validate provider fee reconciliation; and repeat the browser/security/accounting suite with sanitized evidence. Production activation, receipts, subscriptions, and deployment remain out of scope.
