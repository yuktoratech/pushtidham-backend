import type { RequestHandler } from "express";
import { AuthService } from "../services/auth.js";
import { AppError } from "../utils/errors.js";
export function authenticate(
  auth: AuthService,
  optional = false,
): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header && optional) {
      next();
      return;
    }
    if (!header?.startsWith("Bearer "))
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    req.principal = await auth.authenticate(header.slice(7));
    next();
  };
}
export function authorizeRoles(
  ...roles: Array<"donor" | "admin">
): RequestHandler {
  return (req, _res, next) => {
    if (!req.principal || !roles.includes(req.principal.role))
      throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    next();
  };
}
export const authorizeCategoryManager: RequestHandler = (req, _res, next) => {
  if (req.principal?.role !== "admin" || req.principal.canManageGivingCategories !== true)
    throw new AppError(403, "FORBIDDEN", "Category management requires developer authorization");
  next();
};
