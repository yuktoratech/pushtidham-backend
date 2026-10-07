import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../utils/errors.js";
export function validate(
  schemas: Partial<Record<"body" | "params" | "query", ZodType>>,
): RequestHandler {
  return (req, _res, next) => {
    req.validated = {};
    for (const key of ["body", "params", "query"] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (!result.success)
        return next(
          new AppError(
            400,
            "VALIDATION_ERROR",
            "Invalid request",
            result.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          ),
        );
      req.validated[key] = result.data;
    }
    next();
  };
}
