import type { RequestHandler } from "express";
import mongoose from "mongoose";
export const health: RequestHandler = (_req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res
      .status(503)
      .json({
        success: false,
        error: { code: "DATABASE_UNAVAILABLE", message: "Service unavailable" },
      });
    return;
  }
  res.json({ success: true, data: { status: "ok" } });
};
