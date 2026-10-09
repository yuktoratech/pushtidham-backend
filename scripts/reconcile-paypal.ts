import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { loadConfig } from "../src/config/env.js";
import { PayPalHttpGateway } from "../src/services/paypal-gateway.js";
import { PayPalReconciliationService } from "../src/services/paypal-reconciliation.js";
const config = loadConfig();
if (!config.PAYPAL_ENABLED) throw new Error("PAYPAL_ENABLED must be true");
try {
  await connectDatabase(config.MONGODB_URI);
  const summary = await new PayPalReconciliationService(config, new PayPalHttpGateway(config)).run();
  console.log(JSON.stringify(summary));
  if (summary.failed) process.exitCode = 1;
} finally { await mongoose.disconnect(); }
