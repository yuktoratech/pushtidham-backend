# Seven-category artwork migration checkpoint

This procedure is prepared only. Do not run `apply` until the operator supplies the exact approval phrase `APPROVE PHASE 3 CATEGORY MIGRATION EXECUTION`. Do not commit, deploy, or restart applications as part of preparation.

Target: development Atlas `pushtidham-dev.p6lbrfc.mongodb.net/pushtidham_payment_sandbox`; R2 bucket `pushtidham`, public URL `https://pub-bcdd94010c11431cad2500a97fbe995f.r2.dev/`. The command reads the seven approved WebP files and descriptions from the frontend manifest and refuses other host, database, environment, bucket, public URL, payment flags, IDs, slugs, content hashes, formats, or dimensions.

## Execution prerequisites

1. Every backend instance serving category admin writes must run the new `categoryEditFreeze` middleware on all four category mutation routes. Stop all older instances. Confirm no other process or script can write `givingcategories` during the migration. Drain in-flight category writes. The `--all-instances-gated verified` and `--writers-drained verified` arguments are operator attestations, not automatic discovery; never supply them without checking. If coverage cannot be guaranteed, do not execute.
2. In PowerShell, prepare a directory outside both repositories with access restricted to the current operator and Administrators, then verify its ACL. Example: `New-Item -ItemType Directory -Force -Path 'C:\Users\JTAPP1\PushtidhamPrivateBackups'` followed by `icacls 'C:\Users\JTAPP1\PushtidhamPrivateBackups' /inheritance:r /grant:r 'JTAPP1:(OI)(CI)F' 'Administrators:(OI)(CI)F'`. Inspect the ACL before continuing. Do not put the backup in either repository, logs, or a public folder. The script refuses broad parent ACLs and an existing backup with different bytes.
3. Run the read-only checkpoint from `D:\MEAN\pushtidham-backend`: `npx.cmd tsx scripts/migrate-category-artwork.ts plan`. Require seven categories with empty image/description preimages, all seven destination objects absent or byte-identical, and counts Giving 25, Events 7, Donations 2, Users 4. This also checks all five online payment flags are false.

## Apply

From `D:\MEAN\pushtidham-backend` in the approved development environment:

```powershell
npx.cmd tsx scripts/migrate-category-artwork.ts apply --approval "APPROVE PHASE 3 CATEGORY MIGRATION EXECUTION" --backup "C:\Users\JTAPP1\PushtidhamPrivateBackups\category-artwork-preimage.ejson" --all-instances-gated verified --writers-drained verified
```

The command sets a majority-acknowledged shared edit freeze. It saves complete seven-document Extended JSON preimages to the private backup and checks SHA-256 plus BSON/Extended JSON round-trip. It uploads only missing immutable R2 keys with the original approved bytes; existing keys must match size, content type, metadata SHA-256, and retrieved-byte SHA-256. It verifies public URL bytes. One Atlas transaction conditionally updates only `image` and `description` on the seven documents. The command checks unchanged IDs, slugs, other fields, collection counts, and payment flags before releasing the freeze. A failure leaves the freeze active for investigation. Never blindly retry after a failure; inspect state and backup first. Do not automatically delete R2 objects.

## Rollback

Keep all API instances on the gated code and drain category writers. The rollback requires the exact previously written image/description pairs, so it refuses to overwrite subsequent category edits. It restores only those two fields using one transaction, verifies other fields/counts, and retains uploaded R2 objects.

```powershell
npx.cmd tsx scripts/migrate-category-artwork.ts rollback --approval "APPROVE PHASE 3 CATEGORY MIGRATION EXECUTION" --backup "C:\Users\JTAPP1\PushtidhamPrivateBackups\category-artwork-preimage.ejson" --all-instances-gated verified --writers-drained verified
```

If either command fails after setting the freeze, do not manually clear the flag until the category state has been verified and a safe recovery path chosen.
