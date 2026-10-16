import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { optimizeImage } from "../src/services/image-optimizer.js";
import type { SupportedImage } from "../src/utils/image-signature.js";

const kinds = {
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  png: { contentType: "image/png", extension: "png" },
  webp: { contentType: "image/webp", extension: "webp" },
} as const satisfies Record<string, SupportedImage>;

function pixels(width: number, height: number, alpha = false) {
  const channels = alpha ? 4 : 3;
  const bytes = Buffer.alloc(width * height * channels);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  if (alpha)
    for (let index = 3; index < bytes.length; index += 4)
      bytes[index] = index % 8 === 3 ? 64 : 220;
  return { bytes, channels };
}

async function fixture(
  format: keyof typeof kinds,
  width = 800,
  height = 600,
  alpha = false,
) {
  const source = pixels(width, height, alpha);
  const pipeline = sharp(source.bytes, {
    raw: { width, height, channels: source.channels as 3 | 4 },
  });
  if (format === "jpeg") return pipeline.jpeg({ quality: 100 }).toBuffer();
  if (format === "png") return pipeline.png({ compressionLevel: 3 }).toBuffer();
  return pipeline.webp({ quality: 100 }).toBuffer();
}

test("JPEG, PNG and WebP inputs produce metadata-free WebP at quality-safe sizes", async () => {
  const measurements: Record<string, { before: number; after: number; reductionPercent: number }> = {};
  for (const format of ["jpeg", "png", "webp"] as const) {
    const original = await fixture(format);
    const optimized = await optimizeImage(original, kinds[format]);
    const metadata = await sharp(optimized.bytes).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 800);
    assert.equal(metadata.height, 600);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(optimized.image.contentType, "image/webp");
    assert.equal(optimized.image.extension, "webp");
    assert.ok(optimized.bytes.length < original.length);
    measurements[format] = {
      before: original.length,
      after: optimized.bytes.length,
      reductionPercent: Number((100 * (1 - optimized.bytes.length / original.length)).toFixed(1)),
    };
  }
  console.log("image optimization measurements", measurements);
});

test("large images resize inside 1600px and preserve aspect ratio", async () => {
  const original = await fixture("jpeg", 2400, 1200);
  const optimized = await optimizeImage(original, kinds.jpeg);
  assert.deepEqual(
    { width: optimized.width, height: optimized.height },
    { width: 1600, height: 800 },
  );
});

test("small images are not upscaled", async () => {
  const original = await fixture("png", 320, 180);
  const optimized = await optimizeImage(original, kinds.png);
  assert.deepEqual(
    { width: optimized.width, height: optimized.height },
    { width: 320, height: 180 },
  );
});

test("transparency is preserved", async () => {
  const original = await fixture("png", 96, 64, true);
  const optimized = await optimizeImage(original, kinds.png);
  assert.equal((await sharp(optimized.bytes).metadata()).hasAlpha, true);
});

test("orientation is applied and EXIF metadata is removed", async () => {
  const raw = pixels(120, 60);
  const original = await sharp(raw.bytes, {
    raw: { width: 120, height: 60, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const optimized = await optimizeImage(original, kinds.jpeg);
  const metadata = await sharp(optimized.bytes).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 60, height: 120 });
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test("corrupt images are rejected with a sanitized error", async () => {
  await assert.rejects(
    optimizeImage(Buffer.from("not an image"), kinds.png),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "INVALID_IMAGE",
  );
});

test("extreme dimensions are rejected by safe processing limits", async () => {
  const original = await sharp({
    create: { width: 20_001, height: 1, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    optimizeImage(original, kinds.png),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "IMAGE_PROCESSING_LIMIT",
  );
});
