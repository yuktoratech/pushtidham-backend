import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import type { Config } from "../config/env.js";
import type { ImageKind, ImageStorage } from "../services/image-storage.js";
import { AppError } from "../utils/errors.js";
import { inspectImage } from "../utils/image-signature.js";
import { Giving } from "../models/giving.js";
import { Event } from "../models/event.js";
import { GivingCategory } from "../models/giving-category.js";
import { optimizeImage } from "../services/image-optimizer.js";

function parseUpload(maxBytes: number): RequestHandler {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  }).single("image");
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE")
        return next(
          new AppError(
            413,
            "IMAGE_TOO_LARGE",
            `Image must be ${Math.floor(maxBytes / 1024 / 1024)} MiB or smaller`,
          ),
        );
      return next(
        new AppError(400, "INVALID_UPLOAD", "Upload exactly one image file"),
      );
    });
  };
}

export function imageController(config: Config, storage?: ImageStorage) {
  const available: RequestHandler = (_req, _res, next) =>
    storage
      ? next()
      : next(
          new AppError(
            503,
            "IMAGE_STORAGE_UNAVAILABLE",
            "Image uploads are not configured",
          ),
        );
  const upload: RequestHandler = async (req, res) => {
    if (!storage) throw new Error("Image storage guard was not applied");
    if (!req.file)
      throw new AppError(400, "IMAGE_REQUIRED", "Select an image to upload");
    const kind = (req.validated.params as { kind: ImageKind }).kind;
    const inspected = inspectImage(req.file.buffer, req.file.mimetype);
    const optimized = await optimizeImage(req.file.buffer, inspected);
    const context = req.validated.query as {slug?: string; placement?: "cover" | "gallery"};
    const data = await storage.upload(kind, optimized.bytes, optimized.image, req.principal ? String(req.principal.id) : undefined, context);
    res.status(201).json({ success: true, data });
  };
  const remove: RequestHandler = async (req, res) => {
    if (!storage) throw new Error("Image storage guard was not applied");
    const { url } = req.validated.body as { url: string };
    const referenced = await Promise.all([Giving.exists({image:url}), Event.exists({$or:[{image:url},{"gallery.url":url}]}), GivingCategory.exists({image:url})]);
    if (referenced.some(Boolean)) throw new AppError(409, "IMAGE_IN_USE", "Remove saved catalog references before deleting an image");
    const deleted = await storage.deleteManagedUrl(url);
    if (!deleted)
      throw new AppError(409, "IMAGE_RETENTION_REQUIRED", "Images are retained until ownership, references, and rollback eligibility are verified");
    res.status(204).end();
  };
  return {
    available,
    parse: parseUpload(config.PRODUCT_IMAGE_MAX_BYTES),
    upload,
    remove,
  };
}
