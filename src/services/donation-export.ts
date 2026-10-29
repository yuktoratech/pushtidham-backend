import type {Response} from "express";
import {once} from "node:events";
import {Donation} from "../models/donation.js";
import {AppError} from "../utils/errors.js";
import type {DonationExportQuery} from "../validators/donation.js";
import {donationFilter} from "./donations.js";
import {donationViews} from "./donation-views.js";
import {donationStatusStages} from './donation-status.js';

const maxRows = 10000;
function csv(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^\s*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
function date(value: unknown) {
  return new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short"}).format(new Date(String(value)));
}
function amount(cents: number | null) {return cents === null ? "" : (cents / 100).toFixed(2);}
export async function exportDonations(query: DonationExportQuery, res: Response) {
  const filter = donationFilter(query);
  const providerMatch = query.provider ? [
    {$set: {exportProviderClass: {$cond: [{$gt: [{$size: "$_statusAttempts"}, 0]}, '$_statusAttempt.provider', {$cond: [{$eq: ["$source", "offline"]}, "offline", {$concat: ["legacy_", "$paymentMethod"]}]}]}}},
    {$match: {exportProviderClass: query.provider}},
  ] : [];
  const pipeline = [{$match: filter}, ...(query.status || query.provider ? donationStatusStages() : []), ...(query.status ? [{$match: {_displayStatus: query.status}}] : []), ...providerMatch];
  const counts = await Donation.aggregate([...pipeline, {$count: "count"}]);
  const count = Number(counts[0]?.count ?? 0);
  if (count > maxRows) throw new AppError(413, "EXPORT_TOO_LARGE", `Narrow the filters to ${maxRows} records or fewer`);
  res.status(200).set({"Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="pushtidham-donations.csv"', "Cache-Control": "no-store"});
  const write = async (line: string) => {if (!res.write(line) && !res.destroyed) await once(res, "drain");};
  await write("Donation reference,Date (America/New_York),Donor name,Donor email,Category,Purpose,Donation purpose,Base donation USD,Gross charged USD,Status,Payment method,Record class,Festival,Donation option,Offline payment method\r\n");
  let totalBase = 0, totalCompletedBase = 0, exported = 0;
  const cursor = Donation.aggregate([...pipeline, {$sort: {createdAt: -1, _id: -1}}]).cursor({batchSize: 250});
  let batch: Array<Record<string, unknown> & {_id: import("mongoose").Types.ObjectId}> = [];
  const flush = async () => {
    if (!batch.length) return;
    const views = await donationViews(batch, true);
    for (const row of views) {
      if (res.destroyed) break;
      totalBase += row.baseDonationCents;
      if (row.displayStatus === "completed") totalCompletedBase += row.baseDonationCents;
      exported++;
      const donor = "donor" in row ? row.donor : {name: "", email: ""};
      await write([row.donationNumber, date(row.donationDate ?? row.createdAt), donor.name, donor.email, row.type === "event" ? "Event" : "General", row.designationTitle, row.donationPurpose, amount(row.baseDonationCents), amount(row.grossChargedCents), row.displayStatus, row.paymentMethod, row.recordKind, row.festivalTitle, row.donationOptionTitle, row.offlinePaymentMethod].map(csv).join(",") + "\r\n");
    }
    batch = [];
  };
  try {
    for await (const row of cursor) {
      if (res.destroyed) break;
      batch.push(row as typeof batch[number]);
      if (batch.length >= 250) await flush();
    }
    await flush();
    if (!res.destroyed) {
      await write(["TOTAL ALL BASE", "", "", "", "", `${exported} records`, "", amount(totalBase)].map(csv).join(",") + "\r\n");
      await write(["TOTAL COMPLETED BASE", "", "", "", "", "", "", amount(totalCompletedBase)].map(csv).join(",") + "\r\n");
      res.end();
    }
  } finally {await cursor.close();}
}
