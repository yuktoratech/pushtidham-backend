import {before, after, test, mock} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import mongoose, {Types} from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import request from "supertest";
import {dailySeva, utsavOptions, festivalGroups, buildClientCatalogPlan} from "../src/content/client-catalog.js";
import {User} from "../src/models/user.js";
import {Giving} from "../src/models/giving.js";
import {Event} from "../src/models/event.js";
import {Donation} from "../src/models/donation.js";
import {AuthService} from "../src/services/auth.js";
import {resolveDonationDesignation} from "../src/services/donation-eligibility.js";
import {loadConfig} from "../src/config/env.js";
import {createApp} from "../src/app.js";
import {AppError} from "../src/utils/errors.js";

const config = loadConfig({NODE_ENV:"test", MONGODB_URI:"mongodb://127.0.0.1/unused", FRONTEND_URL:"http://localhost:3000", JWT_ACCESS_SECRET:randomBytes(40).toString("hex"), JWT_REFRESH_SECRET:randomBytes(40).toString("hex")});
const app = createApp(config);
const admin = new Types.ObjectId(), donor = new Types.ObjectId();
let mongo: MongoMemoryReplSet;
before(async () => {
  mongo=await MongoMemoryReplSet.create({replSet:{count:1}});
  await mongoose.connect(mongo.getUri(),{dbName:"isolated_client_catalog_fixtures"});
  await Promise.all([User.init(),Donation.init()]);
  mock.method(AuthService.prototype,"authenticate",async(token:string)=>{
    if(token==='fixture-admin')return {id:admin,role:'admin' as const,sessionId:'fixture'};
    if(token==='fixture-donor')return {id:donor,role:'donor' as const,sessionId:'fixture'};
    throw new AppError(401,'UNAUTHENTICATED','Authentication required');
  });
  await Giving.create(dailySeva.map((row,index)=>({title:row.title,slug:row.slug,category:'daily_seva' as const,amountType:'fixed' as const,fixedAmountsCents:[row.amount],displayOrder:index+1,status:'active' as const})));
  await Giving.create(utsavOptions.map(row=>({title:row.title,slug:row.slug,category:row.category,festivalGroup:row.festivalGroup,amountType:'fixed' as const,fixedAmountsCents:[row.amount],status:'active' as const})));
  await Giving.create({title:'Mahaprasad Manorathi',slug:'mahaprasad-manorathi',amountType:'fixed',fixedAmountsCents:[50100],status:'active'});
});
after(async()=>{mock.restoreAll();await mongoose.disconnect();await mongo?.stop();});

test('confirmed catalog has seven Daily Seva, five Utsav groups, fifteen options and Mahaprasad',async()=>{
  assert.equal(dailySeva.length,7);assert.equal(Object.keys(festivalGroups).length,5);assert.equal(utsavOptions.length,15);
  assert.deepEqual(dailySeva.map(row=>row.amount),[8400,15100,20100,30100,25100,10100,40100]);
  assert.equal(dailySeva[4].title,'Golden Palna Seva');assert.equal(dailySeva[5].title,'Shayan Palna');assert.equal(dailySeva[6].title,'Whole Day Seva');
  assert.equal(await Giving.countDocuments({category:'utsav'}),15);
  assert.equal((await Giving.findOne({slug:'mahaprasad-manorathi'}))?.fixedAmountsCents[0],50100);
  assert.equal(await Event.countDocuments(),0);
});
test('read-only catalog plan retains slugs, matches IDs and is idempotent',()=>{
  const old=dailySeva.map(row=>({_id:new Types.ObjectId(),slug:row.slug,title:row.slug==='gold-palna-seva'?'Gold Palna Seva':row.title,fixedAmountsCents:[row.slug==='gold-palna-seva'?25000:row.amount],amountType:'fixed',status:'active'}));
  const plan=buildClientCatalogPlan(old);
  assert.equal(plan.filter(row=>row.action==='update').length,7);assert.equal(plan.filter(row=>row.action==='create').length,16);
  assert.equal(plan.find(row=>row.proposed.slug==='gold-palna-seva')?.id,String(old[4]!._id));
  assert.ok(buildClientCatalogPlan(plan.map(row=>({_id:row.id||new Types.ObjectId(),...row.proposed}))).every(row=>row.action==='retain'));
  assert.throws(()=>buildClientCatalogPlan([...old,old[0]!]),/Duplicate slug/);
  assert.throws(()=>buildClientCatalogPlan(old.slice(1)),/Missing expected/);
});
test('festival options require Event and exact server-configured amounts',async()=>{
  for(const row of utsavOptions){
    const giving=await Giving.findOne({slug:row.slug});assert.ok(giving);
    const input={type:'event' as const,giving:String(giving._id),amountCents:row.amount};
    assert.equal((await resolveDonationDesignation(input)).title,`${festivalGroups[row.festivalGroup]} — ${row.title}`);
    await assert.rejects(resolveDonationDesignation({...input,amountCents:row.amount+100}),(e:unknown)=>e instanceof AppError&&e.code==='INVALID_AMOUNT');
    await assert.rejects(resolveDonationDesignation({...input,type:'general'}),(e:unknown)=>e instanceof AppError&&e.code==='INVALID_DESIGNATION');
  }
});
test('scheduled Events remain informational and cannot start donations',async()=>{
  const event=await Event.create({title:'Fixture scheduled event',slug:'fixture-scheduled',startsAt:new Date('2027-01-01'),location:'Fixture only',status:'published'});
  await assert.rejects(resolveDonationDesignation({type:'event',event:event.id,amountCents:12345}),(error:unknown)=>error instanceof AppError&&error.code==='EVENT_DONATIONS_DISABLED');
});
test('new Golden Palna prices never rewrite a historical $250 snapshot',async()=>{
  const gold=await Giving.findOne({slug:'gold-palna-seva'});assert.ok(gold);
  assert.equal((await resolveDonationDesignation({type:'general',giving:gold.id,amountCents:25100})).title,'Golden Palna Seva');
  await assert.rejects(resolveDonationDesignation({type:'general',giving:gold.id,amountCents:25000}),(e:unknown)=>e instanceof AppError&&e.code==='INVALID_AMOUNT');
  const old=await Donation.create({donationNumber:'HISTORICAL-GOLD-FIXTURE',donorName:'Fixture Donor',donorEmail:'fixture@example.test',type:'general',giving:gold._id,designationTitle:'Gold Palna Seva',amountCents:25000,source:'offline',paymentMethod:'offline',status:'completed',verifiedAt:new Date(),verifiedBy:admin});
  const csv=await request(app).get('/api/v1/admin/donations/export.csv').query({search:old.donationNumber}).set('Authorization','Bearer fixture-admin');
  assert.equal(csv.status,200);assert.match(csv.text,/Gold Palna Seva/);assert.match(csv.text,/250\.00/);assert.doesNotMatch(csv.text,/Golden Palna Seva/);
});
test('admin-only catalog options validate festival configuration',async()=>{
  const body={title:'Fixture option',category:'utsav',festivalGroup:'annakut',amountType:'fixed',fixedAmountsCents:[20100]};
  assert.equal((await request(app).post('/api/v1/admin/giving').send(body)).status,401);
  assert.equal((await request(app).post('/api/v1/admin/giving').set('Authorization','Bearer fixture-donor').send(body)).status,403);
  assert.equal((await request(app).post('/api/v1/admin/giving').set('Authorization','Bearer fixture-admin').send({...body,amountType:'custom'})).status,400);
  assert.equal((await request(app).post('/api/v1/admin/giving').set('Authorization','Bearer fixture-admin').send(body)).status,201);
});
test('festival snapshots survive catalog edits and reach receipts, details and CSV',async()=>{
  const option=await Giving.findOne({slug:utsavOptions[0]!.slug});assert.ok(option);
  const response=await request(app).post('/api/v1/admin/donations/offline').set("Idempotency-Key", "offline-existing-test-1-0001").set('Authorization','Bearer fixture-admin').send({donorName:'Fixture Donor',donorEmail:'fixture@example.test',type:'event',giving:option.id,amountCents:100100,status:'completed'});
  assert.equal(response.status,201,JSON.stringify(response.body));
  const row=await Donation.findOne({giving:option._id});assert.ok(row);
  assert.equal(row.festivalTitle,'Dolotsav');assert.equal(row.donationOptionTitle,'Mukhya Manorathi');
  await Giving.updateOne({_id:option._id},{$set:{title:'Changed fixture title',fixedAmountsCents:[99900]}});
  const unchanged=await Donation.findById(row._id);assert.equal(unchanged?.designationTitle,'Dolotsav — Mukhya Manorathi');assert.equal(unchanged?.amountCents,100100);
  const pdf=await request(app).get(`/api/v1/admin/donations/${row.id}/receipt`).set('Authorization','Bearer fixture-admin');assert.equal(pdf.status,200);assert.match(String(pdf.headers['content-type']),/application\/pdf/);
  const details=await request(app).get(`/api/v1/admin/donations/${row.id}`).set('Authorization','Bearer fixture-admin');assert.equal(details.body.data.festivalTitle,'Dolotsav');
  const csv=await request(app).get('/api/v1/admin/donations/export.csv').query({search:row.donationNumber}).set('Authorization','Bearer fixture-admin');assert.equal(csv.status,200);assert.match(csv.text,/Dolotsav/);assert.match(csv.text,/Mukhya Manorathi/);assert.match(csv.text,/1001\.00/);assert.doesNotMatch(csv.text,/Changed fixture title/);
});
