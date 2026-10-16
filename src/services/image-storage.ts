import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { SupportedImage } from "../utils/image-signature.js";

export type ImageKind = "giving" | "events";
export type StoredImage = {
  url: string;
  key: string;
  contentType: SupportedImage["contentType"];
  size: number;
};

export interface ImageStorage {
  upload(
    kind: ImageKind,
    bytes: Buffer,
    image: SupportedImage,
  ): Promise<StoredImage>;
  deleteManagedUrl(url: string): Promise<boolean>;
}

type StorageConfig = Config & {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_BASE_URL: string;
};

type ObjectClient = {
  send(command: PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
};

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

  private managedKey(url: string) {
    try {
      const base = new URL(this.publicBase);
      const candidate = new URL(url);
      if (
        candidate.origin !== base.origin ||
        candidate.search ||
        candidate.hash
      )
        return undefined;
      const prefix = base.pathname.replace(/\/+$/, "") + "/";
      if (!candidate.pathname.startsWith(prefix)) return undefined;
      const encoded = candidate.pathname.slice(prefix.length);
      const key = encoded
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
      return /^(giving|events)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(
        key,
      )
        ? key
        : undefined;
    } catch {
      return undefined;
    }
  }

  async upload(kind: ImageKind, bytes: Buffer, image: SupportedImage) {
    const key = `${kind}/${randomUUID()}.webp`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.R2_BUCKET_NAME,
          Key: key,
          Body: bytes,
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
    const key = this.managedKey(url);
    if (!key) return false;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.R2_BUCKET_NAME, Key: key }),
      );
      return true;
    } catch {
      throw new AppError(
        502,
        "IMAGE_DELETE_FAILED",
        "Image cleanup could not be completed",
      );
    }
  }
}

export function createImageStorage(config: Config) {
  return hasImageStorageConfig(config) ? new R2ImageStorage(config) : undefined;
}
