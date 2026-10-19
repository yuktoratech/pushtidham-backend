# Guarded client catalog migration

Applied with explicit approval on October 19, 2026: seven updates and sixteen
inserts, followed by successful read-only verification. Do not execute these
commands automatically during laptop setup. The original private manifest stays
on the original laptop, outside Git; see `current-development-handoff.md`.
The approved data is specified in `client-catalog-plan.md`; both tools reuse its read-only planner.

## Required gates

- Existing environment must be `NODE_ENV=development` and
  `MONGODB_DATABASE=pushtidham_payment_sandbox`.
- The existing URI must use Atlas SRV (`mongodb+srv`, `.mongodb.net`). Its database
  path must be empty or the approved database. Supply its exact hostname without
  credentials as `--host`. No environment values are changed by these tools.
- Explicit database, hostname, backup path and mode-specific confirmation required.
- Existing transactions and unique Giving slug index required; no index creation
  or non-atomic fallback. Apply checks 9 Giving records, all seven frozen IDs,
  slugs, titles, prices, active status and absent classification fields, both
  retained deleted IDs, all 16 absent additions and protected collection counts.
- Before any database writes, save complete originals, retained records, approved
  changes and all 16 preallocated IDs to an exclusive-create EJSON manifest.
  File mode 0600, directory 0700, checksum and fsync of file/directory required.
  `.local-migrations/` is Git-ignored. Protect and retain this backup locally.
- The transaction compares complete documents to that backup, aborting on drift.
  Only `givings` is written. Events, Users, Donations, payment records, receipts,
  environment/payment configuration and R2 are never written.

## Commands — execute only after separate approval

Replace `EXACT_ATLAS_SRV_HOST` with the hostname from the configured URI, not
the entire URI. Run from the backend repository root, using the same backup
path for apply, retry and rollback.

```sh
npm run catalog:apply -- --database pushtidham_payment_sandbox --host EXACT_ATLAS_SRV_HOST --backup .local-migrations/client-catalog-v1.ejson --confirm APPLY_client-catalog-2026-10-19-v1_TO_pushtidham_payment_sandbox
npm run catalog:rollback -- --database pushtidham_payment_sandbox --host EXACT_ATLAS_SRV_HOST --backup .local-migrations/client-catalog-v1.ejson --confirm ROLLBACK_client-catalog-2026-10-19-v1_IN_pushtidham_payment_sandbox
```

## Recovery and rollback

Apply atomically updates seven and inserts sixteen, resulting in 25 raw / 23
active Giving records. A retry with the same manifest recognizes the complete
applied state and writes nothing. An aborted transaction leaves the nine original
records intact; retry reuses the backed-up IDs. If commit acknowledgement is
uncertain, retain the manifest and inspect state before retrying; never delete it
or allocate a replacement manifest. Missing, invalid or insecure backups fail
closed. A checksum detects accidental corruption, not malicious local tampering.

Rollback requires the intact manifest and exact post-migration catalog state.
It restores seven original documents exactly and **deactivates all sixteen
additions, never deleting them**. This safely preserves new or concurrent
donation references. Raw count stays 25; active count returns to seven.
Post-migration catalog edits cause an abort for manual review, not an overwrite.
Rollback is idempotent; before apply it reports `not-applied`. Apply refuses a
rolled-back state rather than automatically reactivating additions.

Do not edit catalog records concurrently with an approved execution. Transactions
protect Giving writes; protected collection counts are snapshot preconditions,
not a global lock against unrelated application activity. No historical financial
values are recalculated. Keep the original backup for recovery and migration audit.

## Isolated validation

`node --import tsx --test tests/client-catalog-migration.test.ts` creates its own
temporary local replica set and fixtures, never loading the Atlas connection.
Tests cover apply, retry, transaction abort/recovery, drift/target rejection,
backup protection and rollback with referenced additions.
