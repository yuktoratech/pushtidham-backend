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
import { register, login, empty, profile, changePassword, forgotPassword, resetPassword } from "../validators/auth.js";
import {contactBody} from "../validators/contact.js";
import {escapeHtml, type MailSender} from "../services/mail.js";
import {AppError} from "../utils/errors.js";
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
  donationExportQuery,
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
import {ReceiptService} from "../services/receipts.js";
import {exportDonations} from "../services/donation-export.js";
import { imageController } from "../controllers/images.js";
import type { ImageStorage } from "../services/image-storage.js";
import { imageDeleteBody, imageKindParams } from "../validators/catalog.js";
export function routes(
  config: Config,
  dependencies: {
    stripe?: StripeGateway;
    paypal?: PayPalGateway;
    images?: ImageStorage;
    mail?: MailSender;
  } = {},
) {
  const router = Router();
  const auth = new AuthService(config);
  const catalog = new CatalogService(dependencies.images);
  const donations = new DonationService();
  const receipts = new ReceiptService();
  const a = authController(auth, config, dependencies.mail);
  const admin = Router();
  const images = imageController(config, dependencies.images);
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
    // Admin and donor share this login route. All other auth routes remain limited.
    skip: (req) => config.NODE_ENV === "development" && req.path === "/auth/login",
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
  router.patch("/auth/profile", authenticate(auth), authorizeRoles("donor"), validate({body: profile}), a.profile);
  router.post("/auth/change-password", limiter, authenticate(auth), authorizeRoles("donor"), validate({body: changePassword}), a.changePassword);
  router.post("/auth/forgot-password", limiter, validate({body: forgotPassword}), a.forgotPassword);
  router.post("/auth/reset-password", limiter, validate({body: resetPassword}), a.resetPassword);
  const contactLimiter = rateLimit({windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false});
  router.post("/contact", contactLimiter, a.trusted, validate({body: contactBody}), async (req, res) => {
    if (!dependencies.mail || !config.CONTACT_TO) throw new AppError(503, "MAIL_UNAVAILABLE", "Online contact delivery is unavailable");
    const body = req.validated.body as {name: string; email: string; phone: string; subject: string; message: string};
    await dependencies.mail.send({
      to: config.CONTACT_TO,
      replyTo: body.email,
      subject: `Website enquiry: ${body.subject}`,
      text: `From: ${body.name}\nEmail: ${body.email}\nPhone: ${body.phone || "Not provided"}\n\n${body.message}`,
      html: `<p><strong>From:</strong> ${escapeHtml(body.name)}</p><p><strong>Email:</strong> ${escapeHtml(body.email)}</p><p><strong>Phone:</strong> ${escapeHtml(body.phone || "Not provided")}</p><p>${escapeHtml(body.message).replaceAll("\n", "<br>")}</p>`,
    });
    res.status(202).json({success: true, data: null});
  });
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
  admin.post(
    "/uploads/:kind",
    images.available,
    validate({ params: imageKindParams }),
    images.parse,
    images.upload,
  );
  admin.delete(
    "/uploads",
    images.available,
    validate({ body: imageDeleteBody }),
    images.remove,
  );
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
  router.get("/donations/:id/receipt", authenticate(auth), authorizeRoles("donor"), validate({params: idParams}), async (req, res) => {
    const result = await receipts.create((req.validated.params as {id: string}).id, req.principal!.id);
    res.set({"Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${result.filename}"`, "Cache-Control": "no-store"}).send(Buffer.from(result.bytes));
  });
  const ad = donationController(donations, true);
  admin.get("/donations", validate({ query: donationQuery }), ad.list);
  admin.get("/donations/export.csv", validate({query: donationExportQuery}), async (req, res) => exportDonations(req.validated.query as import("../validators/donation.js").DonationExportQuery, res));
  admin.get("/reports/financial", validate({ query: financialReportQuery }), financialReportController());
  admin.post("/donations/offline", validate({ body: offlineBody }), ad.create);
  admin.get("/donations/:id", validate({ params: idParams }), ad.get);
  admin.get("/donations/:id/receipt", validate({params: idParams}), async (req, res) => {
    const result = await receipts.create((req.validated.params as {id: string}).id);
    res.set({"Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${result.filename}"`, "Cache-Control": "no-store"}).send(Buffer.from(result.bytes));
  });
  admin.patch(
    "/donations/:id/status",
    validate({ params: idParams, body: statusBody }),
    ad.status,
  );
  router.use("/admin", authenticate(auth), authorizeRoles("admin"), admin);
  return router;
}
