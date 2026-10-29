import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {CatalogService} from '../src/services/catalog.js';
import {Giving} from '../src/models/giving.js';
import {GivingCategory} from '../src/models/giving-category.js';
import {givingBody} from '../src/validators/catalog.js';
import {festivalKeys} from '../src/content/client-catalog.js';
import {AppError} from '../src/utils/errors.js';
let mongo:MongoMemoryServer;
const service=new CatalogService();
const input=(overrides:Record<string,unknown>={})=>givingBody.parse({title:'Fixture Giving',amountType:'fixed',fixedAmountsCents:[2500],category:'general',...overrides});
before(async()=>{mongo=await MongoMemoryServer.create();assert.match(mongo.getUri(),/^mongodb:\/\/127\.0\.0\.1:/);await mongoose.connect(mongo.getUri(),{dbName:'isolated_giving_auto_category'});await Promise.all([Giving.init(),GivingCategory.init()])});
after(async()=>{await mongoose.disconnect();await mongo?.stop()});
beforeEach(async()=>{await Promise.all([Giving.deleteMany({}),GivingCategory.deleteMany({})]);await GivingCategory.create(['daily-seva','general-donation',...festivalKeys].map(slug=>({slug,name:slug,status:'active' as const})))});

test('new Giving resolves all seven authoritative category IDs without a client categoryId',async()=>{
 for(const [category,festivalGroup,slug]of [['general','','general-donation'],['daily_seva','','daily-seva'],...festivalKeys.map(key=>['utsav',key,key])]){
  const row=await service.createGiving(input({title:'Fixture '+slug,category,festivalGroup}));
  const expected=await GivingCategory.findOne({slug});assert.equal(String(row.categoryId),String(expected!._id));
  assert.equal(row.category,category);assert.equal(row.festivalGroup,festivalGroup);
 }
 assert.equal(await Giving.countDocuments(),7);
});

test('editing section or festival remaps the relationship while preserving identity and amounts',async()=>{
 const row=await service.createGiving(input({category:'daily_seva'}));
 const firstId=String(row._id),slug=row.slug;
 const updated=await service.replaceGiving(firstId,input({category:'utsav',festivalGroup:'dolotsav'}));
 assert.equal(String(updated._id),firstId);assert.equal(updated.slug,slug);assert.deepEqual(updated.fixedAmountsCents,[2500]);
 assert.equal(String(updated.categoryId),String((await GivingCategory.findOne({slug:'dolotsav'}))!._id));
 const next=await service.replaceGiving(firstId,input({category:'utsav',festivalGroup:'annakut'}));
 assert.equal(String(next.categoryId),String((await GivingCategory.findOne({slug:'annakut'}))!._id));
 const general=await service.replaceGiving(firstId,input({category:"general"}));
 assert.equal(general.festivalGroup,"");
 assert.equal(String(general.categoryId),String((await GivingCategory.findOne({slug:"general-donation"}))!._id));
});

test('missing/inactive categories and contradictory client category IDs fail without creating Giving',async()=>{
 const daily=await GivingCategory.findOne({slug:'daily-seva'});
 await assert.rejects(service.createGiving(input({categoryId:String(daily!._id)})),(error:unknown)=>error instanceof AppError&&error.code==='CATEGORY_MISMATCH');
 await GivingCategory.updateOne({slug:'general-donation'},{$set:{status:'inactive'}});
 await assert.rejects(service.createGiving(input()),(error:unknown)=>error instanceof AppError&&error.code==='INVALID_CATEGORY');
 await GivingCategory.deleteOne({slug:'daily-seva'});
 await assert.rejects(service.createGiving(input({category:'daily_seva'})),(error:unknown)=>error instanceof AppError&&error.code==='INVALID_CATEGORY');
 assert.equal(await Giving.countDocuments(),0);
});

test('failed remapping leaves an existing Giving unchanged; legacy rows are not migrated automatically',async()=>{
 const row=await service.createGiving(input());
 const snapshot=JSON.stringify(await Giving.findById(row._id).lean());
 await GivingCategory.deleteOne({slug:'annakut'});
 await assert.rejects(service.replaceGiving(String(row._id),input({category:'utsav',festivalGroup:'annakut'})));
 assert.equal(JSON.stringify(await Giving.findById(row._id).lean()),snapshot);
 const legacy=await Giving.create({title:'Legacy',slug:'legacy',amountType:'custom',status:'inactive'});
 assert.equal((await Giving.findById(legacy._id))?.categoryId,undefined);
});
