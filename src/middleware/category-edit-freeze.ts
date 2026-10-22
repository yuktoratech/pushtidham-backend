import mongoose from "mongoose";
import type {RequestHandler} from "express";
import {AppError} from "../utils/errors.js";

export const CATEGORY_FREEZE_ID = "category-artwork-v1";

// The migration sets this flag with majority acknowledgement. Every category
// write checks it on the database, so separate updated API instances agree.
export const categoryEditFreeze: RequestHandler = async (_req, _res, next) => {
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database unavailable");
    const flag = await db.collection("migrationflags").findOne(
      {_id: CATEGORY_FREEZE_ID as never},
      {readConcern: {level: "majority"}},
    );
    if (flag?.active === true)
      return next(new AppError(503, "CATEGORY_EDIT_FROZEN", "Category editing is temporarily unavailable"));
    next();
  } catch {
    next(new AppError(503, "CATEGORY_EDIT_CHECK_FAILED", "Category editing is temporarily unavailable"));
  }
};
