import mongoose from "mongoose";
import { loadConfig } from "../src/config/env.js";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/models/user.js";
import { Session } from "../src/models/session.js";
import { Giving } from "../src/models/giving.js";
import { Event } from "../src/models/event.js";
import { Donation } from "../src/models/donation.js";
import { PaymentAttempt } from "../src/models/payment-attempt.js";
import { WebhookEvent } from "../src/models/webhook-event.js";
import { PaymentAdjustment } from "../src/models/payment-adjustment.js";
try {
  await connectDatabase(loadConfig().MONGODB_URI);
  for (const model of [
    User,
    Session,
    Giving,
    Event,
    Donation,
    PaymentAttempt,
    WebhookEvent,
    PaymentAdjustment,
  ])
    await model.createIndexes();
  console.log("Required indexes created; no indexes dropped");
} catch {
  console.error(
    "Index creation failed; check database access and existing duplicate records",
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
