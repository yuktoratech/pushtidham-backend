import sharp from "sharp";
import { AppError } from "../utils/errors.js";
import type { SupportedImage } from "../utils/image-signature.js";

const MAX_OUTPUT_DIMENSION = 1600;
const MAX_INPUT_DIMENSION = 20_000;
const MAX_INPUT_PIXELS = 40_000_000;
const PROCESSING_TIMEOUT_SECONDS = 10;

export type OptimizedImage = {
  bytes: Buffer;
  image: SupportedImage;
  width: number;
  height: number;
  originalSize: number;
};

const invalid = () =>
  new AppError(415, "INVALID_IMAGE", "Upload a valid JPEG, PNG, or WebP image");

const tooComplex = () =>
  new AppError(
    413,
    "IMAGE_PROCESSING_LIMIT",
    "Image dimensions exceed safe processing limits",
  );

function expectedDimensions(width: number, height: number) {
  const scale = Math.min(1, MAX_OUTPUT_DIMENSION / width, MAX_OUTPUT_DIMENSION / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function input(bytes: Buffer) {
  return sharp(bytes, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  });
}

async function encode(bytes: Buffer, lossless = false) {
  return input(bytes)
    .rotate()
    .resize({
      width: MAX_OUTPUT_DIMENSION,
      height: MAX_OUTPUT_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp(
      lossless
        ? { lossless: true, effort: 5 }
        : { quality: 85, effort: 5, smartSubsample: true },
    )
    .timeout({ seconds: PROCESSING_TIMEOUT_SECONDS })
    .toBuffer();
}

export async function optimizeImage(
  bytes: Buffer,
  _image: SupportedImage,
): Promise<OptimizedImage> {
  try {
    const metadata = await input(bytes).metadata();
    if (!metadata.width || !metadata.height) throw invalid();
    if (
      metadata.width > MAX_INPUT_DIMENSION ||
      metadata.height > MAX_INPUT_DIMENSION ||
      metadata.width * metadata.height > MAX_INPUT_PIXELS ||
      (metadata.pages ?? 1) > 1
    )
      throw tooComplex();

    const swapsAxes =
      metadata.orientation !== undefined && metadata.orientation >= 5;
    const orientedWidth = swapsAxes ? metadata.height : metadata.width;
    const orientedHeight = swapsAxes ? metadata.width : metadata.height;
    const expected = expectedDimensions(orientedWidth, orientedHeight);
    let optimized = await encode(bytes);

    // Tiny/already-efficient sources can grow after lossy transcoding. Compare a
    // lossless WebP fallback rather than lowering quality to meet a byte target.
    if (
      expected.width === orientedWidth &&
      expected.height === orientedHeight &&
      optimized.length > bytes.length
    ) {
      const lossless = await encode(bytes, true);
      if (lossless.length < optimized.length) optimized = lossless;
    }

    const output = await sharp(optimized, {
      failOn: "error",
      limitInputPixels: MAX_OUTPUT_DIMENSION * MAX_OUTPUT_DIMENSION,
    }).metadata();
    if (
      output.format !== "webp" ||
      output.width !== expected.width ||
      output.height !== expected.height ||
      (metadata.hasAlpha === true && output.hasAlpha !== true)
    )
      throw new AppError(
        422,
        "IMAGE_PROCESSING_FAILED",
        "Image optimization could not preserve the required output",
      );

    return {
      bytes: optimized,
      image: { contentType: "image/webp", extension: "webp" },
      width: output.width,
      height: output.height,
      originalSize: bytes.length,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && /pixel limit|memory|timeout/i.test(error.message))
      throw tooComplex();
    throw invalid();
  }
}
