import "dotenv/config";
import {createHash} from "node:crypto";
import {open, readFile, realpath, lstat} from "node:fs/promises";
import {resolve, dirname, relative, isAbsolute, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {MongoClient, ObjectId, BSON} from "mongodb";
import {S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import sharp from "sharp";
import {CATEGORY_FREEZE_ID} from "../src/middleware/category-edit-freeze.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FRONTEND = resolve(ROOT, "../pushtidham-frontend");
const HOST = "pushtidham-dev.p6lbrfc.mongodb.net";
const DATABASE = "pushtidham_payment_sandbox";
const BUCKET = "pushtidham";
const PUBLIC = "https://pub-bcdd94010c11431cad2500a97fbe995f.r2.dev";
const APPROVAL = "APPROVE PHASE 3 CATEGORY MIGRATION EXECUTION";
const APPROVED_DESCRIPTIONS: Record<string, string> = {
 "daily-seva": "Support daily seva offerings and devotional services at Pushtidham Haveli.",
 "general-donation": "Contribute toward Mahaprasad and the Haveli's devotional activities.",
 dolotsav: "Participate in Dolotsav celebrations through dedicated seva offerings.",
 "pragatya-divas-maha-bhog": "Support Pragatya Divas and Maha Bhog seva offerings.",
 "nand-mahotsav": "Celebrate Nand Mahotsav through special devotional seva offerings.",
 "adhikmas-hindola": "Support special Hindola seva offerings during Adhikmas.",
 annakut: "Contribute toward Annakut celebrations and devotional food offerings.",
};
const APPROVED_IDS: Record<string, string> = {
 "daily-seva": "5cd141e27aa548b08e859ec1", "general-donation": "34182ed239cb95df622288cc",
 dolotsav: "013ed2dcfa609d03285d1ddd", "pragatya-divas-maha-bhog": "c0e46f2266fce999bc02d5cc",
 "nand-mahotsav": "dd9b046182853ea6447d1fb2", "adhikmas-hindola": "ebc31477cbc3b20077006a71",
 annakut: "3c61fb0cc4df85b97c1eec99",
};
const args = process.argv.slice(2);
const mode = args[0] ?? "plan";
const option = (name: string) => {const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]};
const fail = (message: string): never => {throw new Error(message)};
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => BSON.EJSON.stringify(value, {relaxed: false});
const inside = (root: string, target: string) => {const path = relative(root, target); return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))};

function verifyTarget() {
 const uri = process.env.MONGODB_URI ?? "";
 const target = (() => {try {return new URL(uri)} catch {return fail("Missing Atlas URI")}})();
 if(target.protocol !== "mongodb+srv:" || target.hostname !== HOST || process.env.MONGODB_DATABASE !== DATABASE || process.env.NODE_ENV !== "development") fail("Wrong Atlas environment");
 if(process.env.R2_BUCKET_NAME !== BUCKET || process.env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, "") !== PUBLIC) fail("Wrong R2 target");
 for(const key of ["STRIPE_CARD_ENABLED","STRIPE_ACH_ENABLED","STRIPE_FINANCIAL_CONNECTIONS_ENABLED","PAYPAL_ENABLED","PAYPAL_VENMO_ENABLED"])
  if(process.env[key] !== "false") fail("An online payment flag is enabled");
 return uri;
}

type Artwork = {slug: string; id: string; description: string; source: string; bytes: Buffer; sha256: string; key: string; url: string};
async function approvedArtwork(): Promise<Artwork[]> {
 const manifest = JSON.parse(await readFile(resolve(FRONTEND, "docs/r2-category-gallery-migration-manifest.json"), "utf8"));
 const assets = manifest.assets.filter((a: {assetCategory?: string}) => a.assetCategory === "category-artwork");
 if(assets.length !== 7 || manifest.categoryArtwork?.length !== 7) fail("Expected seven approved category assets");
 const seen = new Set<string>(); const results: Artwork[] = [];
 for(const row of manifest.categoryArtwork) {
  const asset = assets.find((a: {id: string}) => a.id === row.assetId);
  if(!asset || row.approvalStatus !== "client-approved" || row.descriptionApproval !== "client-approved" || row.description !== APPROVED_DESCRIPTIONS[row.slug] || row.categoryId !== APPROVED_IDS[row.slug] || asset.categoryId !== row.categoryId || asset.categorySlug !== row.slug || seen.has(row.slug)) fail("Unapproved or duplicate category mapping");
  seen.add(row.slug);
  if(!/^\/[a-z0-9/-]+\.webp$/.test(asset.source)) fail("Unsafe source path");
  const source = resolve(FRONTEND, "public", `.${asset.source}`);
  if(!inside(resolve(FRONTEND, "public"), source)) fail("Source escapes public directory");
  const bytes = await readFile(source); const sha256 = digest(bytes);
  const dimensions = await sharp(bytes).metadata();
  const key = `categories/${row.slug}/${row.slug}-${sha256}.webp`;
  if(bytes.length !== asset.bytes || sha256 !== asset.sha256 || key !== asset.proposedKey || asset.mimeType !== "image/webp" || asset.width !== 1200 || asset.height !== 800 || dimensions.format !== "webp" || dimensions.width !== 1200 || dimensions.height !== 800 || asset.currentAtlasImage !== "") fail("Artwork checksum or manifest drift");
  results.push({slug: row.slug, id: row.categoryId, description: row.description, source, bytes, sha256, key, url: `${PUBLIC}/${key}`});
 }
 if(new Set(results.map(row => row.key)).size !== 7) fail("Duplicate destination key");
 if(Object.keys(APPROVED_IDS).some(slug => !seen.has(slug))) fail("Missing approved category");
 return results;
}

async function privateBackupPath(path: string) {
 if(!isAbsolute(path) || inside(ROOT, path) || inside(FRONTEND, path)) fail("Backup must be outside both repositories");
 const parent = await realpath(dirname(path)); const info = await lstat(parent);
 if(!info.isDirectory() || info.isSymbolicLink()) fail("Private backup directory required");
 if(process.platform === "win32") {
  const acl = execFileSync("icacls", [parent], {encoding: "utf8"});
  if(/(?:Everyone|Authenticated Users|BUILTIN\\Users):/i.test(acl)) fail("Backup directory ACL allows broad access");
 } else if((info.mode & 0o077) !== 0) fail("Backup directory must be private (0700)");
 return path;
}

function storage() {
 const accessKeyId = process.env.R2_ACCESS_KEY_ID; const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
 if(!accessKeyId || !secretAccessKey || !(process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID)) throw new Error("Missing R2 configuration");
 return new S3Client({endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: process.env.R2_REGION || "auto", forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "true", credentials: {accessKeyId, secretAccessKey}, maxAttempts: 2});
}
async function objectBytes(s3: S3Client, key: string) {const result = await s3.send(new GetObjectCommand({Bucket: BUCKET, Key: key})); return Buffer.from(await result.Body!.transformToByteArray())}
async function inspectObject(s3: S3Client, row: Artwork): Promise<"absent" | "identical"> {
 try {
  const head = await s3.send(new HeadObjectCommand({Bucket: BUCKET, Key: row.key}));
  if(head.ContentLength !== row.bytes.length || head.ContentType !== "image/webp" || head.Metadata?.sha256 !== row.sha256 || digest(await objectBytes(s3, row.key)) !== row.sha256) fail(`R2 object collision: ${row.slug}`);
  return "identical";
 } catch(error) {
  if((error as {$metadata?: {httpStatusCode?: number}}).$metadata?.httpStatusCode === 404) return "absent";
  throw error;
 }
}
async function verifyCounts(db: ReturnType<MongoClient["db"]>) {
 for(const [name, count] of Object.entries({givings: 25, events: 7, donations: 2, users: 4}))
  if(await db.collection(name).countDocuments() !== count) fail(`Unexpected ${name} count`);
}
async function main() {
 if(!["plan","apply","rollback"].includes(mode)) fail("Use plan, apply or rollback");
 if(mode !== "plan" && option("--approval") !== APPROVAL) fail("Explicit Phase 3 execution approval required");
 const uri = verifyTarget(); const artwork = await approvedArtwork();
 const backupFile = mode === "plan" ? undefined : await privateBackupPath(option("--backup") ?? fail("--backup required"));
 const client = new MongoClient(uri, {serverSelectionTimeoutMS: 10000}); const s3 = storage();
 try {
  await client.connect(); const db = client.db(DATABASE); const hello = await db.command({hello: 1});
  if(!hello.isWritablePrimary || !hello.setName) fail("Replica-set primary required");
  const categories = db.collection("givingcategories"); const flags = db.collection("migrationflags");
  const current = await categories.find({}).toArray(); if(current.length !== 7) fail("Category count drift");
  for(const row of artwork) {
   const doc = current.find(doc => String(doc._id) === row.id);
   if(!doc || doc.slug !== row.slug || doc.status !== "active") fail(`Category identity drift: ${row.slug}`);
  }
  await verifyCounts(db);
  if(mode === "plan") {
   const objects = await Promise.all(artwork.map(async row => ({slug: row.slug, r2: await inspectObject(s3, row)})));
   console.log(JSON.stringify({mode, host: HOST, database: DATABASE, categoryCount: 7, categoryPreimageSha256: digest(canonical(current)), objects, preimages: current.map(doc => ({id: String(doc._id), slug: doc.slug, imageEmpty: doc.image === "", descriptionEmpty: doc.description === ""}))}, null, 2));
   return;
  }
  if(mode === "apply") {
   if(option("--all-instances-gated") !== "verified") fail("All API instances must run the category edit gate; stop all older instances");
   const existingFlag = await flags.findOne({_id: CATEGORY_FREEZE_ID as never});
   if(existingFlag?.active && existingFlag.operation !== "category-artwork-v1") fail("Different category freeze is active");
   await flags.updateOne({_id: CATEGORY_FREEZE_ID as never}, {$set: {active: true, operation: "category-artwork-v1", updatedAt: new Date()}}, {upsert: true, writeConcern: {w: "majority"}});
   // The caller must verify that no old API instance remains and no category
   // write request is in flight before this process is allowed to proceed.
   if(option("--writers-drained") !== "verified") fail("Category writers have not been drained");
   if(!current.every(doc => doc.image === "" && doc.description === "")) fail("Category preimage drift");
   const backup = {version: 1, operation: "category-artwork-v1", host: HOST, database: DATABASE, documents: current};
   const payload = canonical(backup); const envelope = canonical({...backup, checksum: digest(payload)});
   let existingBackup: string | undefined;
   try {existingBackup = await readFile(backupFile!, "utf8")}
   catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error}
   if(existingBackup !== undefined && existingBackup !== envelope) fail("Existing private backup differs; do not overwrite");
   if(existingBackup === undefined) {
    const file = await open(backupFile!, "wx", 0o600);
    try {await file.writeFile(envelope); await file.sync()} finally {await file.close()}
   }
   const roundTrip = BSON.EJSON.parse(await readFile(backupFile!, "utf8"), {relaxed: false}) as typeof backup & {checksum: string};
   if(roundTrip.checksum !== digest(canonical(backup)) || canonical(roundTrip.documents) !== canonical(current)) fail("Backup restore verification failed");
   for(const row of artwork) {
    const state = await inspectObject(s3, row);
    if(state === "absent") await s3.send(new PutObjectCommand({Bucket: BUCKET, Key: row.key, Body: row.bytes, IfNoneMatch: "*", ContentLength: row.bytes.length, ContentType: "image/webp", CacheControl: "public, max-age=31536000, immutable", Metadata: {kind: "categories", "ownership-class": "category", "retention-policy": "retain-by-default", "entity-slug": row.slug, sha256: row.sha256}}));
    if(await inspectObject(s3, row) !== "identical") fail(`Upload verification failed: ${row.slug}`);
    const response = await fetch(row.url, {cache: "no-store"});
    if(!response.ok || digest(Buffer.from(await response.arrayBuffer())) !== row.sha256) fail(`Public URL verification failed: ${row.slug}`);
   }
   const session = client.startSession();
   try {await session.withTransaction(async () => {
    const freeze = await flags.findOne({_id: CATEGORY_FREEZE_ID as never}, {session});
    if(!freeze?.active || freeze.operation !== "category-artwork-v1") fail("Category freeze lost");
    for(const row of artwork) {
     const result = await categories.updateOne({_id: new ObjectId(row.id), slug: row.slug, image: "", description: ""}, {$set: {image: row.url, description: row.description}}, {session});
     if(result.matchedCount !== 1) fail(`Concurrent category edit: ${row.slug}`);
    }
   }, {readConcern: {level: "snapshot"}, writeConcern: {w: "majority"}})} finally {await session.endSession()}
   console.log("Applied seven category image/description updates; private backup and R2 objects retained");
  } else {
   const raw = BSON.EJSON.parse(await readFile(backupFile!, "utf8"), {relaxed: false}) as {version: number; operation: string; host: string; database: string; documents: typeof current; checksum: string};
   const {checksum, ...saved} = raw;
   if(raw.version !== 1 || raw.operation !== "category-artwork-v1" || raw.host !== HOST || raw.database !== DATABASE || raw.documents.length !== 7 || checksum !== digest(canonical(saved))) fail("Invalid backup");
   if(option("--all-instances-gated") !== "verified" || option("--writers-drained") !== "verified") fail("Category writer freeze not verified");
   await flags.updateOne({_id: CATEGORY_FREEZE_ID as never}, {$set: {active: true, operation: "category-artwork-v1", updatedAt: new Date()}}, {upsert: true, writeConcern: {w: "majority"}});
   const session = client.startSession();
   try {await session.withTransaction(async () => {
    for(const row of artwork) {
     const old = raw.documents.find(doc => String(doc._id) === row.id);
     if(!old) throw new Error("Backup category identity mismatch");
     if(old.slug !== row.slug) fail("Backup category identity mismatch");
     const result = await categories.updateOne({_id: new ObjectId(row.id), slug: row.slug, image: row.url, description: row.description}, {$set: {image: old.image, description: old.description}}, {session});
     if(result.matchedCount !== 1) fail(`Rollback conflict: ${row.slug}`);
    }
   }, {readConcern: {level: "snapshot"}, writeConcern: {w: "majority"}})} finally {await session.endSession()}
   console.log("Rolled back only seven category image/description fields; R2 objects retained");
  }
  const after = await categories.find({}).toArray();
  for(const row of artwork) {
   const original = current.find(doc => String(doc._id) === row.id)!; const updated = after.find(doc => String(doc._id) === row.id)!;
   if(!updated || updated.slug !== original.slug || (mode === "apply" && (updated.image !== row.url || updated.description !== row.description))) fail(`Post-update verification failed: ${row.slug}`);
   for(const key of Object.keys(original).filter(key => !["image", "description"].includes(key)))
    if(canonical(updated[key]) !== canonical(original[key])) fail(`Unrelated field changed: ${row.slug}.${key}`);
  }
  await verifyCounts(db);
  for(const key of ["STRIPE_CARD_ENABLED","STRIPE_ACH_ENABLED","STRIPE_FINANCIAL_CONNECTIONS_ENABLED","PAYPAL_ENABLED","PAYPAL_VENMO_ENABLED"])
   if(process.env[key] !== "false") fail("Payment flag changed");
  await flags.updateOne({_id: CATEGORY_FREEZE_ID as never, operation: "category-artwork-v1"}, {$set: {active: false, updatedAt: new Date()}}, {writeConcern: {w: "majority"}});
 } finally {s3.destroy(); await client.close()}
}
await main().catch(error => {console.error(error instanceof Error ? error.message : "Category artwork migration failed"); process.exitCode = 1});
