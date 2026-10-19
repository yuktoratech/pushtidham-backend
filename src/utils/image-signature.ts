import { AppError } from "./errors.js";

export type SupportedImage = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
};

const invalid = () =>
  new AppError(415, "INVALID_IMAGE", "Upload a valid JPEG, PNG, or WebP image");

function isPng(bytes: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let first = true;
  let hasEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (first) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0
      )
        return false;
      first = false;
    }
    offset = end;
    if (type === "IEND") {
      if (length !== 0) return false;
      hasEnd = true;
      break;
    }
  }
  return hasEnd && offset === bytes.length;
}

function isJpeg(bytes: Buffer) {
  // Sniff JPEG's SOI and marker prefix, not its container layout/end position.
  // Exporters may append padding. Sharp verifies format and fully decodes the
  // stream with strict corruption checks before any optimized bytes reach R2.
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function validWebpPayload(type: string, bytes: Buffer, offset: number, length: number) {
  if (type === "VP8 ")
    return (
      length >= 10 &&
      bytes[offset + 3] === 0x9d &&
      bytes[offset + 4] === 0x01 &&
      bytes[offset + 5] === 0x2a &&
      (bytes.readUInt16LE(offset + 6) & 0x3fff) > 0 &&
      (bytes.readUInt16LE(offset + 8) & 0x3fff) > 0
    );
  if (type === "VP8L") {
    if (length < 5 || bytes[offset] !== 0x2f) return false;
    const dimensions = bytes.readUInt32LE(offset + 1);
    return (dimensions & 0x3fff) + 1 > 0 && ((dimensions >> 14) & 0x3fff) + 1 > 0;
  }
  if (type === "VP8X") {
    if (length < 10) return false;
    const width = bytes.readUIntLE(offset + 4, 3) + 1;
    const height = bytes.readUIntLE(offset + 7, 3) + 1;
    return width > 0 && height > 0;
  }
  return false;
}

function isWebp(bytes: Buffer) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return false;
  let offset = 12;
  let hasImagePayload = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end > bytes.length) return false;
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") {
      if (!validWebpPayload(type, bytes, dataOffset, length)) return false;
      if (type === "VP8 " || type === "VP8L") hasImagePayload = true;
    }
    offset = end + (length % 2);
  }
  return hasImagePayload && offset === bytes.length;
}

export function inspectImage(bytes: Buffer, declaredType: string): SupportedImage {
  let result: SupportedImage | undefined;
  if (isPng(bytes)) result = { contentType: "image/png", extension: "png" };
  else if (isJpeg(bytes))
    result = { contentType: "image/jpeg", extension: "jpg" };
  else if (isWebp(bytes))
    result = { contentType: "image/webp", extension: "webp" };
  if (!result || result.contentType !== declaredType) throw invalid();
  return result;
}
