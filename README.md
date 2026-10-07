# Pushtidham backend

Separate Phase 1 REST backend for the approved donation frontend. No frontend files are managed here. PayPal processing, bank verification workflows, email, PDF receipts, password-reset email, deployment and frontend integration remain future work.

## Stack and architecture

Node 22.19+ (Node 22 LTS tested), Express 5, TypeScript, MongoDB/Mongoose, Zod, JWT and bcrypt. npm and a committed package-lock.json provide reproducible installations.

`src/config`: environment/database; `routes`: routing; `controllers`: HTTP; `services`: business rules; `models`: persistence; `validators`: strict request DTOs; `middleware`: auth, validation, errors; `utils`: errors/logging/pagination; `types`: request types; `constants`: money/domain policy. `app.ts` creates the application; `server.ts` connects MongoDB and handles shutdown. `scripts` contains manual seeding/index creation. `tests` contains isolated integration tests.

## Install and configure

1. Install Node and MongoDB (local MongoDB 7+ or MongoDB Atlas; use a dedicated database).
2. Run `npm install` (or `npm ci` for reproducible CI).
3. Copy `.env.example` to `.env`. Set your database URI and two different cryptographically random JWT secrets of at least 32 characters. Template secrets intentionally fail startup validation. Never commit the resulting file.
4. Set `FRONTEND_URL` to the exact permitted origin without a trailing slash. Development defaults to port 4000 / frontend localhost:3000.
5. Run `npm run db:indexes` explicitly before production traffic. It creates declared indexes without dropping indexes; investigate duplicate data if unique-index creation fails. Production does not automatically build indexes.
6. Run `npm run dev`. Check `GET http://localhost:4000/api/v1/health`.

Required settings: NODE_ENV, PORT, MONGODB_URI, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, JWT_ACCESS_EXPIRES_IN (60s–30m), JWT_REFRESH_EXPIRES_IN (1h–30d), FRONTEND_URL. Optional COOKIE_SAME_SITE (lax/strict/none), TRUST_PROXY_HOPS (0 by default; configure only for your actual trusted reverse proxy), ADMIN_SEED_NAME/EMAIL/PASSWORD. Production frontend origin requires HTTPS. Cross-site frontend/backend origins require production HTTPS plus COOKIE_SAME_SITE=none; same-site subdomains can use lax. Cookies are host-only, HttpOnly and Secure in production, scoped to /api/v1/auth.

## Commands

- `npm run dev`: development watch server.
- `npm run lint`, `npm run typecheck`: static checks.
- `npm run build`, `npm start`: compile and run production code.
- `npm test`: run after building; tests also start dist/server.js. Uses mongodb-memory-server with an independent ephemeral MongoDB process and randomly generated test secrets. It never reads your configured database URI or wipes external databases. First run downloads a MongoDB binary and requires network access; cache/download artifacts stay ignored/outside Git. Tests stop their own database/process on completion.
- `npm run seed`: explicit admin seed using environment credentials. Password must be 12+ characters and at most 72 UTF-8 bytes. Existing admin password/status are preserved. A donor email cannot be silently promoted. Development adds missing example Giving/Event records using set-on-insert; production seeds only the admin. Never wipes data.
- `npm run db:indexes`: explicit non-destructive index creation.

## API contract

All paths start with /api/v1. JSON success: {success:true,data:...}; lists also include pagination {page,limit,total,pages}. Error: {success:false,error:{code,message,details?}}. IDs are MongoDB string IDs; dates are ISO 8601. Detail keys on persisted resources use _id; auth user DTO uses id. PUT replaces editable fields; PATCH /status changes lifecycle only. DELETE returns 204 and soft-deletes only designations without donations; otherwise 409 instructs deactivation. Historical records always retain references and designationTitle snapshots.

| Access                          | Method and path                                          | Purpose                                              |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Public                          | GET /health                                              | Database availability; 200 or 503                    |
| Public                          | POST /auth/register                                      | {name,email,password}; donor only                    |
| Public                          | POST /auth/login                                         | {email,password}                                     |
| Refresh cookie + trusted Origin | POST /auth/refresh, /auth/logout                         | Empty JSON body; rotate/revoke session               |
| Bearer                          | GET /auth/me                                             | Current database-owned identity/role                 |
| Public                          | GET /giving, /giving/:slug                               | Active, non-deleted Giving                           |
| Public                          | GET /events, /events/:slug                               | Published, non-deleted Events                        |
| Optional Bearer                 | POST /donations                                          | Create pending online donation intent; guest allowed |
| Bearer                          | GET /donations, /donations/:id                           | Own donations by user ID, never email                |
| Admin                           | GET/POST /admin/giving, /admin/events                    | List/create                                          |
| Admin                           | GET/PUT/DELETE /admin/giving/:id, /admin/events/:id      | Read/replace/safe soft-delete                        |
| Admin                           | PATCH /admin/giving/:id/status, /admin/events/:id/status | Activate/deactivate/publish                          |
| Admin                           | GET /admin/donations, /admin/donations/:id               | Filtered list/detail                                 |
| Admin                           | POST /admin/donations/offline                            | Manual donation in shared Donation model             |
| Admin                           | PATCH /admin/donations/:id/status                        | Pending to completed (offline only) or rejected      |

Giving body: {title,slug,description?,amountType,fixedAmountsCents?,status?,displayOrder?}. Modes: fixed, custom, fixed_and_custom. Slugs normalize lowercase and use hyphen-separated alphanumerics. Amounts deduplicate/sort; custom mode clears fixed amounts. Event body: {title,slug,shortDescription?,description?,startsAt,endsAt?,location,image?,status?}. UTC/offset-aware ISO dates required, end cannot precede start. Image is HTTP(S) URL or local asset path; text descriptions are plain content, and future clients must safely render/escape them.

Online donation body: {donorName,donorEmail,donorPhone?,type,giving?,event?,amountCents,currency?:'USD',paymentMethod:'paypal'|'bank_transfer',bankReference?}. General requires only giving; Event requires only event. Titles/configuration are fetched server-side, and status/source/admin identity cannot be submitted. An authenticated donation is linked to the authenticated user regardless of contact email. Guests have no donor-history access and cannot later claim history merely by matching email. POST creates an intent only: it does not charge, verify, complete a payment, or return a PayPal checkout URL. Implement idempotency/provider reconciliation before connecting payment processing.

Offline body uses the same contact/type/reference/amount fields plus optional {user,status,offlineReference,adminNote}; paymentMethod/source are server-set offline. User linking is explicit/admin-only and must reference an active user. Status defaults pending; admin can record completed/rejected offline entries. verifiedBy/timestamps are server-set. Final statuses cannot be reversed in Phase 1. Online completion is blocked even for admins until provider/bank verification is implemented. Donor DTOs omit admin notes, verification identity and internal payment references.

List queries: page=1, limit=20 (max 100), search (literal, max 100 chars). Admin Giving/Event add status. Donation lists add from/to ISO timestamps, type, paymentMethod, status, source, giving, event. User history enforces ownership independently of supplied filters. Date ranges are inclusive. Compound indexes support chronological lists, ownership, status, Giving and Event filters; optional broad search is escaped literal matching and may need dedicated search infrastructure at larger volumes.

## Domain and security

Exactly two conceptual categories: General maps to Giving; Event maps to Event. There is no DonationCategory collection. USD amounts are integer cents, centralized minimum 100 ($1), maximum 1,000,000 ($10,000). Fixed Giving accepts configured amounts only; custom/combined accept valid amounts within limits. Giving must be active. Public Events must be published and not deleted; date alone does not remove public visibility or donation eligibility. Admin offline donations may reference any existing Event, regardless of its date or lifecycle status, including a retained soft-deleted record when recording legitimate historical donations. The regular admin Event list excludes deleted entries; retained historical IDs can still be referenced. Offline creation still requires admin authorization and validates that the Event exists.

Donation numbers use PD-YYYYMMDD plus 64 random bits, a unique MongoDB index and retry on reference collision. Donation stores donor/designation snapshots to preserve history as catalog details change. User email and designation slugs are unique; sessions have unique session IDs and expiry TTL; chronological query indexes are defined with their models. No raw refresh tokens are stored.

Login/register returns {accessToken,user} and sets the refresh cookie. Keep access tokens in memory in the future frontend; send Authorization: Bearer on protected requests and credentials: include on auth cookie requests. Refresh/logout require Origin exactly FRONTEND_URL (including API clients); this prevents cookie-based CSRF. Access JWTs use separate signing keys/audiences from refresh JWTs, HS256 allowlisting and fixed issuer. Refresh tokens rotate using atomic hash compare-and-swap, have an absolute expiry, and signed-token replay revokes the whole session. Avoid parallel refresh calls in clients. Logout/session revocation immediately blocks access tokens too. Every request checks live user status and server-stored role. Disabled users cannot login/refresh/use existing tokens. Password reset can later revoke all user sessions and use passwordChangedAt; no reset workflow exists yet.

Helmet, restricted credentialed CORS, 32KB JSON limit, global/auth-specific process-local rate limits, strict Zod bodies/params/queries, bcrypt cost 12 and DTO mapping provide baseline protection. Production multi-instance deployments need a shared rate-limit store and correctly configured trusted proxy. Logs record request IDs/method/status/duration, never request bodies, URLs/query values, credentials or donor data. Unexpected API errors are generic; startup config errors name settings without values. Secrets, databases, generated output and caches are ignored. API never exposes password hashes/session hashes. Run behind HTTPS with least-privilege MongoDB credentials and operational monitoring before deployment.

## Future frontend integration

Replace demo/localStorage auth, catalog/admin CRUD, donor history and offline state with the endpoints above only in a separately approved frontend phase. Convert frontend dollar suggestions to integer cents, and frontend fixed-custom to backend fixed_and_custom. Map General/Event labels to general/event. Resolve IDs from catalog; do not send titles/roles/status as authority. Reports can consume admin pagination/filter APIs; full totals/CSV/export endpoints are future work and must not compute totals from one page. Agree on production origins, HTTPS/cookie deployment and Event eligibility before integration. PayPal, bank workflow, email, receipts and reset email require separate approval. No commit/push is performed by this implementation.
