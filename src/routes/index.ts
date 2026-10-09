import { Router } from "express";
import { health } from "../controllers/health.js";
import { rateLimit } from "express-rate-limit";
import type { Config } from "../config/env.js";
import { AuthService } from "../services/auth.js";
import { CatalogService } from "../services/catalog.js";
import { DonationService } from "../services/donations.js";
import { authenticate, authorizeRoles } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { authController } from "../controllers/auth.js";
import { catalogController } from "../controllers/catalog.js";
import { donationController } from "../controllers/donations.js";
import { register, login, empty } from "../validators/auth.js";
import { idParams, slugParams, listQuery } from "../validators/common.js";
import {
  givingBody,
  eventBody,
  givingStatus,
  eventStatus,
  givingQuery,
  eventQuery,
} from "../validators/catalog.js";
import {
  onlineBody,
  offlineBody,
  donationQuery,
  statusBody,
  financialReportQuery,
} from "../validators/donation.js";
import { stripeCheckoutBody, paypalOrderBody, paypalCaptureBody, paypalOrderParams } from "../validators/payments.js";
import type { StripeGateway } from "../services/stripe-gateway.js";
import { StripeCheckoutService } from "../services/stripe-checkout.js";
import { StripeEventService } from "../services/stripe-events.js";
import { stripeController } from "../controllers/stripe.js";
import type { PayPalGateway } from "../services/paypal-gateway.js";
import { PayPalOrderService } from "../services/paypal-orders.js";
import { PayPalEventService } from "../services/paypal-events.js";
import { paypalController } from "../controllers/paypal.js";
import { paymentCapabilitiesController } from "../controllers/payment-capabilities.js";
import { financialReportController } from "../controllers/financial-reports.js";
export function routes(
  config: Config,
  dependencies: { stripe?: StripeGateway; paypal?: PayPalGateway } = {},
) {
  const router = Router();
  const auth = new AuthService(config);
  const catalog = new CatalogService();
  const donations = new DonationService();
  const a = authController(auth, config);
  const admin = Router();
  const stripeCheckout = dependencies.stripe
    ? new StripeCheckoutService(config, dependencies.stripe)
    : undefined;
  const stripeEvents = dependencies.stripe
    ? new StripeEventService(dependencies.stripe)
    : undefined;
  const stripe = stripeController(
    config,
    dependencies.stripe,
    stripeCheckout,
    stripeEvents,
  );
  const paypalOrders = dependencies.paypal ? new PayPalOrderService(config, dependencies.paypal) : undefined;
  const paypalEvents = dependencies.paypal && config.PAYPAL_MERCHANT_ID ? new PayPalEventService(dependencies.paypal, config.PAYPAL_MERCHANT_ID) : undefined;
  const paypal = paypalController(config, dependencies.paypal, paypalOrders, paypalEvents);
  router.get("/health", health);
  router.get(
    "/payments/capabilities",
    paymentCapabilitiesController(config, {
      stripe: Boolean(dependencies.stripe),
      paypal: Boolean(dependencies.paypal),
    }),
  );
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication requests",
      },
    },
  });
  router.post(
    "/auth/register",
    limiter,
    validate({ body: register }),
    a.register,
  );
  router.post("/auth/login", limiter, validate({ body: login }), a.login);
  router.post(
    "/auth/refresh",
    limiter,
    a.trusted,
    validate({ body: empty }),
    a.refresh,
  );
  router.post("/auth/logout", a.trusted, validate({ body: empty }), a.logout);
  router.get("/auth/me", authenticate(auth), a.me);
  router.post("/webhooks/stripe", stripe.webhook);
  router.post("/webhooks/paypal", paypal.webhook);
  router.post(
    "/payments/stripe/checkout-sessions",
    authenticate(auth, true),
    validate({ body: stripeCheckoutBody }),
    stripe.create,
  );
  router.get(
    "/payments/attempts/:id/status",
    authenticate(auth, true),
    validate({ params: idParams }),
    stripe.status,
  );
  router.post("/payments/paypal/orders", authenticate(auth, true), validate({ body: paypalOrderBody }), paypal.create);
  router.post("/payments/paypal/orders/:orderId/capture", authenticate(auth, true), validate({ params: paypalOrderParams, body: paypalCaptureBody }), paypal.capture);
  for (const kind of ["giving", "event"] as const) {
    const path = kind === "giving" ? "giving" : "events";
    const c = catalogController(catalog, kind);
    router.get("/" + path, validate({ query: listQuery }), c.list);
    router.get("/" + path + "/:slug", validate({ params: slugParams }), c.get);
    const ac = catalogController(catalog, kind, true);
    admin.get(
      "/" + path,
      validate({ query: kind === "giving" ? givingQuery : eventQuery }),
      ac.list,
    );
    admin.post(
      "/" + path,
      validate({ body: kind === "giving" ? givingBody : eventBody }),
      ac.create,
    );
    admin.get("/" + path + "/:id", validate({ params: idParams }), ac.get);
    admin.put(
      "/" + path + "/:id",
      validate({
        params: idParams,
        body: kind === "giving" ? givingBody : eventBody,
      }),
      ac.replace,
    );
    admin.patch(
      "/" + path + "/:id/status",
      validate({
        params: idParams,
        body: kind === "giving" ? givingStatus : eventStatus,
      }),
      ac.status,
    );
    admin.delete(
      "/" + path + "/:id",
      validate({ params: idParams }),
      ac.remove,
    );
  }
  const d = donationController(donations);
  router.post(
    "/donations",
    authenticate(auth, true),
    validate({ body: onlineBody }),
    d.create,
  );
  router.get(
    "/donations",
    authenticate(auth),
    validate({ query: donationQuery }),
    d.list,
  );
  router.get(
    "/donations/:id",
    authenticate(auth),
    validate({ params: idParams }),
    d.get,
  );
  const ad = donationController(donations, true);
  admin.get("/donations", validate({ query: donationQuery }), ad.list);
  admin.get("/reports/financial", validate({ query: financialReportQuery }), financialReportController());
  admin.post("/donations/offline", validate({ body: offlineBody }), ad.create);
  admin.get("/donations/:id", validate({ params: idParams }), ad.get);
  admin.patch(
    "/donations/:id/status",
    validate({ params: idParams, body: statusBody }),
    ad.status,
  );
  router.use("/admin", authenticate(auth), authorizeRoles("admin"), admin);
  return router;
}
