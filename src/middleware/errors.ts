import type { ErrorRequestHandler } from "express";
import { AppError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res
      .status(err.status)
      .json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
    return;
  }
  if (err?.code === 11000) {
    res
      .status(409)
      .json({
        success: false,
        error: {
          code: "CONFLICT",
          message: "A record with this unique value already exists",
        },
      });
    return;
  }
  if (err?.type === "entity.too.large") {
    res
      .status(413)
      .json({
        success: false,
        error: { code: "BODY_TOO_LARGE", message: "Request body too large" },
      });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res
      .status(400)
      .json({
        success: false,
        error: { code: "INVALID_JSON", message: "Invalid JSON" },
      });
    return;
  }
  if (err?.name === "ValidationError" || err?.name === "CastError") {
    res
      .status(400)
      .json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid resource data" },
      });
    return;
  }
  log("error", "request_failed", { requestId: req.requestId });
  res
    .status(500)
    .json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    });
};
