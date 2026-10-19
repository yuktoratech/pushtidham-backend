import "dotenv/config";
import {MongoClient} from "mongodb";
import {buildClientCatalogPlan, type CatalogPlanRecord} from "../src/content/client-catalog.js";

// Deliberately read-only: no apply flag, writes, seed execution or index creation.
if (process.env.NODE_ENV !== "development" || process.env.MONGODB_DATABASE !== "pushtidham_payment_sandbox" || !process.env.MONGODB_URI)
  throw new Error("Expected development and explicit pushtidham_payment_sandbox database");
const client = new MongoClient(process.env.MONGODB_URI, {serverSelectionTimeoutMS: 10000});
try {
  await client.connect();
  const db = client.db("pushtidham_payment_sandbox");
  const records = await db.collection("givings").find({}, {projection: {title: 1, slug: 1, fixedAmountsCents: 1, amountType: 1, category: 1, festivalGroup: 1, displayOrder: 1, status: 1, deletedAt: 1}}).toArray();
  const changes = buildClientCatalogPlan(records as unknown as CatalogPlanRecord[]);
  const counts: Record<string, number> = {};
  for (const name of ["givings", "events", "donations", "users", "paymentattempts", "paymentadjustments", "webhookevents"]) counts[name] = await db.collection(name).countDocuments();
  console.log(JSON.stringify({database: db.databaseName, readOnly: true, changes, retainedIds: records.filter(row => !changes.some(change => change.id === String(row._id))).map(row => String(row._id)), countsBefore: counts, countsAfterApproval: {...counts, givings: counts.givings! + changes.filter(row => row.action === "create").length}, deactivations: [], historicalDonations: "No changes"}, null, 2));
} finally {await client.close();}
