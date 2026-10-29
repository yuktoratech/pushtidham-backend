# Offline donation corrections

This feature is implemented locally; no production rollout, database migration, email, or payment activation was performed.

## Boundaries

Only authenticated admins can PATCH /api/v1/admin/donations/:id/offline. Source and payment method must both be offline, in Pending, Completed or Rejected status. Status is not accepted in the correction body. Online financial lifecycle records are never edited. A linked payment attempt or adjustment requires separate review and blocks correction.

The strict schema accepts a complete editable draft: expectedVersion, reason (trimmed, 1-1000 characters), donorId, confirmDonorReassignment, donor identity snapshot, Giving or historical Event designation, integer amountCents ($1-$10,000), optional purpose (Other requires it, 500 characters maximum), donationDate (ISO offset), offline subtype, reference and internal note. Existing amount/eligibility rules are reused. Historical inactive Giving may remain unchanged at its original amount; a changed target or amount must pass current rules. Historical Events need only exist.

The original ID, reference, createdAt, status and provider identifiers remain immutable in this flow. Donation date is a separate field. Reports/CSV date filters prefer explicit donationDate; historical records retain their existing creation-date semantics. Receipt dates preserve the old completion/verification fallback until explicitly corrected.

## Transactions and identity

A MongoDB replica set is required. Every correction uses one transaction to conditionally update the donation and append an audit record, including actor from the authenticated principal, reason, before/after changed fields, version and receipt impact. Conditional version checks also detect concurrent status actions. Status verification advances the same record version. HTTP retries must reuse the exact body and Idempotency-Key (16-200 alphanumeric/underscore/hyphen characters). Reusing a key with another body conflicts; stale drafts conflict; no-op drafts are rejected.

Reassignment requires an explicit confirmation and an active existing donor account. Account identity is resolved server-side, never trusted from submitted names. The previous owner loses history and current receipt access. No accounts are merged/deleted/created, sessions altered, welcome emails retriggered, or receipt emails sent during correction.

Audit entries have unique donation/version and donation/actor/request-key indexes; receipt snapshots have a unique donation/revision index. There are no application update/delete routes for either ledger; model mutation hooks reject normal query mutations. Database administrators remain capable of raw database access: use least-privilege access, protected backups and retention policies. Restrict these PII-bearing audit/PDF collections to authorized staff.

## Receipts and legacy limitation

Previously all receipts were rendered on demand, with no persistent issued snapshots. Never backfill receiptHistoryTracked=true for historical Completed donations merely to unlock editing: original issued content cannot be proven. Receipt-impacting corrections on these records are blocked with HISTORICAL_RECEIPT_UNAVAILABLE. Internal note corrections remain available, including unknown historical offline subtypes. Recover and verify original issued content under a separately approved process before enabling financial correction for such a record.

New offline donations are explicitly tracked from creation. Pending/Rejected records cannot issue receipts and may establish tracking before completion. Future offline downloads persist exact PDF bytes with a SHA-256 digest. A write fence on the donation serializes snapshot issuance with correction/reassignment. Completed receipt-impacting edits preserve the current exact PDF and create a corrected revision in the same transaction; PDF failures roll back the donation and audit as well. If no receipt has been issued on a tracked new donation, revision 1 is rendered from its unchanged preimage before revision 2 is produced. This is not claimed to recover legacy receipts.

GET /api/v1/admin/donations/:id/corrections exposes admin-only audit history and receipt metadata. GET /api/v1/admin/donations/:id/receipts/:revision provides authorized audit downloads whose filenames explicitly mark superseded versions. Supersession is derived from the current donation receipt pointer; immutable old snapshot documents are never overwritten. Donors use the existing current-receipt endpoint, with current ownership and eligibility checks; they cannot choose a historical revision. Online receipt behavior and completed-only payment verification are preserved.

## Rollout requirements (not executed)

1. Back up the existing database under the normal approved procedure; use a replica set with transaction support.
2. Deploy backend schema/routes and build the required additive indexes before enabling the frontend editor. The existing npm run db:indexes now includes DonationCorrection and DonationReceipt. Review and authorize that operation separately for the target database; this implementation did not run it on Atlas.
3. Do not rewrite historical donations or manufacture archived receipt versions. No data backfill or new environment variable is required.
4. Deploy the matching frontend after backend routes/indexes are ready. Preserve authentication, payment flags and all existing environment settings.
5. Validate using separately approved local/test fixtures. No production donor sessions or payments are needed.

## Local verification

Focused coverage is in tests/offline-donation-corrections.test.ts, tests/offline-donations.test.ts and tests/donor-receipt.test.ts using isolated in-memory localhost replica sets. Frontend browser tests intercept every API request with fixtures in tests/browser/offline-donation-edit.spec.ts, including Pending/Completed/Rejected editing, review, reassignment, conflict drafts, uncertain retry identity, fixed/custom validation and mobile layouts. No live Atlas records, R2 objects or emails are used.
