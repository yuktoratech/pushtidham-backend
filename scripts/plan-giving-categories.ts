import "dotenv/config";
import {MongoClient} from "mongodb";
import {festivalGroups} from "../src/content/client-catalog.js";

// Read-only migration preparation. This script intentionally has no apply path.
const database = "pushtidham_payment_sandbox";
if (process.env.NODE_ENV !== "development" || process.env.MONGODB_DATABASE !== database || !process.env.MONGODB_URI)
  throw new Error("Expected development and explicit pushtidham_payment_sandbox database");
const categories = [
  {slug: "daily-seva", name: "Daily Seva", legacy: "daily_seva"},
  {slug: "general-donation", name: "General Donation", legacy: "general"},
  ...Object.entries(festivalGroups).map(([legacy, name]) => ({slug: legacy, name, legacy})),
];
const client = new MongoClient(process.env.MONGODB_URI, {serverSelectionTimeoutMS: 10000});
try {
  await client.connect();
  const db = client.db(database);
  const records = await db.collection("givings").find({}, {projection: {title: 1, slug: 1, category: 1, festivalGroup: 1, status: 1, deletedAt: 1}}).toArray();
  const mapping = categories.map(category => ({...category, givings: records.filter(row => category.legacy === "general" ? row.category === "general" : category.legacy === "daily_seva" ? row.category === "daily_seva" : row.festivalGroup === category.legacy).map(row => ({id: String(row._id), slug: row.slug, title: row.title, status: row.status}))}));
  console.log(JSON.stringify({readOnly: true, database, categories, mapping, inactiveUnassigned: records.filter(row => row.status === "inactive" || row.deletedAt).map(row => ({id: String(row._id), slug: row.slug, title: row.title}))}, null, 2));
} finally { await client.close(); }
