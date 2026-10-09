import { Types } from "mongoose";
import { PaymentAttempt } from "../models/payment-attempt.js";
import { PaymentAdjustment } from "../models/payment-adjustment.js";

type Row = Record<string, unknown> & { _id: Types.ObjectId };
type Attempt = Record<string, unknown> & { _id: Types.ObjectId; donation: Types.ObjectId };
type Adjustment = Record<string, unknown> & { donation: Types.ObjectId; amountCents: number; type: string; status: string };

function recordKind(row: Row, attempt?: Attempt) {
  if (attempt) return "verified_online";
  if (row.source === "offline") return "offline";
  return row.paymentMethod === "paypal" ? "legacy_paypal" : row.paymentMethod === "bank_transfer" ? "legacy_bank_transfer" : "legacy_online";
}
function lifecycle(row: Row, attempt: Attempt | undefined, adjustments: Adjustment[]) {
  const succeeded = adjustments.filter((a) => a.status === "succeeded");
  if (succeeded.some((a) => a.type === "ach_return")) return "returned";
  if (succeeded.some((a) => a.type === "dispute")) return "disputed";
  const refunds = succeeded.filter((a) => a.type === "refund").reduce((n, a) => n + a.amountCents, 0);
  const gross = Number(attempt?.totalChargeCents ?? row.totalChargedCents ?? row.amountCents);
  if (refunds >= gross && refunds > 0) return "refunded";
  if (refunds > 0) return "partially_refunded";
  if (attempt?.status === "verification_pending") return "verification_required";
  if (attempt?.status) return attempt.status;
  return row.status === "rejected" ? "failed" : row.status;
}
export async function donationViews(rows: Row[], admin: boolean) {
  const ids = rows.map((row) => row._id);
  const [attempts, adjustments] = await Promise.all([
    PaymentAttempt.find({ donation: { $in: ids } }).sort({ createdAt: -1, _id: -1 }).lean() as unknown as Promise<Attempt[]>,
    PaymentAdjustment.find({ donation: { $in: ids } }).sort({ occurredAt: -1, _id: -1 }).lean() as unknown as Promise<Adjustment[]>,
  ]);
  const byDonation = new Map<string, Attempt[]>(), adjustmentMap = new Map<string, Adjustment[]>();
  for (const attempt of attempts) { const key=String(attempt.donation);byDonation.set(key,[...(byDonation.get(key)??[]),attempt]); }
  for (const adjustment of adjustments) { const key=String(adjustment.donation);adjustmentMap.set(key,[...(adjustmentMap.get(key)??[]),adjustment]); }
  return rows.map((row) => {
    const list=byDonation.get(String(row._id))??[];
    const attempt=list.find((item)=>String(item._id)===String(row.confirmedPaymentAttempt))??list[0];
    const changes=adjustmentMap.get(String(row._id))??[];
    const succeeded=changes.filter((item)=>item.status==="succeeded");
    const outflows=succeeded.filter((item)=>["refund","ach_return","dispute"].includes(item.type)).reduce((n,item)=>n+item.amountCents,0);
    const reversals=succeeded.filter((item)=>item.type==="reversal").reduce((n,item)=>n+item.amountCents,0);
    const adjustedLoss=Math.max(0,outflows-reversals);
    const base=Number(attempt?.baseDonationCents??row.amountCents);
    const feeContribution=attempt?Number(attempt.feeContributionCents):typeof row.feeContributionCents==="number"?row.feeContributionCents:null;
    const gross=attempt?Number(attempt.totalChargeCents):typeof row.totalChargedCents==="number"?row.totalChargedCents:null;
    const providerFee=typeof attempt?.actualProviderFeeCents==="number"?attempt.actualProviderFeeCents:typeof row.actualProviderFeeCents==="number"?row.actualProviderFeeCents:null;
    const net=typeof gross==="number"&&typeof providerFee==="number"?gross-providerFee-adjustedLoss:null;
    const common={id:String(row._id),donationNumber:row.donationNumber,type:row.type,designationTitle:row.designationTitle,baseDonationCents:base,feeContributionCents:feeContribution,grossChargedCents:gross,actualProviderFeeCents:providerFee,adjustmentLossCents:adjustedLoss,netProceedsCents:net,currency:row.currency,paymentProvider:attempt?.provider??null,paymentMethod:attempt?.actualFundingSource??attempt?.methodFamily??row.paymentMethod,paymentLifecycle:attempt?.status??null,displayStatus:lifecycle(row,attempt,changes),donationStatus:row.status,recordKind:recordKind(row,attempt),providerVerified:Boolean(attempt&&attempt.status==="succeeded"&&String(row.confirmedPaymentAttempt)===String(attempt._id)),createdAt:row.createdAt,completedAt:row.completedAt};
    return admin?{...common,donor:{name:row.donorName,email:row.donorEmail,phone:row.donorPhone??null},references:{external:row.externalReference??null,bank:row.bankReference??null,offline:row.offlineReference??null,payment:attempt?.paymentId??attempt?.captureId??attempt?.orderId??attempt?.checkoutSessionId??null},adjustments:changes.map(({type,status,amountCents,occurredAt,reasonCode,providerReference})=>({type,status,amountCents,occurredAt,reasonCode:reasonCode??null,providerReference}))}:{...common};
  });
}
