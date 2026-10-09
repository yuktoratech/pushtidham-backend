import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { loadConfig } from "../src/config/env.js";
import { StripeSdkGateway } from "../src/services/stripe-gateway.js";
import { StripeReconciliationService } from "../src/services/stripe-reconciliation.js";

try {
  const config = loadConfig();
  if (!config.STRIPE_SECRET_KEY)
    throw new Error("STRIPE_SECRET_KEY is required for reconciliation");
  await connectDatabase(config.MONGODB_URI);
  const service = new StripeReconciliationService(
    config,
    new StripeSdkGateway(config.STRIPE_SECRET_KEY, config.STRIPE_API_VERSION),
  );
  const result = await service.run();
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Stripe reconciliation failed");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
