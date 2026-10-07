import type { RequestHandler, CookieOptions } from "express";
import type { Config } from "../config/env.js";
import { AuthService, safeUser } from "../services/auth.js";
import { User } from "../models/user.js";
import { AppError } from "../utils/errors.js";
import type { z } from "zod";
import type { register, login } from "../validators/auth.js";
export function authController(auth: AuthService, config: Config) {
  const cookie: CookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: config.COOKIE_SAME_SITE,
    path: "/api/v1/auth",
  };
  const send = (
    res: Parameters<RequestHandler>[1],
    result: Awaited<ReturnType<AuthService["login"]>>,
    status = 200,
  ) => {
    res.cookie("refresh_token", result.refreshToken, {
      ...cookie,
      expires: result.expiresAt,
    });
    res.setHeader("Cache-Control", "no-store");
    res
      .status(status)
      .json({
        success: true,
        data: { accessToken: result.accessToken, user: result.user },
      });
  };
  const trusted: RequestHandler = (req, _res, next) => {
    if (req.headers.origin !== config.FRONTEND_URL)
      throw new AppError(
        403,
        "UNTRUSTED_ORIGIN",
        "A trusted frontend Origin is required",
      );
    next();
  };
  const handlers: Record<
    "register" | "login" | "refresh" | "logout" | "me",
    RequestHandler
  > = {
    register: async (req, res) =>
      send(
        res,
        await auth.register(req.validated.body as z.infer<typeof register>),
        201,
      ),
    login: async (req, res) =>
      send(res, await auth.login(req.validated.body as z.infer<typeof login>)),
    refresh: async (req, res) => {
      const token = req.cookies?.refresh_token;
      if (typeof token !== "string")
        throw new AppError(401, "UNAUTHENTICATED", "Refresh cookie required");
      send(res, await auth.refresh(token));
    },
    logout: async (req, res) => {
      await auth.logout(
        typeof req.cookies?.refresh_token === "string"
          ? req.cookies.refresh_token
          : undefined,
      );
      res.clearCookie("refresh_token", cookie);
      res.json({ success: true, data: null });
    },
    me: async (req, res) => {
      const user = await User.findById(req.principal!.id);
      if (!user)
        throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      res.json({ success: true, data: safeUser(user) });
    },
  };
  return { ...handlers, trusted };
}
