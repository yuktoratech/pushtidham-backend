import {after, before, beforeEach, test, mock} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import mongoose, {Types} from "mongoose";
import bcrypt from "bcrypt";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import request from "supertest";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";
import {AuthService} from "../src/services/auth.js";
import {DonationService} from "../src/services/donations.js";
import {OfflineDonationService} from "../src/services/offline-donations.js";
import {User} from "../src/models/user.js";
import {Giving} from "../src/models/giving.js";
import {GivingCategory} from "../src/models/giving-category.js";
import {Event} from "../src/models/event.js";
import {Donation} from "../src/models/donation.js";
import {Session} from "../src/models/session.js";
import {AppError} from "../src/utils/errors.js";
import type {Mail} from "../src/services/mail.js";
import {offlineBody} from "../src/validators/donation.js";
import {ReceiptService} from "../src/services/receipts.js";

const config=loadConfig({NODE_ENV:"test",MONGODB_URI:"mongodb://127.0.0.1/unused",FRONTEND_URL:"http://localhost:3000",JWT_ACCESS_SECRET:randomBytes(40).toString("hex"),JWT_REFRESH_SECRET:randomBytes(40).toString("hex")});
const admin=new Types.ObjectId(),owner=new Types.ObjectId();
let replica:MongoMemoryReplSet;
let fixed:string,custom:string,mixed:string,festival:string,category:string,festivalCategory:string;
let sent:Mail[],failMail:boolean;
let service:OfflineDonationService;
let auth:AuthService;
const body=(overrides:Record<string,unknown>={})=>offlineBody.parse({donorName:"Test Donor",donorEmail:"new@example.test",type:"general",giving:custom,categoryId:category,amountCents:2500,currency:"USD",donationPurpose:"Temple library",status:"completed",offlinePaymentMethod:"cash",...overrides});
const mail={send:async(message:Mail)=>{assert.equal(await Donation.countDocuments(),1,"email must follow donation commit");if(failMail)throw new Error("mock delivery failure");sent.push(message)}};

before(async()=>{
 replica=await MongoMemoryReplSet.create({replSet:{count:1}});
 assert.match(replica.getUri(),/^mongodb:\/\/127\.0\.0\.1:/);
 await mongoose.connect(replica.getUri(),{dbName:"isolated_offline_donation_test"});
 await Promise.all([User.init(),Giving.init(),GivingCategory.init(),Donation.init(),Event.init(),Session.init()]);
 mock.method(AuthService.prototype,"authenticate",async(token:string)=>{
  if(token==="admin-fixture")return{id:admin,role:"admin" as const,sessionId:"fixture"};
  if(token==="donor-fixture")return{id:owner,role:"donor" as const,sessionId:"fixture"};
  throw new AppError(401,"UNAUTHENTICATED","Authentication required");
 });
});
after(async()=>{mock.restoreAll();await mongoose.disconnect();await replica?.stop()});
beforeEach(async()=>{
 await Promise.all([User.deleteMany({}),Giving.deleteMany({}),GivingCategory.deleteMany({}),Donation.deleteMany({}),Event.deleteMany({}),Session.deleteMany({})]);
 category=String((await GivingCategory.create({name:"General Donation",slug:"general-donation"}))._id);
 festivalCategory=String((await GivingCategory.create({name:"Dolotsav",slug:"dolotsav"}))._id);
 custom=String((await Giving.create({title:"Other",slug:"other",categoryId:category,amountType:"custom"}))._id);
 fixed=String((await Giving.create({title:"Fixed",slug:"fixed",categoryId:category,amountType:"fixed",fixedAmountsCents:[50100]}))._id);
 mixed=String((await Giving.create({title:"Mixed",slug:"mixed",categoryId:category,amountType:"fixed_and_custom",fixedAmountsCents:[5100]}))._id);
 festival=String((await Giving.create({title:"Mukhya Manorathi",slug:"utsav-option",categoryId:festivalCategory,category:"utsav",festivalGroup:"dolotsav",amountType:"fixed",fixedAmountsCents:[100100]}))._id);
 sent=[];failMail=false;auth=new AuthService(config);service=new OfflineDonationService(new DonationService(),auth,mail,config.FRONTEND_URL);
});

test("new donor and offline donation commit atomically; random password stays hashed and unverified",async()=>{
 const result=await service.create(body(),admin,"new-offline-donation-0001");
 const user=await User.findById(result.donor.id).select("+passwordHash");
 assert.ok(user);assert.match(user.passwordHash,/^\$2[ab]\$/);assert.equal(user.passwordSetupRequired,true);assert.equal(user.emailVerifiedAt,undefined);
 assert.equal(user.role,"donor");assert.equal(user.canManageGivingCategories,false);assert.equal(await Session.countDocuments(),0);
 assert.equal(sent.length,0);assert.equal((await Donation.findById(result.id))?.source,"offline");
 assert.equal((await Donation.findById(result.id))?.donationPurpose,"Temple library");
 assert.equal((await Donation.findById(result.id))?.offlinePaymentMethod,"cash");
 const receipt=await new ReceiptService().create(result.id,new Types.ObjectId(result.donor.id));assert.equal(Buffer.from(receipt.bytes).subarray(0,4).toString(),"%PDF");
});

test("existing donor lookup is limited and safe; account values are authoritative and unchanged",async()=>{
 const user=await User.create({name:"Saved Name",email:"person@example.test",phone:"1234567890",passwordHash:"existing-hash",role:"donor"});
 await User.create({name:"Admin",email:"person-admin@example.test",passwordHash:"admin-hash",role:"admin"});
 const original=JSON.stringify(await User.findById(user._id).select("+passwordHash").lean());
 const found=await service.search(" PERSON@");assert.equal(found.length,1);assert.equal(found[0]?.name,"Saved Name");assert.ok(!JSON.stringify(found).includes("hash"));
 const result=await service.create(body({user:String(user._id),donorEmail:"PERSON@example.test",donorName:"Do not overwrite",donorPhone:"000"}),admin,"existing-donor-0001");
 assert.equal(result.donor.id,String(user._id));assert.equal((await Donation.findById(result.id))?.donorName,"Saved Name");
 assert.equal(JSON.stringify(await User.findById(user._id).select("+passwordHash").lean()),original);
 assert.equal(await User.countDocuments(),2);
});

test("concurrent identical submissions make one user and donation; changed payload conflicts",async()=>{
 const results=await Promise.all([service.create(body(),admin,"concurrent-offline-0001"),service.create(body(),admin,"concurrent-offline-0001")]);
 assert.equal(results[0]!.id,results[1]!.id);assert.equal(await User.countDocuments(),1);assert.equal(await Donation.countDocuments(),1);
 await assert.rejects(service.create(body({amountCents:2600}),admin,"concurrent-offline-0001"),(error:unknown)=>error instanceof AppError&&error.code==="IDEMPOTENCY_CONFLICT");
});

test("different submissions racing on the same normalized email reuse one donor",async()=>{
 const results=await Promise.all([service.create(body(),admin,"email-race-offline-0001"),service.create(body({donorEmail:"NEW@EXAMPLE.TEST"}),admin,"email-race-offline-0002")]);
 assert.equal(results[0]!.donor.id,results[1]!.donor.id);assert.equal(await User.countDocuments(),1);assert.equal(await Donation.countDocuments(),2);
});

test("relationship, fixed amount, Other purpose and donor ID validation roll back new accounts",async()=>{
 for(const overrides of [{giving:fixed,amountCents:2500},{donationPurpose:undefined},{categoryId:festivalCategory},{user:new Types.ObjectId().toString()},{giving:festival,type:"general",categoryId:festivalCategory,amountCents:100100}]){
  await assert.rejects(service.create(body(overrides),admin,"invalid-offline-0001"));assert.equal(await User.countDocuments(),0);assert.equal(await Donation.countDocuments(),0);
 }
 assert.equal(offlineBody.safeParse({...body(),amountCents:1000001}).success,false);
 assert.equal(offlineBody.safeParse({...body(),amountCents:100.1}).success,false);
 assert.equal(offlineBody.safeParse({...body(),currency:"EUR"}).success,false);
});

test("fixed/custom/Utsav rules and historical offline Event eligibility remain supported",async()=>{
 for(const [id,amount,type,cat]of [[fixed,50100,"general",category],[mixed,12345,"general",category],[festival,100100,"event",festivalCategory]] as const){
  await service.create(body({giving:id,amountCents:amount,type,categoryId:cat}),admin,`valid-offline-${id}`);
 }
 const event=await Event.create({title:"Past Event",slug:"past-event",startsAt:new Date("2020-01-01"),location:"Temple",status:"inactive"});
 await service.create(body({giving:undefined,categoryId:undefined,event:String(event._id),type:"event"}),admin,"historical-offline-0001");
 assert.equal(await Donation.countDocuments(),4);
});

test("welcome email is single-use, expiring and verifies ownership only after password setup",async()=>{
 const result=await service.create(body(),admin,"welcome-offline-0001");
 await Promise.all([service.deliverWelcome(result.donor.id),service.deliverWelcome(result.donor.id)]);assert.equal(sent.length,1);
 assert.match(sent[0]!.subject,/Welcome/);const url=sent[0]!.text.match(/http:\/\/localhost:3000\/reset-password\?token=([a-f0-9]+)/)!;assert.ok(url);
 const user=await User.findById(result.donor.id).select("+resetTokenHash +resetExpiresAt +passwordHash");assert.ok(user?.resetExpiresAt);assert.ok(user.resetExpiresAt.getTime()>Date.now());assert.notEqual(user.resetTokenHash,url[1]);assert.equal(user.emailVerifiedAt,undefined);
 await auth.resetPassword(url[1]!,"New-Password-Fixture-123!");
 const verified=await User.findById(result.donor.id).select("+passwordHash");assert.ok(verified?.emailVerifiedAt);assert.equal(verified.passwordSetupRequired,false);assert.equal(await bcrypt.compare("New-Password-Fixture-123!",verified.passwordHash),true);
 await assert.rejects(auth.resetPassword(url[1]!,"Another-Password-123!"));
});

test("failed/unconfigured welcome delivery preserves records and retries only the email",async()=>{
 const result=await service.create(body(),admin,"failed-mail-offline-0001");failMail=true;
 await service.deliverWelcome(result.donor.id);assert.equal((await User.findById(result.donor.id))?.welcomeEmailStatus,"failed");
 assert.equal(await Donation.countDocuments(),1);failMail=false;await service.deliverWelcome(result.donor.id);assert.equal(sent.length,1);
 assert.equal(await User.countDocuments(),1);assert.equal(await Donation.countDocuments(),1);
 await User.updateOne({_id:result.donor.id},{$set:{welcomeEmailStatus:"pending"}});
 await new OfflineDonationService(new DonationService(),auth,undefined,config.FRONTEND_URL).deliverWelcome(result.donor.id);
 assert.equal((await User.findById(result.donor.id))?.welcomeEmailStatus,"failed");
});

test("expired setup tokens fail, pending donations do not issue receipts",async()=>{
 const result=await service.create(body({status:"pending"}),admin,"pending-offline-0001");await service.deliverWelcome(result.donor.id);
 const token=sent[0]!.text.match(/token=([a-f0-9]+)/)![1]!;
 await User.updateOne({_id:result.donor.id},{$set:{resetExpiresAt:new Date(0)}});
 await assert.rejects(auth.resetPassword(token,"Password-Example-123!"));
 await assert.rejects(new ReceiptService().create(result.id),(error:unknown)=>error instanceof AppError&&error.code==="RECEIPT_NOT_ELIGIBLE");
});

test("admin routes reject unauthorized donors, require idempotency and expose only safe search fields",async()=>{
 const app=createApp(config);
 for(const path of ["/api/v1/admin/donors/search?email=person","/api/v1/admin/donations/offline","/api/v1/admin/donors/507f1f77bcf86cd799439011/welcome-email"]){
  const get=path.includes("search");
  assert.equal((await (get?request(app).get(path):request(app).post(path).send(body()))).status,401);
  assert.equal((await (get?request(app).get(path):request(app).post(path).send(body())).set("Authorization","Bearer donor-fixture")).status,403);
 }
 const result=await request(app).post("/api/v1/admin/donations/offline").set("Authorization","Bearer admin-fixture").send(body());assert.equal(result.status,400);assert.equal(result.body.error.code,"IDEMPOTENCY_KEY_REQUIRED");
 const search=await request(app).get("/api/v1/admin/donors/search?email=new").set("Authorization","Bearer admin-fixture");assert.equal(search.status,200);assert.deepEqual(search.body.data,[]);
});

test("admin save returns before mail delivery; replay and email retry cannot duplicate donation",async()=>{
 let release:()=>void=()=>{};
 const blocked=new Promise<void>(resolve=>{release=resolve});
 let sendStarted=false;
 const app=createApp(config,{mail:{send:async()=>{sendStarted=true;assert.equal(await Donation.countDocuments(),1);await blocked;throw new Error('isolated email failure')}}});
 const save=()=>request(app).post('/api/v1/admin/donations/offline').set('Authorization','Bearer admin-fixture').set('Idempotency-Key','http-offline-replay-0001').send(body());
 const first=await save();assert.equal(first.status,201);
 const replay=await save();assert.equal(replay.status,200);assert.equal(replay.body.data.id,first.body.data.id);
 for(let i=0;i<50&&!sendStarted;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(sendStarted,true);release();
 for(let i=0;i<50&&(await User.findById(first.body.data.donor.id))?.welcomeEmailStatus!=='failed';i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal((await User.findById(first.body.data.donor.id))?.welcomeEmailStatus,'failed');
 await User.updateOne({_id:first.body.data.donor.id},{$set:{welcomeEmailLastAttemptAt:new Date(0)}});
 await service.retryWelcome(first.body.data.donor.id);
 for(let i=0;i<50&&(await User.findById(first.body.data.donor.id))?.welcomeEmailStatus!=='sent';i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(sent.length,1);assert.equal(await Donation.countDocuments(),1);assert.equal(await User.countDocuments(),1);
});
