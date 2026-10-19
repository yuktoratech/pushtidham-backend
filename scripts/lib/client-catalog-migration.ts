import {createHash} from "node:crypto";
import {mkdir, lstat, open, readFile} from "node:fs/promises";
import {dirname} from "node:path";
import {MongoClient, ObjectId, BSON, type Document, type Db, type ClientSession} from "mongodb";
import {buildClientCatalogPlan, dailySeva, type CatalogPlanRecord} from "../../src/content/client-catalog.js";

export const DATABASE = "pushtidham_payment_sandbox";
export const MIGRATION = "client-catalog-2026-10-19-v1";
export const CONFIRM_APPLY = `APPLY_${MIGRATION}_TO_${DATABASE}`;
export const CONFIRM_ROLLBACK = `ROLLBACK_${MIGRATION}_IN_${DATABASE}`;
const ids = ["6ad1021ef3748c180dd7a704", "6ad1021ef3748c180dd7a705", "6ad1021ef3748c180dd7a706", "6ad1021ef3748c180dd7a708", "6ad1021ef3748c180dd7a707", "6ad1021ef3748c180dd7a709", "6ad1021ef3748c180dd7a70a"];
const retainedIds = ["6ad19f2c5fbc9136a42322f8", "6ad1de89a0cdcc1647cebfec"];
const baselineCounts = {events: 7, donations: 2, users: 4, paymentattempts: 0, paymentadjustments: 0, webhookevents: 0};
type Proposed = ReturnType<typeof buildClientCatalogPlan>[number]["proposed"];
export type MigrationOptions = {database: string; host: string; confirmation: string; backupFile: string};
type Manifest = {
  migration: string; database: string; host: string; planHash: string; createdAt: Date;
  originals: Document[]; retained: Document[]; additions: Document[];
  updates: Array<{id: string; proposed: Proposed}>;
  checksum: string;
};
export class MigrationError extends Error {}
const requireCondition: (value: unknown, message: string) => asserts value = (value, message) => {if (!value) throw new MigrationError(message);};
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,sort(v)])) : v;
  return JSON.stringify(sort(JSON.parse(BSON.EJSON.stringify(value, {relaxed: false}))));
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const asPlanRecords = (rows: Document[]) => rows as unknown as CatalogPlanRecord[];
function proposedPlan() {
  return buildClientCatalogPlan(dailySeva.map((row, index) => ({_id: ids[index]!, slug: row.slug, title: oldTitle(row.slug, row.title), amountType: "fixed", fixedAmountsCents: [row.slug === "gold-palna-seva" ? 25000 : row.amount], status: "active"})));
}
function oldTitle(slug: string, fallback: string) {
  return ({"gold-palna-seva": "Gold Palna Seva", "shayan-seva": "Shayan Seva", "whole-day-manorathi": "Whole Day Manorathi"} as Record<string,string>)[slug] ?? fallback;
}
const planHash = digest(proposedPlan().map(row => ({id: row.id, proposed: row.proposed})));

function verifyBaseline(rows: Document[]) {
  requireCondition(rows.length === 9, "Expected exactly 9 Giving records before apply");
  for (const [index, expected] of dailySeva.entries()) {
    const row = rows.find(row => String(row._id) === ids[index]);
    requireCondition(row && row.slug === expected.slug, `Existing ID/slug mismatch: ${expected.slug}`);
    requireCondition(row.title === oldTitle(expected.slug, expected.title) && row.amountType === "fixed" && row.status === "active" && !row.deletedAt, `Unexpected current values: ${expected.slug}`);
    requireCondition(same(row.fixedAmountsCents, [expected.slug === "gold-palna-seva" ? 25000 : expected.amount]), `Unexpected amount: ${expected.slug}`);
    requireCondition(!Object.hasOwn(row, "category") && !Object.hasOwn(row, "festivalGroup"), `Unexpected pre-migration classification: ${expected.slug}`);
  }
  for (const [index, id] of retainedIds.entries()) {
    const row = rows.find(row => String(row._id) === id);
    requireCondition(row && row.slug === (index === 0 ? "hhngh" : "testing") && row.status === "inactive" && row.deletedAt, "Unexpected retained Giving record");
  }
  const plan = buildClientCatalogPlan(asPlanRecords(rows));
  requireCondition(plan.filter(row => row.action === "create").length === 16 && plan.filter(row => row.action === "update").length === 7, "Expected 7 updates and 16 absent additions");
  requireCondition(digest(plan.map(row => ({id: row.id, proposed: row.proposed}))) === planHash, "Catalog plan differs from approved migration");
  return plan;
}

async function verifyCounts(db: Db, session?: ClientSession) {
  for (const [collection, expected] of Object.entries(baselineCounts)) {
    requireCondition(await db.collection(collection).countDocuments({}, {session}) === expected, `Unexpected ${collection} count; review a new plan`);
  }
}
async function verifyTarget(client: MongoClient, options: MigrationOptions, mode: "apply" | "rollback") {
  requireCondition(options.database === DATABASE, "Wrong database confirmation");
  requireCondition(options.confirmation === (mode === "apply" ? CONFIRM_APPLY : CONFIRM_ROLLBACK), "Explicit execution confirmation is missing or incorrect");
  const actualHost = client.options.srvHost ?? client.options.hosts[0]?.host;
  requireCondition(actualHost === options.host, "Connection host differs from confirmed host");
  const hello = await client.db("admin").command({hello: 1});
  requireCondition((hello.setName || hello.msg === "isdbgrid") && hello.logicalSessionTimeoutMinutes != null, "Transactions required; standalone MongoDB is not supported");
  const indexes = await client.db(DATABASE).collection("givings").indexes();
  requireCondition(indexes.some(index => index.unique && same(index.key, {slug: 1})), "Existing unique Giving slug index is required");
}

async function readManifest(file: string): Promise<Manifest | undefined> {
  let info;
  try {info = await lstat(file);} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;}
  requireCondition(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, "Backup must be a regular private file (0600)");
  const parent = await lstat(dirname(file));
  requireCondition(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, "Backup directory must be private (0700), without symlinks");
  if (process.getuid) requireCondition(info.uid === process.getuid(), "Backup belongs to another user");
  const manifest = BSON.EJSON.parse(await readFile(file, "utf8"), {relaxed: false}) as Manifest;
  const {checksum, ...payload} = manifest;
  requireCondition(checksum === digest(payload), "Backup checksum mismatch");
  requireCondition(manifest.migration === MIGRATION && manifest.database === DATABASE && manifest.planHash === planHash, "Backup migration/plan mismatch");
  requireCondition(manifest.createdAt instanceof Date && Number.isFinite(manifest.createdAt.getTime()), "Invalid backup timestamp");
  requireCondition(Array.isArray(manifest.originals) && Array.isArray(manifest.retained) && Array.isArray(manifest.additions), "Invalid backup records");
  verifyBaseline([...manifest.originals, ...manifest.retained]);
  requireCondition(manifest.originals.length === 7 && manifest.retained.length === 2 && manifest.additions.length === 16, "Invalid backup record counts");
  requireCondition(same(manifest.updates, proposedPlan().filter(row => row.id).map(row => ({id: row.id!, proposed: row.proposed}))), "Backup updates differ from approved plan");
  const expectedAdditions = proposedPlan().filter(row => !row.id).map(row => row.proposed);
  for (const [index, row] of manifest.additions.entries()) {
    requireCondition(row._id instanceof ObjectId && !ids.includes(String(row._id)) && !retainedIds.includes(String(row._id)), "Invalid inserted ID in backup");
    requireCondition(same(row, {...expectedAdditions[index], _id: row._id, description: "", image: "", createdAt: manifest.createdAt, updatedAt: manifest.createdAt}), "Backup addition differs from approved plan");
  }
  requireCondition(new Set(manifest.additions.map(row => String(row._id))).size === 16, "Duplicate inserted IDs in backup");
  return manifest;
}

async function durableBackup(file: string, payload: Omit<Manifest,"checksum">) {
  const directory = dirname(file);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, "Backup directory must be private (0700), without symlinks");
  const manifest: Manifest = {...payload, checksum: digest(payload)};
  const handle = await open(file, "wx", 0o600); // Never overwrite an existing backup.
  try {await handle.writeFile(BSON.EJSON.stringify(manifest, {relaxed: false})); await handle.sync();} finally {await handle.close();}
  const parent = await open(directory, "r");
  try {await parent.sync();} finally {await parent.close();}
  return manifest;
}
function appliedRows(manifest: Manifest) {
  return [...manifest.originals.map(original => ({...original, ...manifest.updates.find(update => update.id === String(original._id))!.proposed})), ...manifest.retained, ...manifest.additions];
}
function matches(rows: Document[], expected: Document[]) {
  return rows.length === expected.length && expected.every(doc => rows.some(row => same(row, doc)));
}
const rolledBackRows = (manifest: Manifest) => [...manifest.originals, ...manifest.retained, ...manifest.additions.map(row => ({...row,status:"inactive"}))];
const transactionOptions = {readConcern: {level: "snapshot" as const}, writeConcern: {w: "majority" as const}, readPreference: "primary" as const, maxCommitTimeMS: 30000};

export async function applyCatalog(client: MongoClient, options: MigrationOptions) {
  await verifyTarget(client, options, "apply");
  const db = client.db(DATABASE);
  let manifest = await readManifest(options.backupFile);
  if (!manifest) {
    const rows = await db.collection("givings").find({}).toArray();
    const plan = verifyBaseline(rows);
    await verifyCounts(db);
    const now = new Date();
    manifest = await durableBackup(options.backupFile, {
      migration: MIGRATION, database: DATABASE, host: options.host, planHash, createdAt: now,
      originals: ids.map(id => rows.find(row => String(row._id) === id)!),
      retained: retainedIds.map(id => rows.find(row => String(row._id) === id)!),
      updates: plan.filter(row => row.id).map(row => ({id: row.id!,proposed:row.proposed})),
      additions: plan.filter(row => !row.id).map(row => ({...row.proposed,_id:new ObjectId(),description:"",image:"",createdAt:now,updatedAt:now})),
    });
  }
  requireCondition(manifest.host === options.host, "Backup target host mismatch");
  const saved = manifest;
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const rows = await db.collection("givings").find({}, {session}).toArray();
      if (matches(rows, appliedRows(saved))) return {status:"already-applied", updates:0, inserts:0};
      requireCondition(matches(rows,[...saved.originals,...saved.retained]), "Catalog changed or was rolled back; refusing partial/unknown state");
      verifyBaseline(rows);
      await verifyCounts(db,session);
      for (const update of saved.updates) {
        const result = await db.collection("givings").updateOne({_id:new ObjectId(update.id)},{$set:update.proposed},{session});
        requireCondition(result.matchedCount === 1,"Existing record disappeared during transaction");
      }
      await db.collection("givings").insertMany(saved.additions,{session});
      requireCondition(await db.collection("givings").countDocuments({}, {session}) === 25,"Unexpected final Giving count");
      await verifyCounts(db,session);
      return {status:"applied",updates:7,inserts:16};
    },transactionOptions);
  } finally {await session.endSession();}
}

export async function rollbackCatalog(client: MongoClient, options: MigrationOptions) {
  await verifyTarget(client,options,"rollback");
  const manifest = await readManifest(options.backupFile);
  requireCondition(manifest && manifest.host === options.host,"Matching durable backup is required for rollback");
  const db = client.db(DATABASE), session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const rows = await db.collection("givings").find({}, {session}).toArray();
      if (matches(rows,rolledBackRows(manifest))) return {status:"already-rolled-back",restored:0,deactivated:0};
      if (matches(rows,[...manifest.originals,...manifest.retained])) return {status:"not-applied",restored:0,deactivated:0};
      requireCondition(matches(rows,appliedRows(manifest)),"Catalog has post-migration edits; refusing to overwrite them");
      for (const original of manifest.originals) {
        const result = await db.collection("givings").replaceOne({_id:original._id},original,{session});
        requireCondition(result.matchedCount === 1,"Original record disappeared during rollback");
      }
      // Never delete added records: references can be created concurrently, and
      // MongoDB offers no foreign-key lock. Deactivation protects every reference.
      await db.collection("givings").updateMany({_id:{$in:manifest.additions.map(row=>row._id)}},{$set:{status:"inactive"}},{session});
      requireCondition(matches(await db.collection("givings").find({}, {session}).toArray(),rolledBackRows(manifest)),"Rollback verification failed");
      return {status:"rolled-back",restored:7,deactivated:16};
    },transactionOptions);
  } finally {await session.endSession();}
}
