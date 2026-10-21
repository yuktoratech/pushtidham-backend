import "dotenv/config";
import {createHash} from "node:crypto";
import {realpath,open,readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {MongoClient,ObjectId,BSON,type Document} from "mongodb";
import {categoryDefinitions,categoryMapping,legacyMapping,categoryMigrationDatabase as database,categoryMigrationHost as host,verifyCategoryMigrationRecords} from "../src/content/giving-category-migration.js";

// PREPARED ONLY. Never invoked by startup, seed, install, build or tests.
// Default mode is read-only. Apply and rollback require separate operator approval.
const args=process.argv.slice(2);
if(args.includes("--apply")&&args.includes("--rollback"))throw new Error("Choose apply or rollback, not both");
const mode=args.includes("--apply")?"apply":args.includes("--rollback")?"rollback":"plan";
const value=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]};
const uri=process.env.MONGODB_URI||"";
const parsed=new URL(uri);
if(parsed.protocol!=="mongodb+srv:"||parsed.hostname!==host||process.env.MONGODB_DATABASE!==database||process.env.NODE_ENV!=="development")
 throw new Error("Exact approved Atlas sandbox host/database/development environment required");
if(mode!=="plan"&&value("--approval")!=="giving-categories-v1")throw new Error("Separate explicit approval required: --approval giving-categories-v1");
const backupPath=value("--backup");
const repoRoot=fileURLToPath(new URL("../",import.meta.url));
const inside=(root:string,target:string)=>{const relative=path.relative(root,target);return relative===""||(!path.isAbsolute(relative)&&relative!==".."&&!relative.startsWith(".."+path.sep))};
if(mode!=="plan"){
 if(!backupPath||!path.isAbsolute(backupPath))throw new Error("Use an absolute private backup file");
 const parent=await realpath(path.dirname(backupPath));
 if(inside(repoRoot,parent)||inside(path.resolve(repoRoot,"../pushtidham-frontend"),parent))throw new Error("Backup must be outside both repositories");
}
const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
const idFor=(slug:string)=>new ObjectId(createHash("sha256").update("pushtidham-giving-category-v1:"+slug).digest("hex").slice(0,24));
const stable=(rows:Document[])=>BSON.EJSON.stringify(rows.toSorted((a,b)=>String(a._id).localeCompare(String(b._id))),{relaxed:false});
try{
 await client.connect();const db=client.db(database);
 const hello=await db.command({hello:1});
 if(!hello.isWritablePrimary||!hello.setName)throw new Error("Writable replica-set primary required");
 const giving=db.collection("givings"),categories=db.collection("givingcategories");
 const records=await giving.find({}).toArray();
 verifyCategoryMigrationRecords(records as never);
 const existingCategories=await categories.find({}).toArray();
 const eventCount=await db.collection("events").countDocuments(),donationCount=await db.collection("donations").countDocuments();
 if(eventCount!==7||donationCount!==2)throw new Error("Expected Events=7 and Donations=2; drift requires a fresh approval");
 if(existingCategories.length!==0&&existingCategories.length!==7)throw new Error("Unexpected category count");
 for(const row of existingCategories){
   const expected=categoryDefinitions.find(c=>c.slug===row.slug);
   if(!expected||String(row._id)!==String(idFor(expected.slug))||row.name!==expected.name||row.slug!==expected.slug||row.status!=="active"||row.image!==""||row.description!==""||row.displayOrder!==expected.displayOrder)throw new Error("Category identity conflict");
 }
 for(const row of records){
   const mapping=categoryMapping.find(m=>m.id===String(row._id));
   if(row.categoryId&&(!mapping||String(row.categoryId)!==String(idFor(mapping.categorySlug))))throw new Error("Existing category assignment conflict");
 }
 const assigned=records.filter(row=>row.categoryId).length;
 if((existingCategories.length===0&&assigned!==0)||(existingCategories.length===7&&assigned!==23))throw new Error("Partial category migration; manual review required");
 if(mode==="plan"){
   console.log(JSON.stringify({mode,database,host,categories:categoryDefinitions,mapping:categoryMapping,legacyUnassigned:legacyMapping,expected:{categories:7,givings:25,active:23,events:7,donations:2}},null,2));
 }else{
   let backup: {version:number;host:string;database:string;givings:Document[];categories:Document[]};
   if(mode==="apply"){
     if(existingCategories.length===7&&records.filter(r=>r.categoryId).length===23){console.log("Already applied; no writes");}
     else{
       backup={version:1,host,database,givings:records,categories:existingCategories};
       const file=await open(backupPath!,"wx",0o600);try{await file.writeFile(BSON.EJSON.stringify(backup,{relaxed:false}));await file.sync()}finally{await file.close()}
       // The folder must have private Windows ACLs before execution. Never commit backups.
       await categories.createIndex({slug:1},{unique:true});
       await categories.createIndex({status:1,displayOrder:1,_id:1});
       await giving.createIndex({categoryId:1,status:1,deletedAt:1,displayOrder:1,_id:1});
       const session=client.startSession();
       try{await session.withTransaction(async()=>{
         const before=await giving.find({},{session}).toArray();verifyCategoryMigrationRecords(before as never);
         if(stable(before)!==stable(records))throw new Error("Concurrent Giving changes; abort");
         if(stable(await categories.find({},{session}).toArray())!==stable(existingCategories))throw new Error("Concurrent category changes; abort");
         for(const definition of categoryDefinitions){
           const {_id,...body}={_id:idFor(definition.slug),name:definition.name,slug:definition.slug,description:definition.description,image:definition.image,status:definition.status,displayOrder:definition.displayOrder};
           await categories.updateOne({_id},{$setOnInsert:{...body,createdAt:new Date(),updatedAt:new Date()}},{upsert:true,session});
         }
         for(const mapping of categoryMapping){
           const result=await giving.updateOne({_id:new ObjectId(mapping.id),slug:mapping.slug,status:"active"},{$set:{categoryId:idFor(mapping.categorySlug)}},{session});
           if(result.matchedCount!==1)throw new Error("Giving disappeared");
         }
         if(await categories.countDocuments({},{session})!==7||await giving.countDocuments({},{session})!==25||await giving.countDocuments({status:"active",deletedAt:null},{session})!==23||await giving.countDocuments({categoryId:{$exists:true}},{session})!==23)throw new Error("Post-migration count mismatch");
       })}finally{await session.endSession()}
       console.log("Applied category relationships only; backup retained privately");
     }
   }else{
     backup=BSON.EJSON.parse(await readFile(backupPath!,"utf8")) as typeof backup;
     if(backup.version!==1||backup.host!==host||backup.database!==database||backup.categories.length!==0)throw new Error("Invalid rollback backup");
     verifyCategoryMigrationRecords(backup.givings as never);
     const session=client.startSession();
     try{await session.withTransaction(async()=>{
       const current=await giving.find({},{session}).toArray();
       if(current.length!==25)throw new Error("Rollback drift");
       if(await categories.countDocuments({},{session})===0&&stable(current)===stable(backup.givings))return;
       if(await categories.countDocuments({},{session})!==7)throw new Error("Rollback category count drift");
       for(const row of current){const mapping=categoryMapping.find(m=>m.id===String(row._id));if(mapping){if(String(row.categoryId)!==String(idFor(mapping.categorySlug)))throw new Error("Assignment drift");delete row.categoryId}}
       if(stable(current)!==stable(backup.givings))throw new Error("Records changed after migration; manual review required");
       for(const definition of categoryDefinitions){
         const category=await categories.findOne({_id:idFor(definition.slug)},{session});
         if(!category||category.name!==definition.name||category.description!==""||category.image!==""||category.status!=="active")throw new Error("Category changed; manual rollback review required");
       }
       for(const mapping of categoryMapping)await giving.updateOne({_id:new ObjectId(mapping.id),categoryId:idFor(mapping.categorySlug)},{$unset:{categoryId:""}},{session});
       for(const definition of categoryDefinitions)await categories.deleteOne({_id:idFor(definition.slug)},{session});
     })}finally{await session.endSession()}
     console.log("Category migration rolled back; all Giving records and historical financial records preserved");
   }
 }
}finally{await client.close()}
