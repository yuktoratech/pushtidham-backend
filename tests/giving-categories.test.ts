import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import bcrypt from "bcrypt";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";
import {User} from "../src/models/user.js";
import {Giving} from "../src/models/giving.js";
import {GivingCategory} from "../src/models/giving-category.js";
import {Event} from "../src/models/event.js";
import {Donation} from "../src/models/donation.js";
import {CatalogService} from "../src/services/catalog.js";
import {resolveDonationDesignation} from "../src/services/donation-eligibility.js";
import {DonationService} from "../src/services/donations.js";
import {givingBody,eventBody} from "../src/validators/catalog.js";
import {categoryMapping,legacyMapping,verifyCategoryMigrationRecords} from "../src/content/giving-category-migration.js";
import {CATEGORY_FREEZE_ID} from "../src/middleware/category-edit-freeze.js";
const config=loadConfig({NODE_ENV:"test",MONGODB_URI:"mongodb://127.0.0.1/isolated_categories",FRONTEND_URL:"http://localhost:3000",JWT_ACCESS_SECRET:randomBytes(40).toString("hex"),JWT_REFRESH_SECRET:randomBytes(40).toString("hex")});
const app=createApp(config),service=new CatalogService();
let mongo:MongoMemoryReplSet,token:string,categoryId:string,givingId:string,eventId:string;
before(async()=>{
 mongo=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(mongo.getUri(),{dbName:"category_isolated"});
 await Promise.all([GivingCategory.init(),Giving.init(),Event.init(),User.init(),Donation.init()]);
 const password=randomBytes(20).toString("hex");await User.create({name:"Admin",email:"category-admin@example.test",passwordHash:await bcrypt.hash(password,4),role:"admin",canManageGivingCategories:true});
 const login=await request(app).post("/api/v1/auth/login").send({email:"category-admin@example.test",password});assert.equal(login.status,200);token=login.body.data.accessToken;
});
after(async()=>{await mongoose.disconnect();await mongo?.stop()});
test("category APIs require administrator and enforce unique slugs",async()=>{
 assert.equal((await request(app).post("/api/v1/admin/giving-categories").send({name:"Daily Seva"})).status,401);
 const response=await request(app).post("/api/v1/admin/giving-categories").set("Authorization","Bearer "+token).send({name:"Daily Seva",slug:"daily-seva"});
 assert.equal(response.status,201);categoryId=response.body.data._id;
 assert.equal((await request(app).post("/api/v1/admin/giving-categories").set("Authorization","Bearer "+token).send({name:"Duplicate",slug:"daily-seva"})).status,409);
 const publicRows=await request(app).get("/api/v1/giving-categories");assert.equal(publicRows.body.data.length,1);
 const normalPassword=randomBytes(20).toString("hex");await User.create({name:"Normal Admin",email:"normal-category-admin@example.test",passwordHash:await bcrypt.hash(normalPassword,4),role:"admin"});
 const normalLogin=await request(app).post("/api/v1/auth/login").send({email:"normal-category-admin@example.test",password:normalPassword});
 const normalAuth={Authorization:"Bearer "+normalLogin.body.data.accessToken};
 for(const method of ["get","post"] as const){
  const response=method==="get"?await request(app).get("/api/v1/admin/giving-categories").set(normalAuth):await request(app).post("/api/v1/admin/giving-categories").set(normalAuth).send({name:"Forbidden",slug:"forbidden"});
  assert.equal(response.status,403);
 }
 assert.equal((await request(app).get("/api/v1/admin/giving-categories").set("Authorization","Bearer "+token)).status,200);
 assert.equal((await request(app).put(`/api/v1/admin/giving-categories/${categoryId}`).set(normalAuth).send({name:"Blocked",slug:"daily-seva"})).status,403);
 assert.equal((await request(app).patch(`/api/v1/admin/giving-categories/${categoryId}/status`).set(normalAuth).send({status:"inactive"})).status,403);
 assert.equal((await request(app).get(`/api/v1/admin/giving-categories/${categoryId}`).set(normalAuth)).status,403);
 assert.equal((await request(app).delete(`/api/v1/admin/giving-categories/${categoryId}`).set(normalAuth)).status,403);
 const donorPassword=randomBytes(20).toString("hex");await User.create({name:"Donor",email:"category-donor@example.test",passwordHash:await bcrypt.hash(donorPassword,4),role:"donor"});
 const login=await request(app).post("/api/v1/auth/login").send({email:"category-donor@example.test",password:donorPassword});
 assert.equal((await request(app).post("/api/v1/admin/giving-categories").set("Authorization","Bearer "+login.body.data.accessToken).send({name:"Forbidden"})).status,403);
});
test("Giving membership validates IDs, amounts, filtering and safe category deletion",async()=>{
 const input=givingBody.parse({title:"Mangla Seva",slug:"mangla-seva",categoryId,category:"daily_seva",amountType:"fixed",fixedAmountsCents:[8400]});
 const giving=await service.createGiving(input);givingId=String(giving._id);
 await assert.rejects(service.createGiving({...input,slug:"bad-category",categoryId:new mongoose.Types.ObjectId().toString()}));
 const rows=await request(app).get("/api/v1/giving?categoryId="+categoryId);assert.equal(rows.body.data.length,1);
 assert.equal((await request(app).get("/api/v1/giving?categoryId="+new mongoose.Types.ObjectId())).body.data.length,0);
 await assert.rejects(service.removeGivingCategory(categoryId));
 await assert.rejects(service.statusGivingCategory(categoryId,"inactive"));
 await assert.rejects(resolveDonationDesignation({type:"general",giving:givingId,amountCents:8401}));
 await assert.rejects(resolveDonationDesignation({type:"general",giving:givingId,categoryId:new mongoose.Types.ObjectId().toString(),amountCents:8400}));
 assert.equal((await resolveDonationDesignation({type:"general",giving:givingId,categoryId,amountCents:8400})).title,"Mangla Seva");
 const custom=await service.createGiving(givingBody.parse({title:"Custom",slug:"custom",categoryId,amountType:"custom"}));
 assert.ok(await resolveDonationDesignation({type:"general",giving:String(custom._id),amountCents:12345}));
 const mixed=await service.createGiving(givingBody.parse({title:"Mixed",slug:"mixed",categoryId,amountType:"fixed_and_custom",fixedAmountsCents:[2500]}));
 assert.ok(await resolveDonationDesignation({type:"general",giving:String(mixed._id),amountCents:6700}));
});
test("Other purpose remains validated for offline donations; removed public routes cannot create online donations",async()=>{
 const category=await GivingCategory.create({name:"General Donation",slug:"general-donation",status:"active"});
 const other=await Giving.create({title:"Other",slug:"other",categoryId:category._id,category:"general",amountType:"custom",fixedAmountsCents:[],status:"active"});
 const body={donorName:"Fixture Donor",donorEmail:"fixture@example.test",type:"general",giving:String(other._id),amountCents:100,currency:"USD"};
 for (const purpose of [undefined,"Support","  Guest purpose  "]) {
  const response=await request(app).post("/api/v1/donations").send({...body,donationPurpose:purpose,paymentMethod:"card"});
  assert.equal(response.status,404);
 }
 const blank=await request(app).post("/api/v1/admin/donations/offline").set("Idempotency-Key", "offline-existing-test-1-0001").set("Authorization","Bearer "+token).send({...body,donationPurpose:"   "});
 assert.ok(blank.status>=400);
 const saved=await request(app).post("/api/v1/admin/donations/offline").set("Idempotency-Key", "offline-existing-test-2-0001").set("Authorization","Bearer "+token).send({...body,donationPurpose:"  Community support  "});
 assert.equal(saved.status,201);
 assert.equal(saved.body.data.donationPurpose,"Community support");
 assert.equal((await Donation.findById(saved.body.data._id))?.donationPurpose,"Community support");
 const adminView=await request(app).get(`/api/v1/admin/donations/${saved.body.data._id}`).set("Authorization","Bearer "+token);
 assert.equal(adminView.body.data.donationPurpose,"Community support");
 const legacy=await request(app).post("/api/v1/admin/donations/offline").set("Idempotency-Key", "offline-existing-test-3-0001").set("Authorization","Bearer "+token).send({...body,giving:givingId,amountCents:8400});
 assert.equal(legacy.status,201);
 assert.equal(legacy.body.data.donationPurpose,undefined);
 await assert.rejects(Giving.create({title:"Other",slug:"other",categoryId:category._id,category:"general",amountType:"custom",fixedAmountsCents:[],status:"active"}));
 assert.equal((await Giving.countDocuments({slug:"other"})),1);
});
test("Event cover/gallery preserve old updates and reject new public Event donations",async()=>{
 const existingDonationCount=await Donation.countDocuments();
 const event=await service.createEvent(eventBody.parse({title:"Historical event",slug:"historical",startsAt:"2020-01-01T12:00:00Z",location:"Haveli",status:"published",image:"/images/diya.webp",gallery:[{url:"/images/temple.webp",alt:"Haveli",displayOrder:0}]}));
 eventId=String(event._id);
 await service.replaceEvent(eventId,eventBody.parse({title:"Historical event",startsAt:"2020-01-01T12:00:00Z",location:"Haveli",status:"published",image:"/images/diya.webp"}));
 assert.equal((await Event.findById(eventId))!.gallery.length,1);
 await assert.rejects(resolveDonationDesignation({type:"event",event:eventId,amountCents:40000}),/information/);
 assert.equal((await Donation.countDocuments()),existingDonationCount);
 const offline=await new DonationService().create({donorName:"Historical donor",donorEmail:"history@example.test",type:"event",event:eventId,amountCents:40000,currency:"USD",status:"completed"},undefined,true);
 assert.equal(offline.amountCents,40000);assert.equal(offline.designationTitle,"Historical event");assert.equal(offline.status,"completed");
 assert.equal((await service.get("event","historical")).title,"Historical event");
});
test("inactive categories never expose assigned Giving and legacy records still read",async()=>{
 const inactive=await GivingCategory.create({name:"Inactive",slug:"inactive",status:"inactive"});
 await Giving.create({title:"Hidden",slug:"hidden",categoryId:inactive._id,amountType:"fixed",fixedAmountsCents:[100]});
 assert.equal((await request(app).get("/api/v1/giving?categoryId="+inactive._id)).body.data.length,0);
 assert.equal((await request(app).get("/api/v1/giving/hidden")).status,422);
 const old=await Giving.create({title:"Legacy Giving",slug:"legacy",amountType:"fixed",fixedAmountsCents:[100]});
 assert.ok(await service.get("giving",old.slug));
 assert.ok(await resolveDonationDesignation({type:"general",giving:String(old._id),amountCents:100}));
});
test("migration mapping rejects drift and preserves all 25 IDs and cents",()=>{
 const rows=[...categoryMapping.map(row=>({_id:row.id,slug:row.slug,title:row.title,status:"active",category:row.category,festivalGroup:row.festivalGroup,amountType:"fixed",fixedAmountsCents:[row.amount]})),...legacyMapping.map(row=>({_id:row.id,slug:row.slug,title:row.title,status:"inactive",deletedAt:new Date(),amountType:"fixed_and_custom",fixedAmountsCents:[2500,5100,10100]}))];
 assert.equal(verifyCategoryMigrationRecords(rows).length,23);
 assert.throws(()=>verifyCategoryMigrationRecords(rows.slice(1)));
 rows[0]!.fixedAmountsCents=[1];assert.throws(()=>verifyCategoryMigrationRecords(rows),/drift/);
});
test("category updates, deactivation and unreferenced deletion preserve assigned Giving",async()=>{
 const unused=await service.createGivingCategory({name:"Unused",slug:"unused",status:"active",description:"",image:"",displayOrder:10});
 const updated=await service.replaceGivingCategory(String(unused._id),{name:"Renamed",slug:"unused",status:"inactive",description:"Information",image:"",displayOrder:11});
 assert.equal(updated.name,"Renamed");assert.equal(updated.status,"inactive");
 assert.equal((await request(app).get("/api/v1/giving-categories/unused")).status,404);
 await service.removeGivingCategory(String(unused._id));
 assert.equal(await GivingCategory.findById(unused._id),null);
 const existing=await Giving.findById(givingId);
 await service.replaceGiving(givingId,givingBody.parse({title:"Mangla Seva",amountType:"fixed",fixedAmountsCents:[8400],category:"daily_seva"}));
 assert.equal(String((await Giving.findById(givingId))!.categoryId),String(existing!.categoryId));
});
test("shared category freeze blocks admin writes while leaving reads available",async()=>{
 const flags=mongoose.connection.db!.collection("migrationflags");
 await flags.updateOne({_id:CATEGORY_FREEZE_ID as never},{$set:{active:true,operation:"category-artwork-v1"}},{upsert:true});
 try {
  const auth={Authorization:"Bearer "+token};
  assert.equal((await request(app).post("/api/v1/admin/giving-categories").set(auth).send({name:"Frozen",slug:"frozen"})).status,503);
  assert.equal((await request(app).put(`/api/v1/admin/giving-categories/${categoryId}`).set(auth).send({name:"Changed",slug:"daily-seva"})).status,503);
  assert.equal((await request(app).patch(`/api/v1/admin/giving-categories/${categoryId}/status`).set(auth).send({status:"inactive"})).status,503);
  assert.equal((await request(app).delete(`/api/v1/admin/giving-categories/${categoryId}`).set(auth)).status,503);
  assert.equal((await request(app).get("/api/v1/giving-categories")).status,200);
  assert.equal(await GivingCategory.countDocuments({slug:"frozen"}),0);
 } finally {await flags.deleteOne({_id:CATEGORY_FREEZE_ID as never})}
});
