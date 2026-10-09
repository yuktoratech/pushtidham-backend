import { Donation } from "../models/donation.js";
import type { FinancialReportQuery } from "../validators/donation.js";

const emptySummary = { records:0,confirmedRecords:0,confirmedBaseCents:0,feeContributionCents:0,grossConfirmedCents:0,knownProviderFeesCents:0,unknownProviderFeeRecords:0,adjustmentLossCents:0,netProceedsKnownCents:0,netUnknownRecords:0,pendingBaseCents:0,failedCanceledBaseCents:0 };

export class FinancialReportService {
  async summary(query: FinancialReportQuery) {
    const match: Record<string, unknown> = {};
    if(query.from||query.to) match.createdAt={...(query.from?{$gte:new Date(query.from)}:{}),...(query.to?{$lte:new Date(query.to)}:{})};
    if(query.paymentMethod) match.paymentMethod=query.paymentMethod;
    if(query.type) match.type=query.type;
    const rows=await Donation.aggregate([
      {$match:match},
      {$lookup:{from:"paymentattempts",localField:"confirmedPaymentAttempt",foreignField:"_id",as:"attempts"}},
      {$lookup:{from:"paymentadjustments",let:{donationId:"$_id"},pipeline:[{$match:{$expr:{$and:[{$eq:["$donation","$$donationId"]},{$eq:["$status","succeeded"]}]}}}],as:"adjustments"}},
      {$set:{attempt:{$first:"$attempts"}}},
      {$set:{
        providerClass:{$cond:[{$gt:[{$size:"$attempts"},0]},"$attempt.provider",{$cond:[{$eq:["$source","offline"]},"offline",{$concat:["legacy_","$paymentMethod"]}]}]},
        base:{$ifNull:["$attempt.baseDonationCents","$amountCents"]},feeContribution:{$ifNull:["$attempt.feeContributionCents",{$ifNull:["$feeContributionCents",null]}]},gross:{$ifNull:["$attempt.totalChargeCents",{$ifNull:["$totalChargedCents",null]}]},providerFee:{$ifNull:["$attempt.actualProviderFeeCents",{$ifNull:["$actualProviderFeeCents",null]}]},
        outflows:{$sum:{$map:{input:{$filter:{input:"$adjustments",as:"a",cond:{$in:["$$a.type",["refund","ach_return","dispute"]]}}},as:"a",in:"$$a.amountCents"}}},
        reversals:{$sum:{$map:{input:{$filter:{input:"$adjustments",as:"a",cond:{$eq:["$$a.type","reversal"]}}},as:"a",in:"$$a.amountCents"}}}
      }},
      {$set:{adjustmentLoss:{$max:[0,{$subtract:["$outflows","$reversals"]}]},confirmed:{$eq:["$status","completed"]},pending:{$eq:["$status","pending"]}}},
      ...(query.provider?[{$match:{providerClass:query.provider}}]:[]),
      {$facet:{
        summary:[{$group:{_id:null,records:{$sum:1},confirmedRecords:{$sum:{$cond:["$confirmed",1,0]}},confirmedBaseCents:{$sum:{$cond:["$confirmed","$base",0]}},feeContributionCents:{$sum:{$cond:["$confirmed",{$ifNull:["$feeContribution",0]},0]}},grossConfirmedCents:{$sum:{$cond:["$confirmed",{$ifNull:["$gross","$base"]},0]}},knownProviderFeesCents:{$sum:{$cond:[{$and:["$confirmed",{$ne:["$providerFee",null]}]} ,"$providerFee",0]}},unknownProviderFeeRecords:{$sum:{$cond:[{$and:["$confirmed",{$eq:["$providerFee",null]}]},1,0]}},adjustmentLossCents:{$sum:{$cond:["$confirmed","$adjustmentLoss",0]}},netProceedsKnownCents:{$sum:{$cond:[{$and:["$confirmed",{$ne:["$providerFee",null]}]},{$subtract:[{$subtract:[{$ifNull:["$gross","$base"]},"$providerFee"]},"$adjustmentLoss"]},0]}},netUnknownRecords:{$sum:{$cond:[{$and:["$confirmed",{$eq:["$providerFee",null]}]},1,0]}},pendingBaseCents:{$sum:{$cond:["$pending","$base",0]}},failedCanceledBaseCents:{$sum:{$cond:[{$or:[{$eq:["$status","rejected"]},{$in:["$attempt.status",["failed","canceled"]]}]},"$base",0]}}}}],
        providers:[{$match:{confirmed:true}},{$group:{_id:"$providerClass",records:{$sum:1},baseDonationCents:{$sum:"$base"},grossChargedCents:{$sum:{$ifNull:["$gross","$base"]}},adjustmentLossCents:{$sum:"$adjustmentLoss"}}},{$sort:{_id:1}}],
        designations:[{$match:{confirmed:true}},{$group:{_id:"$designationTitle",records:{$sum:1},baseDonationCents:{$sum:"$base"},grossChargedCents:{$sum:{$ifNull:["$gross","$base"]}}}},{$sort:{baseDonationCents:-1,_id:1}},{$limit:100}]
      }}
    ]);
    const result=rows[0]??{summary:[],providers:[],designations:[]};
    return {timezone:"UTC",range:{from:query.from??null,to:query.to??null},summary:result.summary[0]??emptySummary,providers:result.providers.map((r:Record<string,unknown>)=>({provider:r._id,...r,_id:undefined})),designations:result.designations.map((r:Record<string,unknown>)=>({designation:r._id,...r,_id:undefined}))};
  }
}
