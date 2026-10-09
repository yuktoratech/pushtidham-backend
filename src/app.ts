import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { Config } from "./config/env.js";
import { routes } from "./routes/index.js";
import { errorHandler } from "./middleware/errors.js";
import { AppError } from "./utils/errors.js";
import { log } from "./utils/logger.js";
import type { StripeGateway } from "./services/stripe-gateway.js";
import { StripeSdkGateway } from "./services/stripe-gateway.js";
import { PayPalHttpGateway, type PayPalGateway } from "./services/paypal-gateway.js";
export function createApp(
  config: Config,
  dependencies: { stripe?: StripeGateway; paypal?: PayPalGateway } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    res.setHeader("Cache-Control", "no-store");
    const start = Date.now();
    res.on("finish", () =>
      log("info", "http_request", {
        requestId: req.requestId,
        method: req.method,
        status: res.statusCode,
        durationMs: Date.now() - start,
      }),
    );
    next();
  });
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(
          origin && origin !== config.FRONTEND_URL
            ? new AppError(403, "UNTRUSTED_ORIGIN", "Origin not permitted")
            : null,
          !origin || origin === config.FRONTEND_URL,
        ),
      credentials: true,
    }),
  );
  app.use(
    "/api/v1/webhooks/paypal",
    express.raw({ type: "application/json", limit: "1mb" }),
  );
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      },
    }),
  );
  app.use(
    "/api/v1/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  const stripe =
    dependencies.stripe ??
    (config.STRIPE_SECRET_KEY
      ? new StripeSdkGateway(config.STRIPE_SECRET_KEY, config.STRIPE_API_VERSION)
      : undefined);
  const paypal = dependencies.paypal ?? (config.PAYPAL_ENABLED ? new PayPalHttpGateway(config) : undefined);
  app.use("/api/v1", routes(config, { stripe, paypal }));
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Route not found")),
  );
  app.use(errorHandler);
  return app;
}
