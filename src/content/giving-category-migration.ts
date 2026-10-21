import {dailySeva, utsavOptions, festivalGroups} from "./client-catalog.js";
export const categoryMigrationHost = "pushtidham-dev.p6lbrfc.mongodb.net";
export const categoryMigrationDatabase = "pushtidham_payment_sandbox";
export const categoryDefinitions = [
  {name:"Daily Seva",slug:"daily-seva",legacy:"daily_seva",count:7},
  {name:"General Donation",slug:"general-donation",legacy:"general",count:1},
  ...Object.entries(festivalGroups).map(([slug,name])=>({name,slug,legacy:slug,count:slug==="adhikmas-hindola"?2:slug==="annakut"?4:3})),
].map((row,index)=>({...row,status:"active" as const,description:"",image:"",displayOrder:index+1}));
const dailyIds = ["6ad1021ef3748c180dd7a704","6ad1021ef3748c180dd7a705","6ad1021ef3748c180dd7a706","6ad1021ef3748c180dd7a708","6ad1021ef3748c180dd7a707","6ad1021ef3748c180dd7a709","6ad1021ef3748c180dd7a70a"];
export const categoryMapping = [
  ...dailySeva.map((row,index)=>({...row,id:dailyIds[index]!,categorySlug:"daily-seva",category:"daily_seva",festivalGroup:""})),
  {id:"6ad59bdb3e2112a895ec6676",slug:"mahaprasad-manorathi",title:"Mahaprasad Manorathi",amount:50100,categorySlug:"general-donation",category:"general",festivalGroup:""},
  ...utsavOptions.map((row,index)=>({...row,id:(BigInt("0x6ad59bdb3e2112a895ec6677")+BigInt(index)).toString(16),categorySlug:row.festivalGroup})),
];
export const legacyMapping = [
  {id:"6ad19f2c5fbc9136a42322f8",slug:"hhngh",title:"gfhjjh"},
  {id:"6ad1de89a0cdcc1647cebfec",slug:"testing",title:"Testing"},
];
type Existing={_id:unknown;slug:string;title:string;status:string;amountType:string;fixedAmountsCents:number[];category?:string;festivalGroup?:string;categoryId?:unknown;deletedAt?:unknown};
export function verifyCategoryMigrationRecords(records:Existing[]) {
  if(records.length!==25)throw new Error("Expected exactly 25 Giving records");
  for(const expected of categoryMapping){
    const row=records.find(row=>String(row._id)===expected.id);
    if(!row||row.slug!==expected.slug||row.title!==expected.title||row.status!=="active"||row.deletedAt||row.amountType!=="fixed"||JSON.stringify(row.fixedAmountsCents)!==JSON.stringify([expected.amount])||row.category!==expected.category||(row.festivalGroup||"")!==expected.festivalGroup)
      throw new Error("Giving drift: "+expected.slug);
  }
  for(const expected of legacyMapping){
    const row=records.find(row=>String(row._id)===expected.id);
    if(!row||row.slug!==expected.slug||row.title!==expected.title||row.status!=="inactive"||!row.deletedAt||row.categoryId)throw new Error("Legacy Giving drift: "+expected.slug);
  }
  if(new Set(records.map(row=>row.slug)).size!==25)throw new Error("Duplicate Giving slugs");
  return categoryMapping;
}
