# Laptop migration guide

This guide recreates the validated development environment without transferring secrets, dependencies, builds, browser caches, or donor/payment data.

## Repositories and branches

- Frontend: `https://github.com/yuktoratech/pushtidham-frontend.git`, branch `backend-integration`. The frontend `main` branch is the earlier approved demo and is not the integration branch.
- Backend: `https://github.com/yuktoratech/pushtidham-backend.git`, branch `main`.

```sh
git clone --branch main https://github.com/yuktoratech/pushtidham-backend.git
git clone --branch backend-integration https://github.com/yuktoratech/pushtidham-frontend.git
```

Keep the repositories beside one another only for convenience; neither project relies on an absolute filesystem path.

## Required software

- Node.js 22 LTS. Backend requires 22.19.0 or newer; frontend requires 22.13.0 or newer. Node 22.19+ satisfies both.
- npm included with Node. Use the committed lockfiles and `npm ci`.
- MongoDB 7 or newer running as a replica set. Transactions used by payments will not work on a standalone server.
- Google Chrome for the configured Playwright project.
- Optional sandbox tools: Stripe CLI and externally reachable HTTPS webhook forwarding.

Install Node and MongoDB using the official instructions for the new laptop's operating system. Do not copy `node_modules` or MongoDB database directories between machines.

## Install and configure

In each cloned repository:

```sh
npm ci
```

Backend configuration:

```sh
cd pushtidham-backend
cp .env.example .env
```

Edit `.env` locally. Generate two different JWT secrets of at least 32 characters and an independent payment-status secret. The placeholder JWT values intentionally fail validation. Keep provider methods disabled until sandbox configuration is complete.

Frontend configuration:

```sh
cd pushtidham-frontend
cp .env.example .env.local
```

`NEXT_PUBLIC_API_URL` is public and should point to the API base. Never put a server, payment, OAuth, JWT, or database secret in a `NEXT_PUBLIC_` variable.

## MongoDB replica set

Use a single-node replica set for local development or a dedicated Atlas development cluster. A typical local daemon is started with replica-set name `rs0`; initialize it once from `mongosh`:

```javascript
rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })
```

Then verify `rs.status()` and use:

```text
mongodb://127.0.0.1:27017/pushtidham?replicaSet=rs0
```

The exact service-management command differs across macOS, Linux and Windows. Do not point development or tests at production data.

Create declared indexes after the database is available:

```sh
cd pushtidham-backend
npm run db:indexes
```

The command creates declared indexes and does not drop data. Investigate duplicate-data failures rather than deleting records.

For optional non-sensitive development reference records and the first admin, fill `ADMIN_SEED_NAME`, `ADMIN_SEED_EMAIL`, and `ADMIN_SEED_PASSWORD`, keep `NODE_ENV=development`, then run:

```sh
npm run seed
```

The seed is additive: it retains an existing admin and inserts development Giving/Event examples only when missing. Remove seed credentials from `.env` after use if they are no longer needed.

## Start the application

Use separate terminals:

```sh
cd pushtidham-backend
npm run dev
```

```sh
cd pushtidham-frontend
npm run dev
```

Verify `http://localhost:4000/api/v1/health` and `http://localhost:3000`. The backend `FRONTEND_URL` must be exactly `http://localhost:3000` for local cookies/CORS.

No upload directory is required by this release. Build directories and test reports are created automatically and remain ignored.

## Validation commands

Backend:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm audit
```

Backend tests start an isolated in-memory MongoDB replica set. The first run may download a MongoDB test binary; it does not use the configured application database.

Frontend:

```sh
npm run lint
npx tsc --noEmit
node --test tests/*.test.mjs
npm run build
npm run test:browser
npm audit --omit=dev
npm audit
```

The Playwright configuration uses installed Google Chrome. Browser tests use deterministic API fixtures rather than real provider accounts. Generated reports, screenshots and browser binaries are not tracked.

## Stripe sandbox

Use only a Stripe test-mode secret key. Configure a test webhook for `/api/v1/webhooks/stripe`, copy its test signing secret into the backend `.env`, and enable only provider capabilities approved for that test account. Local Stripe CLI forwarding uses a temporary signing secret distinct from the Dashboard endpoint secret. Set card/ACH flags only after setup, keep redirect URLs local, and follow `docs/stripe-phase-4b.md` for events and reconciliation.

Provider credentials must be recreated in Stripe or transferred through an approved secret manager. Never send them through Git, chat, email, screenshots, or migration documents.

## PayPal sandbox and Venmo eligibility

Create a PayPal sandbox application plus separate sandbox merchant and buyer accounts. Configure the backend sandbox client ID/secret, merchant ID and webhook ID, and subscribe the HTTPS webhook to `/api/v1/webhooks/paypal`. Keep `PAYPAL_ENVIRONMENT=sandbox`. Enable PayPal only after configuration is complete; enable the Venmo flag only when the sandbox merchant is approved. SDK/browser eligibility remains authoritative, so Venmo may not render.

See `docs/paypal-phase-4c.md`. Credentials must be recreated or moved via an approved secret manager, never Git.

## Reconciliation

With the same secured backend environment used by the API:

```sh
npm run payments:reconcile:stripe
npm run payments:reconcile:paypal
```

These commands process bounded stale attempts and do not initiate another payment. There is no built-in scheduler. Test against sandbox data first; schedule and monitor externally only after a separate deployment approval.

## Intentionally untracked or separately transferred

- `.env` and `.env.local`: recreate from templates and transfer secrets only through an approved secret manager.
- `node_modules`, `.next`, `dist`, `build`, `out`: regenerate with `npm ci` and build commands.
- Playwright reports, screenshots, browser binaries, MongoDB test binaries and caches: regenerate locally.
- `.DS_Store`, editor settings, logs and temporary files: unnecessary machine-local artifacts.
- MongoDB data, donor/payment records, sessions and provider ledgers: intentionally not in Git.
- There are no required local uploads in this release.

Do not copy a raw database directory between systems. If real operational data ever requires migration, stop and obtain explicit approval for a separately designed, access-controlled, encrypted backup/restore procedure. No production donor/payment export is part of this handoff.

## Current status and known advisories

Phases 1 through 4E-2A are implemented. The last validation produced 52 backend tests, 19 frontend contract tests and 9 Chrome tests. Backend audit and frontend production-only audit were clean. The full frontend audit retained 20 development/build/deployment findings: 10 high and 10 moderate. The overall security gate remains blocked. See `docs/phase-4e2a-dependency-security.md`.

Phase 4E-2B is next. It must resolve or explicitly control the tooling dependency path and conduct authorized real-provider sandbox tests. It must not activate live payments or deploy production without separate approval.

## Troubleshooting and verification checklist

- Confirm `node --version` is Node 22.19+ and `npm --version` is available.
- Confirm the exact branches with `git branch --show-current`.
- Run `npm ci`; do not reuse copied dependency directories.
- Confirm MongoDB is a replica set and the URI includes the matching replica-set name.
- Confirm frontend/API ports and exact backend `FRONTEND_URL` match.
- Check backend health before starting browser tests.
- Keep provider toggles false until all required sandbox values exist.
- If webhook verification fails, verify raw-body routing, endpoint ID/signing secret, environment and forwarded URL.
- Run indexes, then lint, typecheck, tests, builds and audits.
- Confirm `git status --short` contains no secrets, builds, reports or local databases.
