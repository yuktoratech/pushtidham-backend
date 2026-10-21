import { randomUUID, createHash } from "node:crypto";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { SupportedImage } from "../utils/image-signature.js";

export type ImageKind = "giving" | "events" | "categories";
export type ImageOwnershipClass = "giving" | "category" | "event-cover" | "event-gallery" | "legacy-flat" | "shared-site" | "home-slider" | "official-branding";
export const PROTECTED_IMAGE_PREFIXES = ["site/", "home-slider/official-5ba55c13ca87a17e/", "branding/official-logo/"] as const;
export type StoredImage = {
  url: string;
  key: string;
  contentType: SupportedImage["contentType"];
  size: number;
};
export type ImageUploadContext = {slug?: string; placement?: "cover" | "gallery"};

export interface ImageStorage {
  upload(
    kind: ImageKind,
    bytes: Buffer,
    image: SupportedImage,
    uploadedBy?: string,
    context?: ImageUploadContext,
  ): Promise<StoredImage>;
  deleteManagedUrl(url: string): Promise<boolean>;
}

type StorageConfig = Config & {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_BASE_URL: string;
};

type ObjectClient = {send(command: PutObjectCommand): Promise<unknown>};

export function hasImageStorageConfig(config: Config): config is StorageConfig {
  return Boolean(
    (config.R2_ENDPOINT || config.R2_ACCOUNT_ID) &&
      config.R2_ACCESS_KEY_ID &&
      config.R2_SECRET_ACCESS_KEY &&
      config.R2_BUCKET_NAME &&
      config.R2_PUBLIC_BASE_URL,
  );
}

function endpoint(config: StorageConfig) {
  return (
    config.R2_ENDPOINT ??
    `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  );
}

function encodedKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export class R2ImageStorage implements ImageStorage {
  private readonly publicBase: string;

  constructor(
    private readonly config: StorageConfig,
    private readonly client: ObjectClient = new S3Client({
      endpoint: endpoint(config),
      region: config.R2_REGION,
      forcePathStyle: config.R2_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    }) as ObjectClient,
  ) {
    this.publicBase = config.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }

  async upload(kind: ImageKind, bytes: Buffer, image: SupportedImage, uploadedBy?: string, context?: ImageUploadContext) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const slug = context?.slug;
    if (slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      throw new AppError(400, "INVALID_IMAGE_OWNER", "A safe lowercase entity slug is required");
    if (context?.placement && (kind !== "events" || !slug))
      throw new AppError(400, "INVALID_IMAGE_OWNER", "Event image placement requires a safe event slug");
    const key = slug
      ? kind === "events"
        ? `events/${slug}/${context?.placement ?? "cover"}/${slug}-${digest}.webp`
        : `${kind}/${slug}/${slug}-${digest}.webp`
      : `${kind}/${randomUUID()}.webp`;
    const ownershipClass: ImageOwnershipClass = !slug
      ? "legacy-flat"
      : kind === "giving" ? "giving"
        : kind === "categories" ? "category"
          : context?.placement === "gallery" ? "event-gallery" : "event-cover";
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.R2_BUCKET_NAME,
          Key: key,
          Body: bytes,
          IfNoneMatch: "*",
          Metadata: {kind, "ownership-class": ownershipClass, "retention-policy": "retain-by-default", "uploaded-by": uploadedBy || "unknown", sha256: digest, ...(slug ? {"entity-slug": slug} : {}), ...(context?.placement ? {placement: context.placement} : {})},
          ContentLength: bytes.length,
          ContentType: image.contentType,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
    } catch {
      throw new AppError(
        502,
        "IMAGE_UPLOAD_FAILED",
        "Image upload could not be completed",
      );
    }
    return {
      url: `${this.publicBase}/${encodedKey(key)}`,
      key,
      contentType: image.contentType,
      size: bytes.length,
    };
  }

  async deleteManagedUrl(url: string) {
    // No current caller can prove ownership, rollback expiry, and complete reference
    // coverage. Retention is the safe default; cleanup requires a separately reviewed executor.
    void url;
    return false;
  }
}

export function createImageStorage(config: Config) {
  return hasImageStorageConfig(config) ? new R2ImageStorage(config) : undefined;
}
