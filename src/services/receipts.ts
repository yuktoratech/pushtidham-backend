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
export function amountInWords(cents: number) {
  const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const words = (n: number): string => {
    if (n < 20) return small[n]!;
    if (n < 100) return tens[Math.floor(n / 10)]! + (n % 10 ? `-${small[n % 10]}` : "");
    if (n < 1000) return `${small[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
    return `${words(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${words(n % 1000)}` : ""}`;
  };
  const dollars = Math.floor(cents / 100);
  const text = `${words(dollars)} ${dollars === 1 ? "dollar" : "dollars"} and ${String(cents % 100).padStart(2, "0")}/100`;
  return text[0]!.toUpperCase() + text.slice(1);
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
    const page = pdf.addPage([792, 396]);
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
    const rule = (x: number, y: number, width: number) => page.drawLine({start: {x, y}, end: {x: x + width, y}, thickness: 0.6, color: gold});
    const fitted = (text: string, x: number, y: number, width: number, size = 11, strong = false) => {
      const selected = strong ? bold : font;
      try {selected.encodeText(text);} catch {throw new AppError(422, "RECEIPT_FONT_UNSUPPORTED", "This receipt contains characters that the PDF font cannot render; contact the temple");}
      const actualSize = Math.min(size, width / Math.max(1, selected.widthOfTextAtSize(text, 1)));
      draw(text, x, y, actualSize, strong);
    };
    page.drawRectangle({x: 18, y: 18, width: 756, height: 360, borderColor: gold, borderWidth: 0.8});
    draw("PUSHTIDHAM HAVELI", 34, 347, 19, true, green);
    draw("Pushti Margiya Vaishnav Samaj Inc.", 34, 329, 10, true);
    draw("14080 SW 20th Avenue Road, Ocala, FL 34473", 34, 313, 9);
    draw("Phone: (352) 307-0065  |  Pushtidham2020@yahoo.com", 34, 298, 9);
    draw("Federal ID: 27-2487275", 34, 283, 9);
    draw("DONATION RECEIPT", 540, 348, 12, true, green);
    fitted(row.donationNumber, 540, 328, 215, 12, true);
    draw("Date:", 540, 309, 9, true);
    fitted(formatDate(row.completedAt ?? row.verifiedAt ?? row.createdAt), 571, 309, 182, 9);
    draw("Completed / verified", 540, 289, 9);
    rule(34, 272, 724);

    draw("Received Dollars:", 34, 247, 11, true);
    fitted(amountInWords(row.amountCents), 137, 247, 445, 12);
    rule(137, 241, 445);
    page.drawRectangle({x: 600, y: 234, width: 158, height: 31, borderColor: gold, borderWidth: 0.8});
    fitted(usd(row.amountCents), 612, 244, 134, 16, true);

    // The model does not distinguish cash/cheque/money order for offline records.
    // Leave those unchecked rather than inferring a funding method or reference.
    const options = ["Cash", "Cheque", "Money order", "Card", "Other"];
    const selected = offline ? "Other" : row.paymentMethod === "card" ? "Card" : "Other";
    options.forEach((label, index) => {
      const x = 34 + index * 105;
      page.drawRectangle({x, y: 212, width: 9, height: 9, borderColor: ink, borderWidth: 0.6});
      if (label === selected) {rule(x + 1, 216, 7); page.drawLine({start: {x: x + 4.5, y: 213}, end: {x: x + 4.5, y: 220}, thickness: 0.8, color: ink});}
      draw(label, x + 14, 213, 9);
    });
    fitted(offline ? "Verified offline" : row.paymentMethod.toUpperCase(), 570, 213, 188, 9);

    draw("From:", 34, 185, 11, true);
    fitted(row.donorName, 78, 185, 680, 12);
    rule(78, 179, 680);
    draw("Email:", 34, 156, 10, true);
    fitted(row.donorEmail, 78, 156, 680, 10);
    rule(78, 150, 680);
    draw("Donation For:", 34, 126, 11, true);
    fitted(row.designationTitle, 117, 126, 641, 12);
    rule(117, 120, 641);
    draw("Phone:", 34, 95, 10, true);
    fitted(row.donorPhone || "Not provided", 78, 95, 340, 10);
    rule(78, 89, 340);
    draw("Issued:", 454, 95, 10, true);
    draw("Electronically", 500, 95, 10);
    rule(500, 89, 258);
    draw("Thank You", 34, 58, 12, true, green);
    draw("Jay Shree Krishna", 34, 42, 11, true, green);
    draw("USD | Verified donation acknowledgment", 454, 50, 9);
    return {bytes: await pdf.save(), filename: `${row.donationNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`};
  }
}
