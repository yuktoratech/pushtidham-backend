import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { loadConfig } from "../src/config/env.js";
import { Event } from "../src/models/event.js";

const target = {
  environment: "development",
  protocol: "mongodb:",
  host: "127.0.0.1",
  port: "27018",
  database: "pushtidham_payment_sandbox",
  replicaSet: "pushtidhamPaymentRs",
} as const;

const location = "Tentative venue: Pushtidham Haveli, Ocala, Florida";
const records = [
  {
    title: "Holi & Dolotsav",
    slug: "holi-dolotsav-tentative-2027",
    startsAt: "2027-03-22T10:00:00-04:00",
    endsAt: "2027-03-22T12:00:00-04:00",
    image: "/images/festivals/holi.svg",
    shortDescription:
      "Tentative schedule for planning only. Temple confirmation is required. A joyful spring observance centered on Shri Krishna, color, kirtan and festive seva.",
    description:
      "This client-demonstration listing presents Holi and Dolotsav as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Hindola Utsav",
    slug: "hindola-utsav-tentative-2027",
    startsAt: "2027-07-18T10:00:00-04:00",
    endsAt: "2027-07-18T12:00:00-04:00",
    image: "/images/festivals/hindola.svg",
    shortDescription:
      "Tentative schedule for planning only. Temple confirmation is required. Hindola celebrates loving seasonal seva through a beautifully decorated swing for Thakorji.",
    description:
      "This client-demonstration listing presents Hindola Utsav as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Shri Krishna Janmashtami",
    slug: "shri-krishna-janmashtami-tentative-2027",
    startsAt: "2027-08-25T10:00:00-04:00",
    endsAt: "2027-08-25T12:00:00-04:00",
    image: "/images/festivals/janmashtami.svg",
    shortDescription:
      "Tentative schedule for planning only. Temple confirmation is required. Janmashtami honors the divine appearance of Shri Krishna through remembrance and seva.",
    description:
      "This client-demonstration listing presents Shri Krishna Janmashtami as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Nand Mahotsav",
    slug: "nand-mahotsav-tentative-2027",
    startsAt: "2027-08-26T10:00:00-04:00",
    endsAt: "2027-08-26T12:00:00-04:00",
    image: "/images/festivals/nand-mahotsav.svg",
    shortDescription:
      "Tentative schedule for planning only. Temple confirmation is required. Nand Mahotsav continues the joy of Janmashtami and Shri Krishna’s arrival in Nanda and Yashoda’s home.",
    description:
      "This client-demonstration listing presents Nand Mahotsav as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
  {
    title: "Annakut & Govardhan Puja",
    slug: "annakut-govardhan-puja-tentative-2027",
    startsAt: "2027-10-30T10:00:00-04:00",
    endsAt: "2027-10-30T12:00:00-04:00",
    image: "/images/festivals/annakut.svg",
    shortDescription:
      "Tentative schedule for planning only. Temple confirmation is required. Annakut expresses gratitude through bhog and remembrance of Shri Krishna as Govardhandhar.",
    description:
      "This client-demonstration listing presents Annakut and Govardhan Puja as a tentative planning entry, not a confirmed Pushtidham Haveli announcement. Final date, time, program and participation details must be approved by the temple before public use.",
  },
] as const;

const protectedCollections = [
  "users",
  "givings",
  "donations",
  "paymentattempts",
  "paymentadjustments",
  "webhookevents",
] as const;

function refuse(message: string): never {
  throw new Error(`Tentative Event seed refused: ${message}`);
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
    shortDescription: string;
    description: string;
    startsAt: Date;
    endsAt?: Date | null;
    location: string;
    image: string;
    status: string;
    deletedAt?: Date | null;
  },
  expected: (typeof records)[number],
) {
  return (
    record.title === expected.title &&
    record.slug === expected.slug &&
    record.shortDescription === expected.shortDescription &&
    record.description === expected.description &&
    record.startsAt.toISOString() === new Date(expected.startsAt).toISOString() &&
    record.endsAt?.toISOString() === new Date(expected.endsAt).toISOString() &&
    record.location === location &&
    record.image === expected.image &&
    record.status === "published" &&
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

  await Event.init();
  const before = await protectedCounts();
  let created = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const expected of records) {
        const existing = await Event.findOne({
          $or: [{ slug: expected.slug }, { title: expected.title }],
        })
          .session(session)
          .lean();
        if (existing) {
          if (!matches(existing, expected))
            refuse(`conflicting existing record for ${expected.slug}`);
          continue;
        }
        await Event.create(
          [
            {
              ...expected,
              startsAt: new Date(expected.startsAt),
              endsAt: new Date(expected.endsAt),
              location,
              status: "published",
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
        events: { created, retained: records.length - created },
        protectedCollections: after,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Tentative Event seed failed safely");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
