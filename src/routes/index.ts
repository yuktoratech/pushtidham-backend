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
} from "../validators/donation.js";
export function routes(config: Config) {
  const router = Router();
  const auth = new AuthService(config);
  const catalog = new CatalogService();
  const donations = new DonationService();
  const a = authController(auth, config);
  const admin = Router();
  router.get("/health", health);
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
