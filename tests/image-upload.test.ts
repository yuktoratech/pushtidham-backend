import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import request from "supertest";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { Giving } from "../src/models/giving.js";
import { GivingCategory } from "../src/models/giving-category.js";
import { Event } from "../src/models/event.js";
import { Session } from "../src/models/session.js";
import { User } from "../src/models/user.js";
import {ImageCleanup} from "../src/models/image-cleanup.js";
import {ImageCleanupService} from "../src/services/image-cleanup.js";
import {Donation} from "../src/models/donation.js";
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
  PRODUCT_IMAGE_MAX_BYTES: String(15 * 1024 * 1024),
};
const config = loadConfig(env);

class MockStorage implements ImageStorage {
  uploads: Array<{ kind: ImageKind; image: SupportedImage; bytes: Buffer; context?: {slug?:string;placement?:"cover"|"gallery"} }> = [];
  deletes: string[] = [];
  async upload(kind: ImageKind, bytes: Buffer, image: SupportedImage, _uploadedBy?:string, context?:{slug?:string;placement?:"cover"|"gallery"}): Promise<StoredImage> {
    this.uploads.push({ kind, image, bytes, context });
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
  await Promise.all([User.init(), Session.init(), Giving.init(), GivingCategory.init()]);
  await GivingCategory.create({name:"General Donation",slug:"general-donation",status:"active"});
  const passwordHash = await bcrypt.hash(password, 12);
  await User.create([
    { name: "Image admin", email: "image-admin@example.test", passwordHash, role: "admin", canManageGivingCategories: true },
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

test("normal admin cannot upload category artwork", async () => {
  const passwordHash = await bcrypt.hash(password, 12);
  await User.create({name:"Catalog admin",email:"catalog-admin@example.test",passwordHash,role:"admin"});
  const login = await request(app).post("/api/v1/auth/login").send({email:"catalog-admin@example.test",password});
  const response = await request(app).post("/api/v1/admin/uploads/categories")
    .set(bearer(login.body.data.accessToken))
    .attach("image", png(), {filename:"category.png",contentType:"image/png"});
  assert.equal(response.status,403);
});

test("valid JPEG, PNG and WebP uploads are optimized to WebP before storage", async () => {
  const fixtures = [
    [png(), "image/png", "png"],
    [jpeg(), "image/jpeg", "jpg"],
    [jpeg(), "image/jpeg", "jpeg"],
    [Buffer.concat([jpeg(), Buffer.alloc(16)]), "image/jpeg", "jpg"],
    [Buffer.concat([jpeg(), Buffer.from(" \r\n")]), "image/jpeg", "jpg"],
    [await sharp(jpeg()).withExif({IFD0: {Artist: "Fixture"}}).withMetadata({orientation: 6}).jpeg().toBuffer(), "image/jpeg", "jpeg"],
    [await sharp(jpeg()).jpeg({progressive: true}).toBuffer(), "image/jpeg", "jpg"],
    [await sharp(jpeg()).toColourspace("cmyk").jpeg().toBuffer(), "image/jpeg", "jpeg"],
    [webp(), "image/webp", "webp"],
  ] as const;
  for (const kind of ["giving", "events"] as const) {
  for (const [bytes, contentType, extension] of fixtures) {
    const response = await request(app)
      .post(`/api/v1/admin/uploads/${kind}`)
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
  }
});
test("a genuine high-detail JPEG within the 15 MiB cap is decoded and optimized on both upload routes", async () => {
  const bytes = await sharp(randomBytes(2000 * 2000 * 3), {raw: {width: 2000, height: 2000, channels: 3}})
    .jpeg({quality: 100, chromaSubsampling: "4:2:0"}).toBuffer();
  assert.ok(bytes.length > 2 * 1024 * 1024 && bytes.length <= 15 * 1024 * 1024, `Fixture size: ${bytes.length}`);
  for (const kind of ["giving", "events"] as const) {
    const response = await request(app).post(`/api/v1/admin/uploads/${kind}`).set(bearer(adminToken))
      .attach("image", bytes, {filename: "large-photo.jpg", contentType: "image/jpeg"});
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const stored = mock.uploads.at(-1)!;
    const metadata = await sharp(stored.bytes).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 1600);
    assert.ok(stored.bytes.length < bytes.length);
  }
  console.log("Large JPEG regression input bytes:", bytes.length);
});

test("corrupt/truncated JPEG and unsupported images never reach storage", async () => {
  for (const kind of ["giving", "events"] as const) {
    for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), jpeg().subarray(0, jpeg().length - 30)]) {
      const count = mock.uploads.length;
      const response = await request(app).post(`/api/v1/admin/uploads/${kind}`).set(bearer(adminToken))
        .attach("image", bytes, {filename: "corrupt.jpg", contentType: "image/jpeg"});
      assert.equal(response.status, 415);
      assert.equal(response.body.error.code, "IMAGE_DECODE_FAILED");
      assert.equal(mock.uploads.length, count);
    }
    const response = await request(app).post(`/api/v1/admin/uploads/${kind}`).set(bearer(adminToken))
      .attach("image", Buffer.from("GIF89a"), {filename: "unsupported.gif", contentType: "image/gif"});
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "INVALID_IMAGE");
  }
});
test("both upload routes accept valid images below and exactly 15 MiB and reject one byte above", async () => {
  const limit = 15 * 1024 * 1024;
  for (const kind of ["giving", "events"] as const) {
    for (const size of [limit - 1, limit]) {
      // A valid JPEG stream with legal zero padding exercises exact byte limits
      // while keeping decoded dimensions small and processing deterministic.
      const bytes = Buffer.alloc(size);
      jpeg().copy(bytes);
      const response = await request(app).post(`/api/v1/admin/uploads/${kind}`)
        .set(bearer(adminToken)).attach("image", bytes, {filename: "boundary.jpg", contentType: "image/jpeg"});
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.contentType, "image/webp");
      assert.match(response.body.data.url, /\.webp$/);
    }
    const uploadsBefore = mock.uploads.length;
    const response = await request(app).post(`/api/v1/admin/uploads/${kind}`)
      .set(bearer(adminToken)).attach("image", Buffer.alloc(limit + 1), {filename: "oversized.jpg", contentType: "image/jpeg"});
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "IMAGE_TOO_LARGE");
    assert.match(response.body.error.message, /15 MiB/);
    assert.equal(mock.uploads.length, uploadsBefore);
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
test("upload context is validated and passed for nested entity key creation", async()=>{
 const before=mock.uploads.length;
 const response=await request(app).post("/api/v1/admin/uploads/events?slug=Community%20Gathering&placement=gallery").set(bearer(adminToken)).attach("image",png(),{filename:"gallery.png",contentType:"image/png"});
  assert.equal(response.status,201);assert.deepEqual(mock.uploads[before]!.context,{slug:"community-gathering",placement:"gallery"});
 const invalid=await request(app).post("/api/v1/admin/uploads/events?slug=../bad&placement=gallery").set(bearer(adminToken)).attach("image",png(),{filename:"gallery.png",contentType:"image/png"});
 assert.equal(invalid.status,400);assert.equal(mock.uploads.length,before+1);
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
    .attach("image", Buffer.alloc(15 * 1024 * 1024 + 1), {
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

test("Giving image replacement and soft deletion clean old objects after saving", async () => {
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
  assert.equal((await Giving.findById(record.id))?.image, "");
});
test("Event cover and category image replacement clean originals", async()=>{
 mock.deletes.length=0;
 const category=await GivingCategory.create({name:"Image category",slug:"image-category",image:"https://images.example.test/categories/00000000-0000-4000-8000-000000000031.webp",status:"active",displayOrder:1});
 const categoryResult=await request(app).put(`/api/v1/admin/giving-categories/${category.id}`).set(bearer(adminToken)).send({name:category.name,slug:category.slug,description:"",image:"https://images.example.test/categories/00000000-0000-4000-8000-000000000032.webp",status:"active",displayOrder:1});
 assert.equal(categoryResult.status,200);assert.equal(await GivingCategory.findById(category.id).then(row=>row?.image),categoryResult.body.data.image);
 const event=await Event.create({title:"Image event",slug:"image-event",shortDescription:"",description:"",startsAt:new Date(),location:"Haveli",image:"https://images.example.test/events/00000000-0000-4000-8000-000000000033.webp",gallery:[],status:"draft"});
 const eventResult=await request(app).put(`/api/v1/admin/events/${event.id}`).set(bearer(adminToken)).send({title:event.title,slug:event.slug,shortDescription:"",description:"",startsAt:event.startsAt.toISOString(),location:event.location,image:"https://images.example.test/events/00000000-0000-4000-8000-000000000034.webp",gallery:[],status:"draft"});
 assert.equal(eventResult.status,200);assert.deepEqual(mock.deletes,[category.image,event.image]);
});

test("R2 adapter keeps flat legacy keys and uses immutable nested keys for contextual uploads", async () => {
  const commands: PutObjectCommand[] = [];
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
      if (!(command instanceof PutObjectCommand)) return {};
      assert.ok(command instanceof PutObjectCommand);
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
  assert.equal(await storage.deleteManagedUrl(uploaded.url), false);
  assert.equal(commands.length, 1);
  assert.equal(await storage.deleteManagedUrl("https://images.example.test/catalog/home-slider/official-5ba55c13ca87a17e/pushtidham-1920.webp"), false);
  assert.equal(await storage.deleteManagedUrl("https://images.example.test/catalog/branding/official-logo/master/logo.webp"), false);
  assert.equal(commands.length, 1);
  const nested = await storage.upload("events", webp(), {contentType: "image/webp", extension: "webp"}, "admin-id", {slug: "community-gathering", placement: "gallery"});
  assert.match(nested.key, /^events\/community-gathering\/gallery\/community-gathering-[a-f0-9]{64}\.webp$/);
  assert.equal(commands[1]!.input.IfNoneMatch, "*");
  assert.equal(commands[1]!.input.Metadata?.["entity-slug"], "community-gathering");
  assert.equal(commands[1]!.input.Metadata?.placement, "gallery");
  assert.equal(commands[1]!.input.Metadata?.["ownership-class"], "event-gallery");
  assert.equal(commands[1]!.input.Metadata?.["retention-policy"], "retain-by-default");
  await assert.rejects(storage.upload("giving", webp(), {contentType: "image/webp", extension: "webp"}, "admin-id", {slug: "../giving"}), /safe lowercase entity slug/);
  assert.equal(commands.length, 2);
});
test("a repeated immutable content key with unverified metadata fails without overwriting the original", async()=>{
 const storageConfig=loadConfig({...env,R2_ACCOUNT_ID:"00000000000000000000000000000000",R2_REGION:"auto",R2_ACCESS_KEY_ID:"local-test-access",R2_SECRET_ACCESS_KEY:"local-test-secret",R2_BUCKET_NAME:"catalog-images",R2_PUBLIC_BASE_URL:"https://images.example.test/catalog"});
 if(!hasImageStorageConfig(storageConfig))throw new Error("storage config invalid");
 const keys=new Set<string>();let writes=0;let attempts=0;
 const storage=new R2ImageStorage(storageConfig,{async send(command){if(!(command instanceof PutObjectCommand))return {};attempts++;const key=command.input.Key!;if(keys.has(key))throw Object.assign(new Error("PreconditionFailed"),{name:"PreconditionFailed",$metadata:{httpStatusCode:412}});keys.add(key);writes++;return {};}});
 const context={slug:"mangla-seva"};const input={contentType:"image/webp" as const,extension:"webp" as const};
 const first=await storage.upload("giving",webp(),input,"admin-id",context);
 await assert.rejects(storage.upload("giving",webp(),input,"admin-id",context),/existing image could not be verified/);
 assert.equal(keys.size,1);assert.equal(writes,1);assert.equal(attempts,2);assert.equal(first.key,[...keys][0]);
});

test("partial development R2 configuration stays safely disabled", () => {
  const partial = loadConfig({ ...env, R2_BUCKET_NAME: "catalog-images" });
  assert.equal(hasImageStorageConfig(partial), false);
});
test("image upload limit defaults to 15 MiB and rejects a larger configured value", () => {
  assert.equal(loadConfig({...env, PRODUCT_IMAGE_MAX_BYTES: undefined}).PRODUCT_IMAGE_MAX_BYTES, 15 * 1024 * 1024);
  assert.throws(() => loadConfig({...env, PRODUCT_IMAGE_MAX_BYTES: String(15 * 1024 * 1024 + 1)}));
});
test("category uploads use existing signature/size pipeline; referenced gallery images cannot be deleted",async()=>{
 const upload=await request(app).post("/api/v1/admin/uploads/categories").set(bearer(adminToken)).attach("image",png(),{filename:"category.png",contentType:"image/png"});
 assert.equal(upload.status,201);assert.equal(upload.body.data.contentType,"image/webp");
 const {Event}=await import("../src/models/event.js");
 const url="https://images.example.test/events/00000000-0000-4000-8000-000000000099.webp";
 await Event.create({title:"Gallery reference",slug:"gallery-reference",startsAt:new Date(),location:"Haveli",gallery:[{url,alt:"Gallery",displayOrder:0}]});
 const count=mock.deletes.length;
 const deletion=await request(app).delete("/api/v1/admin/uploads").set(bearer(adminToken)).send({url});
 assert.equal(deletion.status,409);assert.equal(deletion.body.error.code,"IMAGE_IN_USE");assert.equal(mock.deletes.length,count);
});
test("Giving and category references block explicit cleanup requests",async()=>{
 const givingUrl="https://images.example.test/giving/00000000-0000-4000-8000-000000000077.webp";
 const categoryUrl="https://images.example.test/categories/00000000-0000-4000-8000-000000000078.webp";
 await Giving.create({title:"Referenced image",slug:"referenced-image",image:givingUrl,amountType:"fixed",fixedAmountsCents:[100],status:"active",displayOrder:1});
 await GivingCategory.create({name:"Referenced category",slug:"referenced-category",image:categoryUrl,status:"active",displayOrder:1});
 for(const url of [givingUrl,categoryUrl]){const response=await request(app).delete("/api/v1/admin/uploads").set(bearer(adminToken)).send({url});assert.equal(response.status,409);assert.equal(response.body.error.code,"IMAGE_IN_USE");}
});
test("admin can explicitly clean an unreferenced managed upload", async()=>{
 const url="https://images.example.test/giving/00000000-0000-4000-8000-000000000088.webp";
 const before=mock.deletes.length;
 const response=await request(app).delete("/api/v1/admin/uploads").set(bearer(adminToken)).send({url});
 assert.equal(response.status,204);assert.equal(mock.deletes.length,before+1);assert.equal(mock.deletes.at(-1),url);
});

test("gallery cleanup preserves a shared cover until its last reference is deleted", async()=>{
 const shared="https://images.example.test/events/00000000-0000-4000-8000-000000000101.webp";
 const removed="https://images.example.test/events/00000000-0000-4000-8000-000000000102.webp";
 const event=await Event.create({title:"Shared gallery",slug:"shared-gallery",startsAt:new Date(),location:"Haveli",image:shared,gallery:[{url:shared,displayOrder:0},{url:removed,displayOrder:1}]});
 const giving=await Giving.create({title:"Shared image",slug:"shared-cover",image:shared,amountType:"fixed",fixedAmountsCents:[100],status:"active"});
 mock.deletes.length=0;
 const result=await request(app).put(`/api/v1/admin/events/${event.id}`).set(bearer(adminToken)).send({title:event.title,startsAt:event.startsAt.toISOString(),location:event.location,image:shared,gallery:[],status:"draft"});
 assert.equal(result.status,200);assert.deepEqual(mock.deletes,[removed]);
 assert.equal((await request(app).delete(`/api/v1/admin/events/${event.id}`).set(bearer(adminToken))).status,204);
 assert.deepEqual(mock.deletes,[removed]);
 assert.equal((await request(app).delete(`/api/v1/admin/giving/${giving.id}`).set(bearer(adminToken))).status,204);
 assert.deepEqual(mock.deletes,[removed,shared]);
});

test("same image and failed catalog save never delete the saved image", async()=>{
 const image="https://images.example.test/giving/00000000-0000-4000-8000-000000000103.webp";
 const row=await Giving.create({title:"Preserved",slug:"preserved-image",image,amountType:"fixed",fixedAmountsCents:[100],status:"active"});
 const other=await Giving.create({title:"Conflicting slug",slug:"conflicting-image",amountType:"fixed",fixedAmountsCents:[100],status:"active"});
 const body={title:row.title,image,amountType:"fixed",fixedAmountsCents:[100],status:"active",displayOrder:0};
 mock.deletes.length=0;
 assert.equal((await request(app).put(`/api/v1/admin/giving/${row.id}`).set(bearer(adminToken)).send(body)).status,200);
 assert.equal(mock.deletes.length,0);
 const failed=await request(app).put(`/api/v1/admin/giving/${row.id}`).set(bearer(adminToken)).send({...body,slug:other.slug,image:""});
 assert.equal(failed.status,409);assert.equal((await Giving.findById(row.id))?.image,image);
 await ImageCleanup.updateMany({},{$set:{nextAttemptAt:new Date(0)}});
 await new ImageCleanupService(mock).retryPending();
 assert.equal(mock.deletes.includes(image),false);
});

test("R2 deletion failure preserves saved catalog changes and retries durably", async(t)=>{
 const image="https://images.example.test/giving/00000000-0000-4000-8000-000000000104.webp";
 const row=await Giving.create({title:"Retry cleanup",slug:"retry-cleanup",image,amountType:"fixed",fixedAmountsCents:[100],status:"active"});
 const deletion=t.mock.method(mock,"deleteManagedUrl",async()=>{throw new Error("Simulated R2 outage");});
 const response=await request(app).put(`/api/v1/admin/giving/${row.id}`).set(bearer(adminToken)).send({title:row.title,image:"",amountType:"fixed",fixedAmountsCents:[100],status:"active",displayOrder:0});
 assert.equal(response.status,200);assert.equal((await Giving.findById(row.id))?.image,"");
 assert.equal(await ImageCleanup.countDocuments({url:image}),1);
 deletion.mock.restore();
 await ImageCleanup.updateOne({url:image},{$set:{nextAttemptAt:new Date(0),leaseUntil:new Date(0)}});
 await new ImageCleanupService(mock).retryPending();
 assert.equal(mock.deletes.includes(image),true);assert.equal(await ImageCleanup.countDocuments({url:image}),0);
});

test("donation-protected records retain their image and never schedule deletion", async()=>{
 const image="https://images.example.test/giving/00000000-0000-4000-8000-000000000105.webp";
 const row=await Giving.create({title:"Protected giving",slug:"protected-cleanup",image,amountType:"fixed",fixedAmountsCents:[100],status:"active"});
 await Donation.create({donationNumber:"CLEANUP-TEST",donorName:"Fixture",donorEmail:"fixture@example.test",type:"general",giving:row._id,designationTitle:row.title,amountCents:100,paymentMethod:"offline",source:"offline",status:"pending"});
 const response=await request(app).delete(`/api/v1/admin/giving/${row.id}`).set(bearer(adminToken));
 assert.equal(response.status,409);assert.equal(response.body.error.code,"HAS_DONATIONS");
 assert.equal((await Giving.findById(row.id))?.image,image);assert.equal(mock.deletes.includes(image),false);
 assert.equal(await ImageCleanup.countDocuments({url:image}),0);
});

test("category deletion and event deletion remove their unshared images", async()=>{
 const category=await GivingCategory.create({name:"Unused cleanup",slug:"unused-cleanup",image:"https://images.example.test/categories/00000000-0000-4000-8000-000000000106.webp"});
 assert.equal((await request(app).delete(`/api/v1/admin/giving-categories/${category.id}`).set(bearer(adminToken))).status,204);
 assert.equal(mock.deletes.includes(category.image),true);
 const image="https://images.example.test/events/00000000-0000-4000-8000-000000000107.webp";
 const gallery="https://images.example.test/events/00000000-0000-4000-8000-000000000108.webp";
 const event=await Event.create({title:"Delete gallery",slug:"delete-gallery",startsAt:new Date(),location:"Haveli",image,gallery:[{url:image,displayOrder:0},{url:gallery,displayOrder:1}]});
 const before=mock.deletes.length;
 assert.equal((await request(app).delete(`/api/v1/admin/events/${event.id}`).set(bearer(adminToken))).status,204);
 assert.deepEqual(mock.deletes.slice(before),[image,gallery]);
 const deleted=await Event.findById(event.id);assert.equal(deleted?.image,"");assert.equal(deleted?.gallery.length,0);
});
