import {PDFDocument, StandardFonts, rgb} from "pdf-lib";
import {Types} from "mongoose";
import {Donation} from "../models/donation.js";
import {PaymentAttempt} from "../models/payment-attempt.js";
import {PaymentAdjustment} from "../models/payment-adjustment.js";
import {AppError, missing} from "../utils/errors.js";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", {dateStyle: "long", timeZone: "America/New_York"}).format(value);
}
function usd(cents: number) {
  return new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(cents / 100);
}
export class ReceiptService {
  async create(id: string, userId?: Types.ObjectId) {
    const row = await Donation.findOne({_id: id, ...(userId ? {user: userId} : {})}).lean();
    if (!row) missing("Donation");
    if (row.status !== "completed") throw new AppError(409, "RECEIPT_NOT_ELIGIBLE", "A receipt is available only for a verified completed donation");
    const offline = row.source === "offline" && Boolean(row.verifiedAt && row.verifiedBy);
    let online = false;
    if (row.source === "online" && row.confirmedPaymentAttempt) {
      const attempt = await PaymentAttempt.findOne({_id: row.confirmedPaymentAttempt, donation: row._id, status: "succeeded"}).lean();
      online = Boolean(attempt);
    }
    if (!offline && !online) throw new AppError(409, "RECEIPT_NOT_ELIGIBLE", "Payment verification is required before issuing a receipt");
    if (await PaymentAdjustment.exists({donation: row._id, status: "succeeded", type: {$in: ["refund", "ach_return", "dispute"]}}))
      throw new AppError(409, "RECEIPT_REVIEW_REQUIRED", "This donation has an adjustment; contact the temple for an updated acknowledgment");
    const pdf = await PDFDocument.create();
    pdf.setTitle(`Donation acknowledgment ${row.donationNumber}`);
    pdf.setAuthor("Pushti Margiya Vaishnav Samaj Inc.");
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const green = rgb(0.08, 0.32, 0.22);
    const gold = rgb(0.68, 0.49, 0.20);
    const ink = rgb(0.15, 0.18, 0.15);
    const draw = (text: string, x: number, y: number, size = 11, strong = false, color = ink) => {
      const selected = strong ? bold : font;
      try {selected.encodeText(text);} catch {throw new AppError(422, "RECEIPT_FONT_UNSUPPORTED", "This receipt contains characters that the PDF font cannot render; contact the temple");}
      page.drawText(text, {x, y, size, font: selected, color});
    };
    page.drawRectangle({x: 0, y: 688, width: 612, height: 104, color: green});
    draw("PUSHTIDHAM HAVELI", 48, 742, 22, true, rgb(1, 1, 1));
    draw("Pushti Margiya Vaishnav Samaj Inc.", 49, 717, 10, false, rgb(1, 1, 1));
    draw("DONATION ACKNOWLEDGMENT", 48, 643, 16, true, green);
    page.drawLine({start: {x: 48, y: 628}, end: {x: 564, y: 628}, thickness: 1.5, color: gold});
    const lines: Array<[string, string]> = [
      ["Reference", row.donationNumber],
      ["Date", formatDate(row.completedAt ?? row.verifiedAt ?? row.createdAt)],
      ["Donor", row.donorName],
      ["Email", row.donorEmail],
      ["Purpose", row.designationTitle],
      ["Donation category", row.type === "event" ? "Event" : "General / Giving"],
      ["Payment", offline ? "Verified offline donation" : "Provider-verified online donation"],
      ["Amount", usd(row.amountCents)],
      ["Currency", "USD"],
      ["Status", "Completed / verified"],
    ];
    let y = 593;
    for (const [label, value] of lines) {
      draw(label, 48, y, 10, true, green);
      draw(value, 204, y, 11);
      y -= 38;
    }
    page.drawLine({start: {x: 48, y: 175}, end: {x: 564, y: 175}, thickness: 0.7, color: gold});
    draw("Thank you for supporting seva and community activities.", 48, 151, 10);
    draw("14080 SW 20th Avenue Road, Ocala, FL 34473 | 352-307-0065", 48, 115, 9);
    draw("This acknowledgment records the verified donation shown above.", 48, 91, 9);
    return {bytes: await pdf.save(), filename: `${row.donationNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`};
  }
}
