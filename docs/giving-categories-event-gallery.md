# Giving categories and Event gallery rollout

Implementation is code-only. No Atlas/R2 migration, payment, email, deployment or production activation is authorized by this change.

## Contracts

- Public: GET /api/v1/giving-categories and /giving-categories/:slug return active categories only.
- Public: GET /giving?categoryId=<id> returns active, nondeleted Giving assigned to an active category.
- Existing GET /giving/:slug bookmarks and unassigned legacy records remain readable during transition.
- Admin category CRUD: GET/POST /admin/giving-categories; GET/PUT/DELETE /admin/giving-categories/:id; PATCH /admin/giving-categories/:id/status. Existing admin authentication/authorization applies.
- A category referenced by any Giving, including soft-deleted Giving, cannot be hard-deleted. Categories with active nondeleted Giving cannot be deactivated; deactivate/remap those Giving first.
- Giving accepts optional categoryId; omitted categoryId in an old editor preserves the existing assignment. Its legacy category/festivalGroup and USD integer-cents rules remain compatible.
- Stripe/PayPal initiation accepts optional categoryId and verifies it against the selected Giving. Existing provider availability flags and webhook verification are unchanged.
- NEW public scheduled-Event donations fail with EVENT_DONATIONS_DISABLED. Utsav Giving remain valid Giving designations; their legacy type=event reporting classification remains unchanged.
- Existing donations, amounts, snapshots, receipts, donor history, financial reports, CSV exports and offline admin Event donations are unchanged.
- Event image remains the cover. Optional gallery entries contain url, alt and integer displayOrder. Maximum 30 entries. An old PUT omitting gallery preserves it; an explicit empty array clears it.
- Gallery slider sorts by displayOrder, deduplicates the cover, supports autoplay/manual controls, keyboard, touch swipe, pause/play, reduced motion and local image fallback.

## Admin images

Gallery selection previews files before upload. Uploads are sequential, show per-image state/error and aggregate progress, and can retry failed images. Reordering/removing entries is local until Save. Cover selection can reuse a gallery image. Pending files must be uploaded or removed before Save.

JPG/JPEG, PNG and WebP: maximum 8 MiB per source. Existing signature checks, Sharp full decoding/orientation/metadata stripping, resource limits and WebP optimization are retained. Raw SVG uploads are not accepted. The admin endpoint accepts an optional validated lowercase entity slug and Event cover/gallery placement. New contextual uploads use immutable nested keys with the SHA-256 of optimized bytes; older clients without context continue using flat UUID keys.

Legacy managed keys remain supported: giving/<uuid>.webp, events/<uuid>.webp and categories/<uuid>.webp. New contextual uploads use categories/<slug>/<slug>-<sha256>.webp, giving/<slug>/<slug>-<sha256>.webp and events/<slug>/{cover|gallery}/<slug>-<sha256>.webp. Conditional creation prevents overwrite; a collision fails safely. Upload metadata contains uploader ID, kind, optional entity slug/placement and SHA-256, without filenames or credentials. Branding and home-slider remain separately protected immutable prefixes and are not accepted as admin upload kinds.

Explicit image deletion rejects URLs referenced by Giving, Categories, Event cover or gallery, including inactive/soft-deleted records. All object deletion is denied by default because current code cannot verify object ownership metadata, shared frontend references, protected rollback state and retention expiry together. Giving replacement, record soft deletion, cancelled uploads and removed gallery references retain the old objects. Unreferenced uploads may remain; inventory them for separately approved cleanup. Home-slider, official branding, shared site assets and legacy flat keys are never assumed deletable based on their filename.

Festival SVGs are trusted local educational assets and are not accepted by the JPEG/PNG/WebP admin pipeline. `src/utils/trusted-svg.ts` provides a strict static-use allowlist validator; it is not a sanitizer and must only be run on reviewed repository-owned assets. Keep local fallbacks. A future SVG copy requires client approval and a separate immutable static-asset namespace; do not enable arbitrary SVG uploads.

## Prepared catalog mapping

The exact 25-ID inventory and 23-ID relationship mapping are in src/content/giving-category-migration.ts. Preserve all IDs, slugs, fixed cents, descriptions, images and legacy fields.

| Category | Slug | Active Giving |
| --- | --- | ---: |
| Daily Seva | daily-seva | 7 |
| General Donation | general-donation | 1 |
| Dolotsav | dolotsav | 3 |
| Pragatya Divas / Maha Bhog | pragatya-divas-maha-bhog | 3 |
| Nand Mahotsav | nand-mahotsav | 3 |
| Adhikmas / Hindola | adhikmas-hindola | 2 |
| Annakut | annakut | 4 |

Inactive hhngh and testing remain unassigned and admin-only. The seven category artworks and English descriptions are client-approved and prepared locally, while the Atlas category image and description fields remain empty until a separately authorized category-only R2/Atlas migration. The UI continues to use existing decorative fallbacks until then.

The GivingCategory migration has completed: 7 categories, 25 Giving total, 23 active Giving, 2 inactive Giving, 7 Events and 2 Donations. No R2 image migration has been executed. Current read-only inventory found five R2 objects; all five have existing code or database references. Seven category image fields are empty, all seven Event galleries have zero entries, and two inactive/soft-deleted historical image URLs return 404. The five published Events use local festival SVG cover illustrations.

## Execution preparation — NOT EXECUTED

scripts/migrate-giving-categories.ts defaults to a read-only plan. It pins the reviewed Atlas SRV host and pushtidham_payment_sandbox database, development environment and replica-set writable primary. It rejects ID/slug/title/amount/status/classification drift, unexpected category identities and conflicting relationships.

Do not start/restart the real backend as a migration substitute: development Mongoose auto-indexing can create model collections/indexes. Index work belongs to the explicitly approved rollout.

1. Obtain separate approval for the exact Atlas target and mapping. Freeze catalog admin edits for the rollout.
2. Review a fresh read-only plan and counts. Stop on drift; do not relax guards.
3. Provision a private durable backup location outside BOTH repositories, with Windows ACLs restricted to the operator. Never use a shared/synced public folder or commit backups. Node mode 0600 does not enforce Windows ACL privacy by itself.
4. Export Events and Donations as private read-only backups as part of the operator backup checkpoint. The migration itself also fsyncs an exclusive Extended JSON backup of all Giving and existing categories before its first database write.
5. Review backup integrity. Execution requires --apply, --approval giving-categories-v1, and --backup <absolute-private-file>. No execution is authorized now.
6. Apply creates category indexes, then uses a replica-set transaction for seven deterministic category identities and the 23 categoryId assignments. Before writing, it rereads Giving/categories and rejects concurrent changes. Transaction failure leaves no partially mapped records; empty indexes may remain and are harmless.
7. Re-running an identical complete migration is a no-op. Conflicting partially populated category data is rejected for review.
8. Verify category membership/counts, all original Giving amounts/IDs/slugs, inactive exclusions and unchanged historical references. Verify public selectors, bookmarked Giving links, Event information and offline history/receipt/CSV using approved reads.
9. Only then approve rollout. Keep all payment flags disabled.

Rollback requires a separate approval, --rollback, --approval giving-categories-v1 and the original private backup path. It validates current Giving preimages and category identity/content before atomically unsetting ONLY the added assignments and removing ONLY the seven migration categories. Post-migration edits cause rollback to abort for manual review. Indexes are retained. Never restore whole financial collections over later transactions.

## R2 migration preparation — NOT EXECUTED

Frontend docs/r2-category-gallery-migration-manifest.json inventories local source files, sizes, SHA-256 and proposed immutable targets. It contains seven approved 1200 x 800 category WebP files and descriptions, but the category-only R2 migration has not been executed. Existing logo/favicon/slider assets remain unchanged.

1. Resolve image ownership and client approval; public accessibility is not a license.
2. Inventory all database image references and bucket objects read-only at a separately approved preflight. Snapshot each reference and source object metadata.
3. Copy to new versioned keys without overwriting, verifying bytes/hash, dimensions, MIME and public accessibility.
4. Switch only approved references after verification, with saved preimages and a small reviewable batch.
5. Retain local files/original keys through the rollback window. Revert references if verification fails.
6. Cleanup requires a separate approval plus reference inventory and retention deadline; never infer orphan status from one page.

No image migration executor is connected to application startup. The image-storage adapter supports immutable nested per-entity keys while retaining flat managed UUID compatibility. Seven future R2 uploads and seven category image/description updates still require separate authorization; Event galleries remain empty and all payment flags remain disabled.

The image upload limit is 8 MiB in both frontend and backend. The offline frontend manifest validator is `npm run validate:r2-manifest`; it verifies local file size and SHA-256, safe destinations, duplicate mappings, approval/ownership, protected objects and rollback completeness. The version 2 manifest records the approved category content but intentionally remains blocked by broader Event/gallery, inventory and rollout safeguards. No R2 credentials are needed to validate it.
