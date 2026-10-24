import {before, after, beforeEach, test, mock} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, stat, chmod, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MongoClient, ObjectId, Collection, ClientSession, BSON} from "mongodb";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import {dailySeva} from "../src/content/client-catalog.js";
import {DATABASE, CONFIRM_APPLY, CONFIRM_ROLLBACK, applyCatalog, rollbackCatalog} from "../scripts/lib/client-catalog-migration.js";

let replica: MongoMemoryReplSet, client: MongoClient, backupFile: string;
const ids=["6ad1021ef3748c180dd7a704","6ad1021ef3748c180dd7a705","6ad1021ef3748c180dd7a706","6ad1021ef3748c180dd7a708","6ad1021ef3748c180dd7a707","6ad1021ef3748c180dd7a709","6ad1021ef3748c180dd7a70a"];
const options=()=>({database:DATABASE,host:"127.0.0.1",confirmation:CONFIRM_APPLY,backupFile});
const rollback=()=>rollbackCatalog(client,{...options(),confirmation:CONFIRM_ROLLBACK});
const snapshot=async()=>BSON.EJSON.stringify(await client.db(DATABASE).collection("givings").find({}).sort({_id:1}).toArray());
before(async()=>{
  replica=await MongoMemoryReplSet.create({replSet:{count:1}});
  const uri=replica.getUri(); assert.match(uri,/127\.0\.0\.1/);
  client=await new MongoClient(uri).connect();
});
after(async()=>{mock.restoreAll();await client?.close();await replica?.stop();});
beforeEach(async()=>{
  mock.restoreAll();
  // Only the explicitly created disposable in-memory replica set is used.
  await client.db(DATABASE).dropDatabase();
  backupFile=join(await mkdtemp(join(tmpdir(),"catalog-migration-")),"backup.ejson");
  const db=client.db(DATABASE);
  await db.collection("givings").insertMany([
    ...dailySeva.map((row,index)=>({_id:new ObjectId(ids[index]),slug:row.slug,title:({"gold-palna-seva":"Gold Palna Seva","shayan-seva":"Shayan Seva","whole-day-manorathi":"Whole Day Manorathi"} as Record<string,string>)[row.slug]??row.title,amountType:"fixed",fixedAmountsCents:[index===4?25000:row.amount],status:"active",description:"Retain description",image:"https://example.test/retain.webp",displayOrder:40+index,createdAt:new Date("2025-01-01")})),
    {_id:new ObjectId("6ad19f2c5fbc9136a42322f8"),title:"hhngh",slug:"hhngh",status:"inactive",deletedAt:new Date()},
    {_id:new ObjectId("6ad1de89a0cdcc1647cebfec"),title:"testing",slug:"testing",status:"inactive",deletedAt:new Date()},
  ]);
  await db.collection("givings").createIndex({slug:1},{unique:true});
  for(const [name,count] of Object.entries({events:7,donations:2,users:4})) await db.collection(name).insertMany(Array.from({length:count},(_,i)=>({fixture:i,amountCents:25000})));
});
test("atomic apply, private backup, preserved other collections and duplicate-free retry",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  const db=client.db(DATABASE);
  const protectedBefore=await Promise.all(["events","donations","users"].map(async name=>BSON.EJSON.stringify(await db.collection(name).find({}).toArray())));
  assert.deepEqual(await applyCatalog(client,options()),{status:"applied",updates:7,inserts:16});
  assert.equal(await db.collection("givings").countDocuments(),25);
  const gold=await db.collection("givings").findOne({slug:"gold-palna-seva"});
  assert.equal(gold?.title,"Golden Palna Seva");assert.deepEqual(gold?.fixedAmountsCents,[25100]);
  assert.equal(gold?.description,"Retain description");assert.equal(gold?.image,"https://example.test/retain.webp");
  assert.equal((await stat(backupFile)).mode & 0o777,0o600);
  const applied=await snapshot();
  assert.equal((await applyCatalog(client,options()))?.status,"already-applied");assert.equal(await snapshot(),applied);
  assert.deepEqual(await Promise.all(["events","donations","users"].map(async name=>BSON.EJSON.stringify(await db.collection(name).find({}).toArray()))),protectedBefore);
});
test("Windows refuses migration writes when private ACL verification cannot be established",{skip:process.platform !== "win32"},async()=>{
  const before=await snapshot();
  await assert.rejects(applyCatalog(client,options()),/Backup directory must be private/);
  assert.equal(await snapshot(),before);
});test("wrong confirmation, database and host refuse writes",async()=>{
  const before=await snapshot();
  for(const change of [{confirmation:"no"},{database:"production"},{host:"other.mongodb.net"}]) await assert.rejects(applyCatalog(client,{...options(),...change}));
  assert.equal(await snapshot(),before);
});
test("current-value drift and occupied addition abort before backup",async()=>{
  const collection=client.db(DATABASE).collection("givings");
  await collection.updateOne({_id:new ObjectId(ids[0])},{$set:{fixedAmountsCents:[1]}});
  const before=await snapshot();await assert.rejects(applyCatalog(client,options()),/Unexpected amount/);assert.equal(await snapshot(),before);
  await assert.rejects(stat(backupFile),{code:"ENOENT"});
  await collection.updateOne({_id:new ObjectId(ids[0])},{$set:{fixedAmountsCents:[8400]}});
  await collection.insertOne({slug:"mahaprasad-manorathi"});
  await assert.rejects(applyCatalog(client,options()),/exactly 9/);
});
test("failure after updates aborts transaction; durable backup supports safe resume",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  const before=await snapshot();
  const failure=mock.method(Collection.prototype,"insertMany",async()=>{throw new Error("isolated injected failure");});
  await assert.rejects(applyCatalog(client,options()),/isolated injected failure/);failure.mock.restore();
  assert.equal(await snapshot(),before);assert.equal((await stat(backupFile)).mode & 0o777,0o600);
  assert.equal((await rollback())?.status,"not-applied");
  assert.equal((await applyCatalog(client,options()))?.status,"applied");
});
test("rollback restores originals exactly and retains referenced additions inactive",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  const db=client.db(DATABASE), originals=await db.collection("givings").find({}).sort({_id:1}).toArray();
  await applyCatalog(client,options());
  const added=await db.collection("givings").findOne({slug:"mahaprasad-manorathi"});assert.ok(added);
  await db.collection("donations").insertOne({fixture:"new-reference",giving:added._id,amountCents:50100});
  const donations=BSON.EJSON.stringify(await db.collection("donations").find({}).toArray());
  assert.equal((await rollback())?.status,"rolled-back");
  assert.equal(await db.collection("givings").countDocuments(),25);
  assert.equal(await db.collection("givings").countDocuments({status:"active"}),7);
  assert.deepEqual(await db.collection("givings").find({_id:{$in:originals.map(row=>row._id)}}).sort({_id:1}).toArray(),originals);
  assert.equal(BSON.EJSON.stringify(await db.collection("donations").find({}).toArray()),donations);
  assert.equal((await rollback())?.status,"already-rolled-back");
  await assert.rejects(applyCatalog(client,options()),/partial\/unknown state/);
});
test("post-apply catalog edits block rollback; missing or insecure backup refuses writes",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  await assert.rejects(rollback(),/backup is required/);
  await applyCatalog(client,options());
  await client.db(DATABASE).collection("givings").updateOne({slug:"mangla-seva"},{$set:{description:"New admin edit"}});
  const before=await snapshot();await assert.rejects(rollback(),/post-migration edits/);assert.equal(await snapshot(),before);
  await chmod(backupFile,0o644);await assert.rejects(rollback(),/private file/);assert.equal(await snapshot(),before);
});
test("unsafe backup directory fails closed",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  await chmod(join(backupFile,".."),0o755);
  const before=await snapshot();await assert.rejects(applyCatalog(client,options()),/directory must be private/);assert.equal(await snapshot(),before);
});
test("missing unique Giving slug index fails before migration",async()=>{
  await client.db(DATABASE).collection("givings").dropIndex("slug_1");
  const before=await snapshot();
  await assert.rejects(applyCatalog(client,options()),/unique Giving slug index/);
  assert.equal(await snapshot(),before);
});
test("lost commit acknowledgement recovers without duplicate writes",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  const original=ClientSession.prototype.withTransaction;
  const failure=mock.method(ClientSession.prototype,"withTransaction",async function(this:ClientSession,...args:Parameters<typeof original>){
    await original.apply(this,args);throw new Error("isolated lost acknowledgement");
  });
  await assert.rejects(applyCatalog(client,options()),/lost acknowledgement/);failure.mock.restore();
  assert.equal(await client.db(DATABASE).collection("givings").countDocuments(),25);
  const before=await snapshot();assert.equal((await applyCatalog(client,options()))?.status,"already-applied");assert.equal(await snapshot(),before);
});
test("corrupt manifest and protected collection drift refuse writes",{skip:process.platform === "win32" && "POSIX private-mode migration fixture is not portable to Windows ACLs"},async()=>{
  await client.db(DATABASE).collection("events").insertOne({fixture:"drift"});
  const initial=await snapshot();await assert.rejects(applyCatalog(client,options()),/Unexpected events count/);assert.equal(await snapshot(),initial);
  await client.db(DATABASE).collection("events").deleteOne({fixture:"drift"});
  await applyCatalog(client,options());
  const payload=JSON.parse(await readFile(backupFile,"utf8"));payload.checksum="corrupted";
  await writeFile(backupFile,JSON.stringify(payload));
  const before=await snapshot();await assert.rejects(rollback(),/checksum mismatch/);assert.equal(await snapshot(),before);
});
