# Client catalog changes — applied October 19, 2026

Prepared October 19, 2026. Target: existing development Atlas database
`pushtidham_payment_sandbox`. **Applied with explicit approval: 7 updates and
16 additions; verified 25 total / 23 active Giving records.** The tables below
retain the original before/after plan for audit. See `current-development-handoff.md`.
Run `npm run catalog:plan` for a fresh, read-only comparison. The planner has no
apply mode and does not initialize models/indexes. A separately approved write
operation will be required after review of this exact plan.

## Architecture

Reuse Giving records with `category` (`daily_seva`, `general`, `utsav`) and a
`festivalGroup` key. Five named groups contain fifteen fixed-price options.
These are donation configurations, not Event occurrences. No dates, venues,
registrations or scheduled Events are created. Admins manage all options with
the existing Giving editor and R2 controls. Existing Event CRUD remains separate.

General donations reference ordinary/Daily Seva Giving. Event donations reference
either a scheduled Event or an Utsav Giving option, never both. The backend
checks category, active status and the exact configured amount. New Utsav
donations snapshot `designationTitle`, `festivalTitle`, `donationOptionTitle`,
top-level category and amount. Receipts/history/details use those saved values;
CSV adds Festival and Donation option columns. Provider validators/gateway
implementations and settings are not changed or activated by this work.

## Seven updates — keep IDs and public slugs

All stay active, fixed USD amounts, and receive `category=daily_seva`,
`festivalGroup=""`, and display order 1–7 in the order below. Preserve descriptions,
images, original slugs and every other existing field.

| Existing ID | Preserved slug | Current title | Proposed title | Current USD / cents | Proposed USD / cents |
|---|---|---|---|---|---|
| 6ad1021ef3748c180dd7a704 | mangla-seva | Mangla Seva | Mangla Seva | 84 / 8400 | 84 / 8400 |
| 6ad1021ef3748c180dd7a705 | palna-seva | Palna Seva | Palna Seva | 151 / 15100 | 151 / 15100 |
| 6ad1021ef3748c180dd7a706 | silver-palna-seva | Silver Palna Seva | Silver Palna Seva | 201 / 20100 | 201 / 20100 |
| 6ad1021ef3748c180dd7a708 | rajbhog-seva | Rajbhog Seva | Rajbhog Seva | 301 / 30100 | 301 / 30100 |
| 6ad1021ef3748c180dd7a707 | gold-palna-seva | Gold Palna Seva | Golden Palna Seva | 250 / 25000 | 251 / 25100 |
| 6ad1021ef3748c180dd7a709 | shayan-seva | Shayan Seva | Shayan Palna | 101 / 10100 | 101 / 10100 |
| 6ad1021ef3748c180dd7a70a | whole-day-manorathi | Whole Day Manorathi | Whole Day Seva | 401 / 40100 | 401 / 40100 |

## Sixteen new Giving records

All active with `amountType=fixed` and exactly one `fixedAmountsCents` value.
New IDs will be allocated only after approval. Images/descriptions use model
defaults (empty); no image operations are included.

General: `mahaprasad-manorathi`, title **Mahaprasad Manorathi**, $501 / 50100 cents,
`category=general`, `festivalGroup=""`, display order 20.

For the following rows, `category=utsav`. Display order is 100–114 in table order.

| Festival group key / title | Option title | New slug | USD / cents |
|---|---|---|---|
| dolotsav / Dolotsav | Mukhya Manorathi | utsav-dolotsav-mukhya-manorathi | 1001 / 100100 |
| dolotsav / Dolotsav | Sahayak Manorathi | utsav-dolotsav-sahayak-manorathi | 501 / 50100 |
| dolotsav / Dolotsav | Palana | utsav-dolotsav-palana | 151 / 15100 |
| pragatya-divas-maha-bhog / Pragatya Divas / Maha Bhog | Mukhya Manorathi | utsav-pragatya-divas-maha-bhog-mukhya-manorathi | 1001 / 100100 |
| pragatya-divas-maha-bhog / Pragatya Divas / Maha Bhog | Sahayak Manorathi | utsav-pragatya-divas-maha-bhog-sahayak-manorathi | 501 / 50100 |
| pragatya-divas-maha-bhog / Pragatya Divas / Maha Bhog | Palana | utsav-pragatya-divas-maha-bhog-palana | 151 / 15100 |
| nand-mahotsav / Nand Mahotsav | Mukhya Manorathi | utsav-nand-mahotsav-mukhya-manorathi | 1001 / 100100 |
| nand-mahotsav / Nand Mahotsav | Sahayak Manorathi | utsav-nand-mahotsav-sahayak-manorathi | 501 / 50100 |
| nand-mahotsav / Nand Mahotsav | Palana | utsav-nand-mahotsav-palana | 151 / 15100 |
| adhikmas-hindola / Adhikmas / Hindola | Weekday Manorathi | utsav-adhikmas-hindola-weekday-manorathi | 225 / 22500 |
| adhikmas-hindola / Adhikmas / Hindola | Weekend Manorathi | utsav-adhikmas-hindola-weekend-manorathi | 351 / 35100 |
| annakut / Annakut | Mukhya Manorathi | utsav-annakut-mukhya-manorathi | 3001 / 300100 |
| annakut / Annakut | Sahayak Manorathi | utsav-annakut-sahayak-manorathi | 2001 / 200100 |
| annakut / Annakut | Sha-Sahayak Manorathi | utsav-annakut-sha-sahayak-manorathi | 1001 / 100100 |
| annakut / Annakut | Manorathi | utsav-annakut-manorathi | 201 / 20100 |

## Retained data and counts

Retain soft-deleted Giving records `6ad19f2c5fbc9136a42322f8` (`hhngh`) and
`6ad1de89a0cdcc1647cebfec` (`testing`) exactly as-is. Do not resurrect them.

Retain all Events, including the existing five published tentative-2027 records:

| ID | Slug |
|---|---|
| 6ad1021ef3748c180dd7a70b | holi-dolotsav-tentative-2027 |
| 6ad1021ef3748c180dd7a70c | hindola-utsav-tentative-2027 |
| 6ad1021ef3748c180dd7a70d | shri-krishna-janmashtami-tentative-2027 |
| 6ad1021ef3748c180dd7a70e | nand-mahotsav-tentative-2027 |
| 6ad1021ef3748c180dd7a70f | annakut-govardhan-puja-tentative-2027 |
| 6ad1e02fa0cdcc1647cebfed | testing |
| 6ad5199a0858f415a4690bc9 | mangla-seva |

No deactivation is proposed. Existing tentative Events are not converted into
festival configuration, duplicated, or presented as newly confirmed schedules.
Their actual schedule/publication approval remains a client-confirmation item.

| Collection | Before | After approved application |
|---|---:|---:|
| givings (including soft-deleted) | 9 | 25 |
| givings active/non-deleted | 7 | 23 |
| events | 7 | 7 |
| donations | 2 | 2 |
| users | 4 | 4 |
| paymentattempts | 0 | 0 |
| paymentadjustments | 0 | 0 |
| webhookevents | 0 | 0 |

No new festival collection is needed: five logical groups are represented by
the fifteen Giving options. Existing Event records are scheduled occurrences,
so sharing a festival name is not a duplicate donation configuration.

## Apply conditions, duplicates, history and rollback

Before a separately authorized application, rerun the plan and compare every
matched ID/slug, status, amount and counts to the approved snapshot. Stop on
unexpected changes, a soft-deleted slug conflict, duplicate slug, missing Daily
Seva record, or matching title/group under another slug. Do not match by donor
email or change donation ownership. An application should use a transaction,
existing unique slug index, insert-only creation for absent options, and
conditional updates for the seven matched records. Rerunning against an already
applied catalog produces only retain actions.

Back up the seven exact original Giving documents and record all newly inserted
IDs before applying. Rollback restores only their changed catalog fields,
including unsetting newly added fields that were originally absent. Created
options are always deactivated rather than deleted by the prepared rollback
tool, protecting even concurrently created donation references. Raw Giving
count therefore remains 25 after rollback (seven active). Never rewrite or recalculate
donation amounts, titles, receipts, payment records or financial totals.

Existing $250 Golden/Gold Palna historical donations retain $250 and their saved
designation. Only donations created after an approved catalog update use $251.

Guarded execution tools and exact commands are documented in
`docs/client-catalog-migration.md`. Apply completed successfully; do not rerun
automatically on another laptop. The private original backup is not in Git.

## Open items

- Existing local `STRIPE_CARD_ENABLED=true` conflicts with the request that all
  gateways remain disabled. Credentials/settings have not been changed. The
  existing frontend preview gate remains; no provider APIs are called here.
  Explicit direction is needed for a separate payment-configuration change.
- Weekday/weekend are named donation options, not calendar-based eligibility
  rules; no unsupplied scheduling rules or date restrictions are invented.
- Use the confirmed spelling `Sha-Sahayak Manorathi` exactly as supplied.
- Public prices/names are sourced from backend records. Until approval/application,
  existing live catalog names/prices remain, and new Utsav/Mahaprasad options do
  not appear as selectable database-backed offerings.

## Files changed for this implementation

Backend:

- `package.json`, `src/content/client-catalog.ts`
- `src/models/giving.ts`, `src/models/donation.ts`
- `src/validators/catalog.ts`, `src/validators/donation.ts`
- `src/services/catalog.ts`, `src/services/donation-eligibility.ts`
- `src/services/donations.ts`, `src/services/donation-views.ts`, `src/services/donation-export.ts`
- `scripts/plan-client-catalog.ts`, `tests/client-catalog.test.ts`, `docs/client-catalog-plan.md`

Frontend:

- `components/donate.tsx`, `components/donation-panel.tsx`, `components/checkout.tsx`
- `components/giving.tsx`, `components/home.tsx`, `components/utsav-donations.tsx`
- `components/admin-catalog.tsx`, `components/admin-donations-real.tsx`
- `components/admin.tsx`, `components/account-overview.tsx`
- `lib/seva.ts`, `lib/catalog-api.ts`, `lib/donation-selection.ts`, `lib/checkout.ts`, `lib/api-client.ts`
- `lib/giving.ts`, `lib/events.ts`, `lib/admin-demo.ts` (legacy title compatibility)
- `app/globals.css`, `app/events/page.tsx`
- Public spelling-only changes: `app/not-found.tsx`, `app/checkout/page.tsx`,
  `app/donate/page.tsx`, `app/account/page.tsx`, `app/account/donations/page.tsx`,
  `app/donation/pending/page.tsx`, `app/donation/success/page.tsx`, `app/donation-confirmation/page.tsx`
- `tests/browser/client-seva.spec.ts`, `tests/donation-history-reporting.test.mjs`

Previously uncommitted SMTP, Contact Us, login, profile, receipt and image fixes
are retained. Local environment files and payment settings are not edited by
this implementation.
