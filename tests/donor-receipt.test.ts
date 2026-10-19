import {before, after, test, mock} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import mongoose, {Types} from "mongoose";
import {MongoMemoryServer} from "mongodb-memory-server";
import request from "supertest";
import {PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream} from "pdf-lib";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";
import {AuthService} from "../src/services/auth.js";
import {AppError} from "../src/utils/errors.js";
import {Donation} from "../src/models/donation.js";
import {amountInWords} from "../src/services/receipts.js";

const owner = new Types.ObjectId(), other = new Types.ObjectId(), admin = new Types.ObjectId();
const config = loadConfig({NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1/unused", FRONTEND_URL: "http://localhost:3000", JWT_ACCESS_SECRET: randomBytes(40).toString("hex"), JWT_REFRESH_SECRET: randomBytes(40).toString("hex")});
const app = createApp(config);
let mongo: MongoMemoryServer;
let completedId: string;
const ineligible: string[] = [];
const reference = "TEST-OWNER-RECEIPT";
const completedAt = new Date("2026-10-01T12:00:00Z");

before(async () => {
  mongo = await MongoMemoryServer.create();
  assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
  await mongoose.connect(mongo.getUri(), {dbName: "isolated_donor_receipt_fixtures"});
  mock.method(AuthService.prototype, "authenticate", async (token: string) => {
    if (token === "fixture-owner") return {id: owner, role: "donor" as const, sessionId: "fixture"};
    if (token === "fixture-other") return {id: other, role: "donor" as const, sessionId: "fixture"};
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  });
  const base = {user: owner, donorName: "Receipt Fixture Donor", donorEmail: "receipt@example.test", type: "general", giving: new Types.ObjectId(), designationTitle: "TEST Mangla Seva", amountCents: 8400, currency: "USD", paymentMethod: "offline", source: "offline"} as const;
  completedId = (await Donation.create({...base, donationNumber: reference, status: "completed", verifiedBy: admin, verifiedAt: completedAt, completedAt})).id;
  for (const status of ["pending", "rejected", "completed"] as const) {
    ineligible.push((await Donation.create({...base, donationNumber: `TEST-INELIGIBLE-${status}`, status})).id);
  }
});
after(async () => {
  mock.restoreAll();
  await mongoose.disconnect();
  await mongo?.stop();
});

test("authenticated fixture owner downloads a PDF containing their reference, amount, date and donor details", async () => {
  const response = await request(app).get(`/api/v1/donations/${completedId}/receipt`).set("Authorization", "Bearer fixture-owner");
  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-type"]), /application\/pdf/);
  assert.equal(Buffer.from(response.body).subarray(0, 4).toString(), "%PDF");
  const pdf = await PDFDocument.load(response.body);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPages()[0]!.getSize(), {width: 792, height: 396});
  const contents = pdf.getPages()[0]!.node.Contents();
  assert.ok(contents instanceof PDFArray);
  let text = "";
  for (let i = 0; i < contents.size(); i++) {
    const stream = pdf.context.lookup(contents.get(i));
    assert.ok(stream instanceof PDFRawStream);
    const operators = Buffer.from(decodePDFRawStream(stream).decode()).toString();
    for (const match of operators.matchAll(/<([0-9a-f]+)>\s*Tj/gi)) text += Buffer.from(match[1]!, "hex").toString("latin1") + "\n";
  }
  for (const expected of [reference, "$84.00", "October 1, 2026", "Receipt Fixture Donor", "receipt@example.test", "TEST Mangla Seva", "Eighty-four dollars and 00/100", "Donation For:", "Federal ID: 27-2487275"]) assert.ok(text.includes(expected), `PDF missing ${expected}`);
});

test("receipt amounts in words preserve dollars and cents", () => {
  assert.equal(amountInWords(25100), "Two hundred fifty-one dollars and 00/100");
  assert.equal(amountInWords(101), "One dollar and 01/100");
  assert.equal(amountInWords(1000000), "Ten thousand dollars and 00/100");
});

test("a different authenticated fixture donor cannot download the owner's receipt", async () => {
  const response = await request(app).get(`/api/v1/donations/${completedId}/receipt`).set("Authorization", "Bearer fixture-other");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "NOT_FOUND");
  assert.ok(!JSON.stringify(response.body).includes(reference));
});

test("pending, rejected and unverified completed donations cannot issue paid receipts", async () => {
  for (const id of ineligible) {
    const response = await request(app).get(`/api/v1/donations/${id}/receipt`).set("Authorization", "Bearer fixture-owner");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "RECEIPT_NOT_ELIGIBLE");
  }
});

test("receipt API still requires authentication", async () => {
  assert.equal((await request(app).get(`/api/v1/donations/${completedId}/receipt`)).status, 401);
});
