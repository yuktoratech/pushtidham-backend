import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { loadConfig } from "../src/config/env.js";
import { Giving } from "../src/models/giving.js";

const target = {
  environment: "development",
  protocol: "mongodb:",
  host: "127.0.0.1",
  port: "27018",
  database: "pushtidham_payment_sandbox",
  replicaSet: "pushtidhamPaymentRs",
} as const;

const description = "Official seva amount published by Pushtidham Haveli.";
const records = [
  { title: "Mangla Seva", slug: "mangla-seva", amount: 8400, order: 10 },
  { title: "Palna Seva", slug: "palna-seva", amount: 15100, order: 20 },
  { title: "Silver Palna Seva", slug: "silver-palna-seva", amount: 20100, order: 30 },
  { title: "Gold Palna Seva", slug: "gold-palna-seva", amount: 25000, order: 40 },
  { title: "Rajbhog Seva", slug: "rajbhog-seva", amount: 30100, order: 50 },
  { title: "Shayan Seva", slug: "shayan-seva", amount: 10100, order: 60 },
  {
    title: "Whole Day Manorathi",
    slug: "whole-day-manorathi",
    amount: 40100,
    order: 70,
  },
] as const;

const protectedCollections = [
  "users",
  "events",
  "donations",
  "paymentattempts",
  "paymentadjustments",
  "webhookevents",
] as const;

function refuse(message: string): never {
  throw new Error(`Official Giving seed refused: ${message}`);
}

function assertTarget(uri: string, environment: string) {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    refuse("invalid MongoDB URI");
  }
  if (
    environment !== target.environment ||
    parsed.protocol !== target.protocol ||
    parsed.hostname !== target.host ||
    parsed.port !== target.port ||
    parsed.pathname !== `/${target.database}` ||
    parsed.searchParams.get("replicaSet") !== target.replicaSet
  )
    refuse("configured database is not the authorized local development target");
}

function matches(
  record: {
    title: string;
    slug: string;
    description: string;
    amountType: string;
    fixedAmountsCents: number[];
    status: string;
    displayOrder: number;
    deletedAt?: Date | null;
  },
  expected: (typeof records)[number],
) {
  return (
    record.title === expected.title &&
    record.slug === expected.slug &&
    record.description === description &&
    record.amountType === "fixed" &&
    record.fixedAmountsCents.length === 1 &&
    record.fixedAmountsCents[0] === expected.amount &&
    record.status === "active" &&
    record.displayOrder === expected.order &&
    !record.deletedAt
  );
}

async function protectedCounts() {
  const db = mongoose.connection.db!;
  return Object.fromEntries(
    await Promise.all(
      protectedCollections.map(async (name) => [
        name,
        await db.collection(name).countDocuments({}),
      ]),
    ),
  );
}

try {
  const config = loadConfig();
  assertTarget(config.MONGODB_URI, config.NODE_ENV);
  await connectDatabase(config.MONGODB_URI);
  const db = mongoose.connection.db!;
  const hello = (await db.admin().command({ hello: 1 })) as {
    setName?: string;
    isWritablePrimary?: boolean;
  };
  if (
    db.databaseName !== target.database ||
    hello.setName !== target.replicaSet ||
    hello.isWritablePrimary !== true
  )
    refuse("connected database or replica-set identity does not match authorization");

  await Giving.init();
  const before = await protectedCounts();
  let created = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const expected of records) {
        const existing = await Giving.findOne({
          $or: [{ slug: expected.slug }, { title: expected.title }],
        })
          .session(session)
          .lean();
        if (existing) {
          if (!matches(existing, expected))
            refuse(`conflicting existing record for ${expected.slug}`);
          continue;
        }
        await Giving.create(
          [
            {
              title: expected.title,
              slug: expected.slug,
              description,
              amountType: "fixed",
              fixedAmountsCents: [expected.amount],
              status: "active",
              displayOrder: expected.order,
            },
          ],
          { session },
        );
        created++;
      }
    });
  } finally {
    await session.endSession();
  }

  const after = await protectedCounts();
  if (JSON.stringify(before) !== JSON.stringify(after))
    refuse("a protected collection changed unexpectedly");
  console.log(
    JSON.stringify(
      {
        target: `${target.host}:${target.port}/${target.database}`,
        replicaSet: target.replicaSet,
        givings: { created, retained: records.length - created },
        protectedCollections: after,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Official Giving seed failed safely");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
