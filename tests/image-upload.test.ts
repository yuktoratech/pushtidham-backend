import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import request from "supertest";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { Giving } from "../src/models/giving.js";
import { Session } from "../src/models/session.js";
import { User } from "../src/models/user.js";
import {
  R2ImageStorage,
  hasImageStorageConfig,
  type ImageKind,
  type ImageStorage,
  type StoredImage,
} from "../src/services/image-storage.js";
import type { SupportedImage } from "../src/utils/image-signature.js";

const password = randomBytes(20).toString("hex");
const env = {
  NODE_ENV: "test",
  PORT: "4000",
  MONGODB_URI: "mongodb://127.0.0.1/image_test",
  JWT_ACCESS_SECRET: randomBytes(40).toString("hex"),
  JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
  FRONTEND_URL: "http://localhost:3000",
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  PRODUCT_IMAGE_MAX_BYTES: String(8 * 1024 * 1024),
};
const config = loadConfig(env);

class MockStorage implements ImageStorage {
  uploads: Array<{ kind: ImageKind; image: SupportedImage; bytes: Buffer }> = [];
  deletes: string[] = [];
  async upload(kind: ImageKind, bytes: Buffer, image: SupportedImage): Promise<StoredImage> {
    this.uploads.push({ kind, image, bytes });
    return {
      url: `https://images.example.test/${kind}/00000000-0000-4000-8000-000000000001.${image.extension}`,
      key: `${kind}/00000000-0000-4000-8000-000000000001.${image.extension}`,
      contentType: image.contentType,
      size: bytes.length,
    };
  }
  async deleteManagedUrl(url: string) {
    this.deletes.push(url);
    return true;
  }
}

let pngFixture: Buffer;
let jpegFixture: Buffer;
let webpFixture: Buffer;
const png = () => pngFixture;
const jpeg = () => jpegFixture;
const webp = () => webpFixture;

const mock = new MockStorage();
const app = createApp(config, { images: mock });
const appWithoutStorage = createApp(config);
let mongo: MongoMemoryServer;
let adminToken: string;
let donorToken: string;

before(async () => {
  const source = {
    create: { width: 32, height: 24, channels: 3 as const, background: "#9d6b35" },
  };
  [pngFixture, jpegFixture, webpFixture] = await Promise.all([
    sharp(source).png().toBuffer(),
    sharp(source).jpeg().toBuffer(),
    sharp(source).webp().toBuffer(),
  ]);
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "image_upload_test" });
  await Promise.all([User.init(), Session.init(), Giving.init()]);
  const passwordHash = await bcrypt.hash(password, 12);
  await User.create([
    { name: "Image admin", email: "image-admin@example.test", passwordHash, role: "admin" },
    { name: "Image donor", email: "image-donor@example.test", passwordHash, role: "donor" },
  ]);
  const [admin, donor] = await Promise.all([
    request(app).post("/api/v1/auth/login").send({ email: "image-admin@example.test", password }),
    request(app).post("/api/v1/auth/login").send({ email: "image-donor@example.test", password }),
  ]);
  adminToken = admin.body.data.accessToken;
  donorToken = donor.body.data.accessToken;
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("image upload requires an authenticated admin", async () => {
  const unauthenticated = await request(app)
    .post("/api/v1/admin/uploads/giving")
    .attach("image", png(), { filename: "image.png", contentType: "image/png" });
  assert.equal(unauthenticated.status, 401);
  const donor = await request(app)
    .post("/api/v1/admin/uploads/giving")
    .set(bearer(donorToken))
    .attach("image", png(), { filename: "image.png", contentType: "image/png" });
  assert.equal(donor.status, 403);
});

test("valid JPEG, PNG and WebP uploads are optimized to WebP before storage", async () => {
  const fixtures = [
    [png(), "image/png", "png"],
    [jpeg(), "image/jpeg", "jpg"],
    [webp(), "image/webp", "webp"],
  ] as const;
  for (const [bytes, contentType, extension] of fixtures) {
    const response = await request(app)
      .post("/api/v1/admin/uploads/events")
      .set(bearer(adminToken))
      .attach("image", bytes, { filename: `image.${extension}`, contentType });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.contentType, "image/webp");
    assert.match(response.body.data.key, /\.webp$/);
    const stored = mock.uploads.at(-1)!;
    assert.equal(stored.image.contentType, "image/webp");
    assert.equal(stored.image.extension, "webp");
    assert.equal((await sharp(stored.bytes).metadata()).format, "webp");
  }
});
test("an uploaded image can be saved with a new Giving record and an automatic slug", async () => {
  const uploaded = await request(app).post("/api/v1/admin/uploads/giving").set({Authorization: `Bearer ${adminToken}`}).attach("image", png(), {filename: "giving.png", contentType: "image/png"});
  assert.equal(uploaded.status, 201);
  const created = await request(app).post("/api/v1/admin/giving").set({Authorization: `Bearer ${adminToken}`}).send({title: "New Image Seva", description: "Test image", image: uploaded.body.data.url, amountType: "fixed", fixedAmountsCents: [1000], status: "active", displayOrder: 1});
  assert.equal(created.status, 201);
  assert.equal(created.body.data.slug, "new-image-seva");
  assert.equal(created.body.data.image, uploaded.body.data.url);
  assert.equal((await Giving.findById(created.body.data._id))?.image, uploaded.body.data.url);
  const renamed = await request(app).put(`/api/v1/admin/giving/${created.body.data._id}`).set({Authorization: `Bearer ${adminToken}`}).send({title: "Renamed Image Seva", description: "Test image", image: uploaded.body.data.url, amountType: "fixed", fixedAmountsCents: [1000], status: "active", displayOrder: 1});
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.slug, "new-image-seva");
});

test("spoofed, malformed and oversized images are rejected before storage", async () => {
  const uploadedBefore = mock.uploads.length;
  const mismatch = await request(app)
    .post("/api/v1/admin/uploads/giving")
    .set(bearer(adminToken))
    .attach("image", png(), { filename: "spoof.jpg", contentType: "image/jpeg" });
  assert.equal(mismatch.status, 415);
  assert.equal(mismatch.body.error.code, "INVALID_IMAGE");

  const malformed = await request(app)
    .post("/api/v1/admin/uploads/giving")
    .set(bearer(adminToken))
    .attach("image", Buffer.from("<script>alert(1)</script>"), {
      filename: "bad.png",
      contentType: "image/png",
    });
  assert.equal(malformed.status, 415);

  const oversized = await request(app)
    .post("/api/v1/admin/uploads/giving")
    .set(bearer(adminToken))
    .attach("image", Buffer.alloc(8 * 1024 * 1024 + 1), {
      filename: "large.png",
      contentType: "image/png",
    });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "IMAGE_TOO_LARGE");
  assert.equal(mock.uploads.length, uploadedBefore);
});

test("missing storage configuration returns a sanitized availability error", async () => {
  const response = await request(appWithoutStorage)
    .post("/api/v1/admin/uploads/giving")
    .set(bearer(adminToken))
    .attach("image", png(), { filename: "image.png", contentType: "image/png" });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "IMAGE_STORAGE_UNAVAILABLE");
  assert.equal(JSON.stringify(response.body).includes("S3"), false);
});

test("catalog replace and remove clean up the superseded image only after persistence", async () => {
  const original = "https://images.example.test/giving/00000000-0000-4000-8000-000000000011.png";
  const replacement = "https://images.example.test/giving/00000000-0000-4000-8000-000000000012.webp";
  const record = await Giving.create({
    title: "Image cleanup",
    slug: "image-cleanup",
    description: "",
    image: original,
    amountType: "fixed",
    fixedAmountsCents: [100],
    status: "active",
    displayOrder: 1,
  });
  mock.deletes.length = 0;
  const replaced = await request(app)
    .put(`/api/v1/admin/giving/${record.id}`)
    .set(bearer(adminToken))
    .send({
      title: "Image cleanup",
      slug: "image-cleanup",
      description: "",
      image: replacement,
      amountType: "fixed",
      fixedAmountsCents: [100],
      status: "active",
      displayOrder: 1,
    });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(mock.deletes, [original]);
  const removed = await request(app)
    .delete(`/api/v1/admin/giving/${record.id}`)
    .set(bearer(adminToken));
  assert.equal(removed.status, 204);
  assert.deepEqual(mock.deletes, [original, replacement]);
});

test("R2 adapter uses random managed keys and never deletes unrelated URLs", async () => {
  const commands: Array<PutObjectCommand | DeleteObjectCommand> = [];
  const storageConfig = loadConfig({
    ...env,
    R2_ACCOUNT_ID: "00000000000000000000000000000000",
    R2_REGION: "auto",
    R2_ACCESS_KEY_ID: "local-test-access",
    R2_SECRET_ACCESS_KEY: "local-test-secret",
    R2_BUCKET_NAME: "catalog-images",
    R2_PUBLIC_BASE_URL: "https://images.example.test/catalog",
  });
  assert.equal(hasImageStorageConfig(storageConfig), true);
  if (!hasImageStorageConfig(storageConfig)) throw new Error("storage config invalid");
  const storage = new R2ImageStorage(storageConfig, {
    async send(command) {
      commands.push(command);
      return {};
    },
  });
  const uploaded = await storage.upload("giving", webp(), {
    contentType: "image/webp",
    extension: "webp",
  });
  assert.match(uploaded.key, /^giving\/[0-9a-f-]{36}\.webp$/);
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.equal(await storage.deleteManagedUrl("https://unrelated.example/image.png"), false);
  assert.equal(commands.length, 1);
  assert.equal(await storage.deleteManagedUrl(uploaded.url), true);
  assert.ok(commands[1] instanceof DeleteObjectCommand);
});

test("partial development R2 configuration stays safely disabled", () => {
  const partial = loadConfig({ ...env, R2_BUCKET_NAME: "catalog-images" });
  assert.equal(hasImageStorageConfig(partial), false);
});
