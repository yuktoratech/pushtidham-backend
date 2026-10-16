import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { loadConfig } from "../src/config/env.js";
import { Event } from "../src/models/event.js";
import { Giving } from "../src/models/giving.js";

const target = {
  environment: "development",
  host: "pushtidham-dev.p6lbrfc.mongodb.net",
  database: "pushtidham_payment_sandbox",
} as const;

const givingDescription = "Official seva amount published by Pushtidham Haveli.";
const givingRecords = [
  { title: "Mangla Seva", slug: "mangla-seva", amount: 8400, order: 10 },
  { title: "Palna Seva", slug: "palna-seva", amount: 15100, order: 20 },
  { title: "Silver Palna Seva", slug: "silver-palna-seva", amount: 20100, order: 30 },
  { title: "Gold Palna Seva", slug: "gold-palna-seva", amount: 25000, order: 40 },
  { title: "Rajbhog Seva", slug: "rajbhog-seva", amount: 30100, order: 50 },
  { title: "Shayan Seva", slug: "shayan-seva", amount: 10100, order: 60 },
  { title: "Whole Day Manorathi", slug: "whole-day-manorathi", amount: 40100, order: 70 },
] as const;

const eventLocation = "Tentative venue: Pushtidham Haveli, Ocala, Florida";
const eventRecords = [
  {
    title: "Holi & Dolotsav",
    slug: "holi-dolotsav-tentative-2027",
    startsAt: "2027-03-22T10:00:00-04:00",
    endsAt: "2027-03-22T12:00:00-04:00",
    image: "/images/festivals/holi.svg",
    shortDescription: "Tentative schedule for planning only. Temple confirmation is required. A joyful spring observance centered on Shri Krishna, color, kirtan and festive seva.",
    description: "This client-demonstration listing presents Holi and Dolotsav as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Hindola Utsav",
    slug: "hindola-utsav-tentative-2027",
    startsAt: "2027-07-18T10:00:00-04:00",
    endsAt: "2027-07-18T12:00:00-04:00",
    image: "/images/festivals/hindola.svg",
    shortDescription: "Tentative schedule for planning only. Temple confirmation is required. Hindola celebrates loving seasonal seva through a beautifully decorated swing for Thakorji.",
    description: "This client-demonstration listing presents Hindola Utsav as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Shri Krishna Janmashtami",
    slug: "shri-krishna-janmashtami-tentative-2027",
    startsAt: "2027-08-25T10:00:00-04:00",
    endsAt: "2027-08-25T12:00:00-04:00",
    image: "/images/festivals/janmashtami.svg",
    shortDescription: "Tentative schedule for planning only. Temple confirmation is required. Janmashtami honors the divine appearance of Shri Krishna through remembrance and seva.",
    description: "This client-demonstration listing presents Shri Krishna Janmashtami as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Nand Mahotsav",
    slug: "nand-mahotsav-tentative-2027",
    startsAt: "2027-08-26T10:00:00-04:00",
    endsAt: "2027-08-26T12:00:00-04:00",
    image: "/images/festivals/nand-mahotsav.svg",
    shortDescription: "Tentative schedule for planning only. Temple confirmation is required. Nand Mahotsav continues the joy of Janmashtami and Shri Krishna’s arrival in Nanda and Yashoda’s home.",
    description: "This client-demonstration listing presents Nand Mahotsav as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Annakut & Govardhan Puja",
    slug: "annakut-govardhan-puja-tentative-2027",
    startsAt: "2027-10-30T10:00:00-04:00",
    endsAt: "2027-10-30T12:00:00-04:00",
    image: "/images/festivals/annakut.svg",
    shortDescription: "Tentative schedule for planning only. Temple confirmation is required. Annakut expresses gratitude through bhog and remembrance of Shri Krishna as Govardhandhar.",
    description: "This client-demonstration listing presents Annakut and Govardhan Puja as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
] as const;

const protectedCollections = [
  "users", "sessions", "donations", "paymentattempts", "paymentadjustments", "webhookevents",
] as const;

function refuse(message: string): never {
  throw new Error(`Atlas catalog seed refused: ${message}`);
}

async function counts() {
  const db = mongoose.connection.db!;
  return Object.fromEntries(await Promise.all(protectedCollections.map(async name => [name, await db.collection(name).countDocuments({})])));
}

try {
  const config = loadConfig();
  const uri = new URL(config.MONGODB_URI);
  if (
    config.NODE_ENV !== target.environment ||
    uri.protocol !== "mongodb+srv:" ||
    uri.hostname !== target.host ||
    config.MONGODB_DATABASE !== target.database
  ) refuse("configured target is not the authorized Atlas development database");

  await connectDatabase(config.MONGODB_URI);
  const db = mongoose.connection.db!;
  if (db.databaseName !== target.database) refuse("connected database identity does not match authorization");

  await Giving.init();
  await Event.init();
  const before = await counts();
  let givingCreated = 0;
  let eventCreated = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const expected of givingRecords) {
        const existing = await Giving.findOne({ $or: [{ slug: expected.slug }, { title: expected.title }] }).session(session).lean();
        if (existing) {
          const matches = existing.title === expected.title && existing.slug === expected.slug && existing.description === givingDescription && existing.amountType === "fixed" && existing.fixedAmountsCents.length === 1 && existing.fixedAmountsCents[0] === expected.amount && existing.status === "active" && existing.displayOrder === expected.order && !existing.deletedAt;
          if (!matches) refuse(`conflicting Giving record for ${expected.slug}`);
          continue;
        }
        await Giving.create([{ title: expected.title, slug: expected.slug, description: givingDescription, amountType: "fixed", fixedAmountsCents: [expected.amount], status: "active", displayOrder: expected.order }], { session });
        givingCreated++;
      }
      for (const expected of eventRecords) {
        const existing = await Event.findOne({ $or: [{ slug: expected.slug }, { title: expected.title }] }).session(session).lean();
        if (existing) {
          const matches = existing.title === expected.title && existing.slug === expected.slug && existing.shortDescription === expected.shortDescription && existing.description === expected.description && existing.startsAt.toISOString() === new Date(expected.startsAt).toISOString() && existing.endsAt?.toISOString() === new Date(expected.endsAt).toISOString() && existing.location === eventLocation && existing.image === expected.image && existing.status === "published" && !existing.deletedAt;
          if (!matches) refuse(`conflicting Event record for ${expected.slug}`);
          continue;
        }
        await Event.create([{ ...expected, startsAt: new Date(expected.startsAt), endsAt: new Date(expected.endsAt), location: eventLocation, status: "published" }], { session });
        eventCreated++;
      }
    });
  } finally {
    await session.endSession();
  }
  const after = await counts();
  if (JSON.stringify(before) !== JSON.stringify(after)) refuse("a protected collection changed unexpectedly");
  console.log(JSON.stringify({ database: target.database, giving: { created: givingCreated, retained: givingRecords.length - givingCreated }, events: { created: eventCreated, retained: eventRecords.length - eventCreated }, protectedCollections: after }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Atlas catalog seed failed safely");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
