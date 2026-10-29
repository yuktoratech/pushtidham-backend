import {before, after, beforeEach, test, mock} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import mongoose, {Types} from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import request from "supertest";
import {PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream} from "pdf-lib";
import {Donation} from "../src/models/donation.js";
import {DonationCorrection} from "../src/models/donation-correction.js";
import {DonationReceipt} from "../src/models/donation-receipt.js";
import {Giving} from "../src/models/giving.js";
import {User} from "../src/models/user.js";
import {Event} from "../src/models/event.js";
import {OfflineDonationCorrectionService} from "../src/services/offline-donation-corrections.js";
import {DonationService} from "../src/services/donations.js";
import {ReceiptService} from "../src/services/receipts.js";
import {FinancialReportService} from "../src/services/financial-reports.js";
import {AuthService} from "../src/services/auth.js";
import {AppError} from "../src/utils/errors.js";
import {offlineEditBody, donationQuery} from "../src/validators/donation.js";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";

const actor = new Types.ObjectId(), owner = new Types.ObjectId(), nextOwner = new Types.ObjectId();
const at = new Date("2026-10-01T12:00:00.000Z");
const service = new OfflineDonationCorrectionService(), receipts = new ReceiptService();
const config = loadConfig({NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1/unused", FRONTEND_URL: "http://localhost:3000", JWT_ACCESS_SECRET: randomBytes(40).toString("hex"), JWT_REFRESH_SECRET: randomBytes(40).toString("hex")});
const app = createApp(config);
let replica: MongoMemoryReplSet, giving: string, fixed: string, other: string, id: string;
before(async () => {
 replica = await MongoMemoryReplSet.create({replSet: {count: 1}});
 assert.ok(replica.getUri().startsWith("mongodb://127.0.0.1:"));
 await mongoose.connect(replica.getUri(), {dbName: "isolated_offline_corrections"});
 await Promise.all([Donation.init(), DonationCorrection.init(), DonationReceipt.init(), User.init(), Giving.init(), Event.init()]);
 mock.method(AuthService.prototype, "authenticate", async (token: string) => {
  if (token === "admin-fixture") return {id: actor, role: "admin" as const, sessionId: "fixture"};
  if (token === "donor-fixture") return {id: owner, role: "donor" as const, sessionId: "fixture"};
  if (token === "new-donor-fixture") return {id: nextOwner, role: "donor" as const, sessionId: "fixture"};
  throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
 });
});
after(async () => {mock.restoreAll(); await mongoose.disconnect(); await replica?.stop()});
beforeEach(async () => {
 // Raw collection cleanup is restricted to this isolated fixture database; application APIs are append-only.
 for (const model of [Donation, DonationCorrection, DonationReceipt, User, Giving, Event]) await model.collection.deleteMany({});
 await User.create([{_id: owner, name: "Original Donor", email: "original@example.test", passwordHash: "fixture", role: "donor"}, {_id: nextOwner, name: "Correct Donor", email: "correct@example.test", passwordHash: "fixture", role: "donor"}]);
 giving = String((await Giving.create({title: "Custom Support", slug: "custom-support", amountType: "custom"}))._id);
 fixed = String((await Giving.create({title: "Fixed Support", slug: "fixed-support", amountType: "fixed", fixedAmountsCents: [50100]}))._id);
 other = String((await Giving.create({title: "Other", slug: "other", amountType: "custom"}))._id);
 id = String((await Donation.create({donationNumber: "OFFLINE-EDIT-FIXTURE", user: owner, donorName: "Original Donor", donorEmail: "original@example.test", type: "general", giving, designationTitle: "Custom Support", amountCents: 2500, currency: "USD", paymentMethod: "offline", source: "offline", offlinePaymentMethod: "cash", status: "pending", donationDate: at, receiptHistoryTracked: true}))._id);
});
const input = (overrides: Record<string, unknown> = {}) => offlineEditBody.parse({expectedVersion: 0, reason: "Correct entry", donorId: String(owner), donorName: "Original Donor", donorEmail: "original@example.test", donorPhone: "", type: "general", giving, amountCents: 3000, donationPurpose: "", donationDate: at.toISOString(), offlinePaymentMethod: "cash", offlineReference: "", adminNote: "", ...overrides});
const rejectCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
async function completed(tracked = true) {await Donation.updateOne({_id: id}, {$set: {status: "completed", verifiedBy: actor, verifiedAt: at, completedAt: at, receiptHistoryTracked: tracked}})}
function pdfText(bytes: Uint8Array) {return PDFDocument.load(bytes).then(pdf => pdf.getPages().map(page => {const contents = page.node.Contents(); if (!(contents instanceof PDFArray)) return ""; let text = ""; for (let i=0;i<contents.size();i++) {const stream=pdf.context.lookup(contents.get(i)); if(stream instanceof PDFRawStream) for(const match of Buffer.from(decodePDFRawStream(stream).decode()).toString().matchAll(/<([0-9a-f]+)>\s*Tj/gi)) text += Buffer.from(match[1]!, "hex").toString("latin1") + "\n";} return text;}).join("\n"));}

test("Pending and Rejected corrections retain identity, original timestamp and status; reason and before/after audit are recorded", async () => {
 for (const status of ["pending", "rejected"] as const) {
  await Donation.updateOne({_id: id}, {$set: {status}});const before = await Donation.findById(id).lean();
  const version = before!.correctionVersion;
  await service.edit(id, input({expectedVersion: version, amountCents: status === "pending" ? 3000 : 3500}), actor, "correction-" + status);
  const row = await Donation.findById(id).lean(); assert.equal(row!.status, status); assert.equal(row!.donationNumber, before!.donationNumber);assert.deepEqual(row!.createdAt, before!.createdAt);
  const audit = await DonationCorrection.findOne({donation: id, version: version+1}).lean();assert.equal(audit!.reason, "Correct entry");assert.equal(String(audit!.actor), String(actor)); assert.equal((audit!.changes as Record<string,{before:number}>).amountCents!.before, before!.amountCents);
  await assert.rejects(receipts.create(id), rejectCode("RECEIPT_NOT_ELIGIBLE"));
 }
});
test("blank reason, no-op, amount bounds, precision and injected status/actor are rejected", async () => {
 assert.equal(offlineEditBody.safeParse({...input(), reason: "   "}).success, false);
 for (const extra of [{status:"completed"}, {actor:String(nextOwner)}, {amountCents:1000001}, {amountCents:100.1}]) assert.equal(offlineEditBody.safeParse({...input(),...extra}).success, false);
 await assert.rejects(service.edit(id,input({amountCents:2500}),actor,"no-op-correction"),rejectCode("NO_CORRECTION_CHANGES"));assert.equal(await DonationCorrection.countDocuments(),0);
});
test("online donations remain read-only and financial lifecycle records are untouched", async () => {
 await Donation.updateOne({_id:id},{$set:{source:"online",paymentMethod:"card"}});
 await assert.rejects(service.edit(id,input(),actor,"online-correction"),rejectCode("OFFLINE_EDIT_ONLY"));assert.equal(await DonationCorrection.countDocuments(),0);
});
test("fixed/custom rules, Other purpose and historical Event designation are authoritative", async () => {
 await assert.rejects(service.edit(id,input({giving:fixed,amountCents:2500}),actor,"fixed-invalid-amount"),rejectCode("INVALID_AMOUNT"));
 await assert.rejects(service.edit(id,input({giving:other}),actor,"other-invalid-purpose"),rejectCode("DONATION_PURPOSE_REQUIRED"));
 await service.edit(id,input({giving:other,amountCents:100,donationPurpose:"Library"}),actor,"other-valid-purpose");
 assert.equal((await Donation.findById(id))!.donationPurpose,"Library");
 const event=await Event.create({title:"Past Event",slug:"past-event",startsAt:at,location:"Temple",status:"inactive"});
 await service.edit(id,input({expectedVersion:1,giving:undefined,event:String(event._id),type:"event",amountCents:1000000}),actor,"historical-event-edit");
 const row=await Donation.findById(id);assert.equal(String(row!.event),String(event._id));assert.equal(row!.giving,undefined);assert.equal(row!.designationTitle,"Past Event");
});
test("donor reassignment needs confirmation, changes ownership and prevents previous donor receipt/history access", async () => {
 await completed();await receipts.create(id,owner);
 await assert.rejects(service.edit(id,input({donorId:String(nextOwner)}),actor,"reassign-unconfirmed"),rejectCode("DONOR_CONFIRMATION_REQUIRED"));
 await service.edit(id,input({donorId:String(nextOwner),confirmDonorReassignment:true,donorName:"Spoof",donorEmail:"spoof@example.test"}),actor,"reassign-confirmed");
 const row=await Donation.findById(id);assert.equal(String(row!.user),String(nextOwner));assert.equal(row!.donorName,"Correct Donor");assert.equal(row!.donorEmail,"correct@example.test");
 const audit=await DonationCorrection.findOne({donation:id});assert.deepEqual(audit!.changes.user,{before:String(owner),after:String(nextOwner)});
 const donations=new DonationService();assert.equal((await donations.list(donationQuery.parse({}),owner)).data.length,0);assert.equal((await donations.list(donationQuery.parse({}),nextOwner)).data.length,1);
 await assert.rejects(receipts.create(id,owner));assert.ok((await receipts.create(id,nextOwner)).bytes.length>0);assert.equal(await User.countDocuments(),2);
});
test("disabled/admin donor targets are rejected without detaching ownership",async()=>{
 await User.updateOne({_id:nextOwner},{$set:{status:"disabled"}});
 await assert.rejects(service.edit(id,input({donorId:String(nextOwner),confirmDonorReassignment:true}),actor,"disabled-donor-edit"));
 await assert.rejects(service.edit(id,input({donorId:null,confirmDonorReassignment:true}),actor,"detached-donor-edit"),rejectCode("DONOR_CONFIRMATION_REQUIRED"));assert.equal(String((await Donation.findById(id))!.user),String(owner));
});
test("duplicate concurrent requests append one audit; changed key payload and stale versions conflict", async()=>{
 const results=await Promise.all([service.edit(id,input(),actor,"same-correction-key"),service.edit(id,input(),actor,"same-correction-key")]);assert.equal(results[0]!.version,results[1]!.version);assert.equal(await DonationCorrection.countDocuments(),1);
 await assert.rejects(service.edit(id,input({amountCents:3500}),actor,"same-correction-key"),rejectCode("IDEMPOTENCY_CONFLICT"));
 await assert.rejects(service.edit(id,input(),actor,"different-edit-key"),rejectCode("CORRECTION_CONFLICT"));
});
test("distinct concurrent corrections cannot lose an edit",async()=>{
 const result=await Promise.allSettled([service.edit(id,input(),actor,"concurrent-edit-one"),service.edit(id,input({amountCents:3500}),actor,"concurrent-edit-two")]);assert.equal(result.filter(row=>row.status==="fulfilled").length,1);assert.equal(await DonationCorrection.countDocuments(),1);assert.equal((await Donation.findById(id))!.correctionVersion,1);
});
test("completed correction preserves exact original PDF bytes and appends a corrected version",async()=>{
 await completed();const before=await receipts.create(id,owner);await service.edit(id,input(),actor,"completed-edit-key");
 const latest=await receipts.create(id,owner),old=await receipts.archived(id,1);assert.deepEqual(old.bytes,before.bytes);assert.notDeepEqual(latest.bytes,before.bytes);assert.match(latest.filename,/-r2-corrected.pdf$/);assert.match(old.filename,/-r1-superseded.pdf$/);
 assert.match(await pdfText(latest.bytes),/Corrected receipt - revision 2/);assert.match(await pdfText(latest.bytes),/\$30\.00/);
 const history=await service.history(id);assert.equal(history.receipts.length,2);assert.equal(history.receipts.find(row=>row.revision===1)!.superseded,true);assert.equal(await Donation.countDocuments(),1);
 await service.edit(id,input(),actor,"completed-edit-key");assert.equal(await DonationReceipt.countDocuments(),2);
});
test("unarchived historical completed receipts block financial correction, but permit internal notes",async()=>{
 await completed(false);await Donation.updateOne({_id:id},{$unset:{offlinePaymentMethod:""}});await assert.rejects(service.edit(id,input(),actor,"historical-financial"),rejectCode("HISTORICAL_RECEIPT_UNAVAILABLE"));
 await service.edit(id,input({amountCents:2500,adminNote:"Follow up",offlinePaymentMethod:undefined}),actor,"historical-notes-edit");assert.equal((await Donation.findById(id))!.amountCents,2500);assert.equal(await DonationReceipt.countDocuments(),0);
});
test("receipt rendering failure rolls back donation, original snapshot and audit together",async()=>{
 await completed();await assert.rejects(service.edit(id,input({donationPurpose:"Unsupported \u{1F64F}"}),actor,"atomic-failure-edit"),rejectCode("RECEIPT_FONT_UNSUPPORTED"));
 assert.equal((await Donation.findById(id))!.amountCents,2500);assert.equal(await DonationCorrection.countDocuments(),0);assert.equal(await DonationReceipt.countDocuments(),0);
});
test("audit and receipt snapshots have no mutable application operations",async()=>{
 await completed();await service.edit(id,input(),actor,"immutable-edit-key");
 await assert.rejects(DonationCorrection.updateOne({donation:id},{$set:{reason:"Overwrite"}}),/append-only/);await assert.rejects(DonationCorrection.deleteMany({donation:id}),/append-only/);await assert.rejects(DonationReceipt.deleteMany({donation:id}),/immutable/);
});
test("corrected amounts and dates update reports and escaped CSV without double counting",async()=>{
 await completed();await service.edit(id,input({donationDate:"2026-09-01T12:00:00Z",donationPurpose:"=Formula, \"quoted\""}),actor,"reports-correction");
 const report=await new FinancialReportService().summary({from:"2026-09-01T00:00:00Z",to:"2026-09-02T00:00:00Z"});assert.equal(report.summary.confirmedRecords,1);assert.equal(report.summary.confirmedBaseCents,3000);
 const response=await request(app).get('/api/v1/admin/donations/export.csv').set('Authorization','Bearer admin-fixture');assert.equal(response.status,200);assert.match(response.text,/'=Formula/);assert.match(response.text,/30.00/);
 const history=await service.history(id);assert.equal(history.entries.length,1);
});
test("editing, audit and receipt archives require admin and reject client-controlled immutable fields",async()=>{
 const endpoint='/api/v1/admin/donations/'+id;
 for(const suffix of ['/offline','/corrections','/receipts/1']){
  const call=suffix==='/offline'?request(app).patch(endpoint+suffix).send(input()):request(app).get(endpoint+suffix);assert.equal((await call).status,401);
  const donorCall=suffix==='/offline'?request(app).patch(endpoint+suffix).send(input()):request(app).get(endpoint+suffix);assert.equal((await donorCall.set('Authorization','Bearer donor-fixture')).status,403);
 }
 const forged=await request(app).patch(endpoint+'/offline').set('Authorization','Bearer admin-fixture').set('Idempotency-Key','http-correction-key').send({...input(),actor:String(nextOwner)});assert.equal(forged.status,400);
 const response=await request(app).patch(endpoint+'/offline').set('Authorization','Bearer admin-fixture').set('Idempotency-Key','http-correction-key').send(input());assert.equal(response.status,200);assert.equal(String((await DonationCorrection.findOne({donation:id}))!.actor),String(actor));
});

 test("receipt issuance and a concurrent correction serialize without losing original snapshots", async()=>{
  await completed();
  await Promise.all([receipts.create(id,owner),service.edit(id,input(),actor,"receipt-race-correction")]);
  assert.equal(await DonationReceipt.countDocuments(),2);assert.equal((await Donation.findById(id))!.receiptRevision,2);
  assert.match(await pdfText((await receipts.archived(id,1)).bytes),/\$25\.00/);
  assert.match(await pdfText((await receipts.create(id,owner)).bytes),/\$30\.00/);
 });
 test("admin archives are explicitly superseded and no audit content leaks into donor views", async()=>{
  await completed();await service.edit(id,input({reason:"Private correction reason"}),actor,"archive-route-edit");
  const old=await request(app).get('/api/v1/admin/donations/'+id+'/receipts/1').set('Authorization','Bearer admin-fixture');assert.equal(old.status,200);assert.match(String(old.headers['content-disposition']),/superseded/);assert.equal(old.headers['cache-control'],'no-store');
  const donor=await request(app).get('/api/v1/donations/'+id).set('Authorization','Bearer donor-fixture');assert.equal(donor.status,200);assert.ok(!JSON.stringify(donor.body).includes('Private correction reason'));assert.equal(donor.body.data.adminNote,undefined);
 });

test("historical Pending correction establishes safe tracking and separate verification advances the edit version",async()=>{
 await Donation.updateOne({_id:id},{$unset:{receiptHistoryTracked:""}});
 await service.edit(id,input(),actor,"pending-history-edit");assert.equal((await Donation.findById(id))!.receiptHistoryTracked,true);assert.equal(await DonationReceipt.countDocuments(),0);
 await new DonationService().status(id,{status:"completed"},actor);assert.equal((await Donation.findById(id))!.correctionVersion,2);
 await assert.rejects(service.edit(id,input({expectedVersion:1,amountCents:3500}),actor,"stale-status-version"),rejectCode("CORRECTION_CONFLICT"));
 await service.edit(id,input({expectedVersion:2,amountCents:3500}),actor,"verified-history-edit");assert.equal(await DonationReceipt.countDocuments(),2);
});
test("audit insertion failure rolls back a completed correction and both receipt revisions",async()=>{
 await completed();const stub=mock.method(DonationCorrection,"create",async()=>{throw new Error("Isolated audit insertion failure")});
 try {await assert.rejects(service.edit(id,input(),actor,"audit-failure-edit"),/Isolated audit insertion failure/)}finally{stub.mock.restore()}
 assert.equal((await Donation.findById(id))!.amountCents,2500);assert.equal(await DonationReceipt.countDocuments(),0);assert.equal(await DonationCorrection.countDocuments(),0);
});
