import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {loadConfig} from "../src/config/env.js";
import {hasImageStorageConfig, R2ImageStorage} from "../src/services/image-storage.js";
import {AppError} from "../src/utils/errors.js";
import {PutObjectCommand, HeadObjectCommand, DeleteObjectCommand} from "@aws-sdk/client-s3";

test("R2 upload failures log provider code/status without credentials or provider messages", async (t) => {
  const sensitive = randomBytes(32).toString("hex");
  const config = loadConfig({
    NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1/unused",
    JWT_ACCESS_SECRET: randomBytes(40).toString("hex"), JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
    FRONTEND_URL: "http://localhost:3000", R2_ACCOUNT_ID: "test-account",
    R2_ACCESS_KEY_ID: sensitive, R2_SECRET_ACCESS_KEY: sensitive,
    R2_BUCKET_NAME: "test-bucket", R2_PUBLIC_BASE_URL: "https://images.example.test",
  });
  assert.ok(hasImageStorageConfig(config));
  const output: string[] = [];
  t.mock.method(console, "log", (line: string) => output.push(line));
  for (const [name, status] of [["AccessDenied", 403], ["PreconditionFailed", 412]] as const) {
    const failure = Object.assign(new Error(sensitive), {name, $metadata: {httpStatusCode: status}, sensitive});
    const storage = new R2ImageStorage(config, {async send() {throw failure;}});
    await assert.rejects(storage.upload("giving", Buffer.from("mock optimized bytes"), {contentType: "image/webp", extension: "webp"}),
      (error: unknown) => error instanceof AppError && error.status === 502 && error.code === "IMAGE_UPLOAD_FAILED" && !error.message.includes(sensitive));
    const entry = JSON.parse(output.at(-1)!);
    assert.equal(entry.event, "r2_image_upload_failed");
    assert.equal(entry.providerCode, name);
    assert.equal(entry.providerStatus, status);
    assert.deepEqual(Object.keys(entry).sort(), ["event", "level", "providerCode", "providerStatus", "time"]);
  }
  assert.ok(output.every((line) => !line.includes(sensitive)));
});

test("R2 cleanup only deletes verified catalog keys from the configured public base", async () => {
  const config = loadConfig({
    NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1/unused",
    JWT_ACCESS_SECRET: randomBytes(40).toString("hex"), JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
    FRONTEND_URL: "http://localhost:3000", R2_ACCOUNT_ID: "test-account",
    R2_ACCESS_KEY_ID: "test-access", R2_SECRET_ACCESS_KEY: "test-secret",
    R2_BUCKET_NAME: "test-bucket", R2_PUBLIC_BASE_URL: "https://images.example.test/catalog",
  });
  assert.ok(hasImageStorageConfig(config));
  const base = config.R2_PUBLIC_BASE_URL;
  const digest = "a".repeat(64);
  const commands: Array<HeadObjectCommand | DeleteObjectCommand> = [];
  let head: {ContentType: string; Metadata?: Record<string,string>} = {ContentType: "image/webp"};
  let failure: Error | undefined;
  const storage = new R2ImageStorage(config, {async send(command) {
    assert.ok(command instanceof HeadObjectCommand || command instanceof DeleteObjectCommand);
    commands.push(command);
    if (failure) throw failure;
    return command instanceof HeadObjectCommand ? head : {};
  }});
  for (const url of [
    "https://other.example/giving/00000000-0000-4000-8000-000000000001.webp",
    `${base}.evil/giving/00000000-0000-4000-8000-000000000001.webp`,
    `${base}/site/hero.webp`, `${base}/branding/official-logo/logo.webp`,
    `${base}/home-slider/official-5ba55c13ca87a17e/hero.webp`,
    `${base}/giving/../site/hero.webp`, `${base}/giving/%2e%2e/site/hero.webp`,
    `${base}/giving/not-an-upload.webp`, `${base}/giving/test/test-${digest}.webp?query=1`,
    `${base}/giving%2Ftest%2Ftest-${digest}.webp`, `${base}/giving/test/test-${digest}.webp#fragment`,
  ]) assert.equal(await storage.deleteManagedUrl(url), false);
  assert.equal(commands.length, 0);
  const cases: Array<{key: string; metadata: Record<string, string>}> = [
    {key: "giving/00000000-0000-4000-8000-000000000001.png", metadata: {kind: "giving"}},
    {key: `giving/test/test-${digest}.webp`, metadata: {kind: "giving", "ownership-class": "giving", "entity-slug": "test", sha256: digest}},
    {key: `categories/test/test-${digest}.webp`, metadata: {kind: "categories", "ownership-class": "category", "entity-slug": "test", sha256: digest}},
    {key: `events/test/gallery/test-${digest}.webp`, metadata: {kind: "events", "ownership-class": "event-gallery", "entity-slug": "test", sha256: digest}},
    {key: `events/test/cover/test-${digest}.webp`, metadata: {kind: "events", "ownership-class": "event-cover", "entity-slug": "test", sha256: digest}},
  ];
  for (const row of cases) {
    head = {ContentType: "image/webp", Metadata: row.metadata};
    assert.equal(await storage.deleteManagedUrl(`${base}/${row.key}`), true);
    const deletion = commands.at(-1)!;
    assert.ok(deletion instanceof DeleteObjectCommand);
    assert.deepEqual(deletion.input, {Bucket: "test-bucket", Key: row.key});
  }
  const key = cases[1]!.key;
  for (const metadata of ([{}, {kind: "events"}, {"ownership-class": "shared-site"}, {...cases[1]!.metadata, sha256: "wrong"}] as Array<Record<string, string>>)) {
    const before = commands.filter(command => command instanceof DeleteObjectCommand).length;
    head = {ContentType: "image/webp", Metadata: metadata};
    assert.equal(await storage.deleteManagedUrl(`${base}/${key}`), false);
    assert.equal(commands.filter(command => command instanceof DeleteObjectCommand).length, before);
  }
  failure = Object.assign(new Error("Missing"), {$metadata: {httpStatusCode: 404}});
  assert.equal(await storage.deleteManagedUrl(`${base}/${key}`), true);
  failure = Object.assign(new Error("Denied"), {$metadata: {httpStatusCode: 403}});
  await assert.rejects(storage.deleteManagedUrl(`${base}/${key}`), (error: unknown) => error instanceof AppError && error.code === "IMAGE_DELETE_FAILED");
});

test("duplicate contextual uploads reuse only verified immutable objects", async (t) => {
  const config = loadConfig({
    NODE_ENV: "test", MONGODB_URI: "mongodb://127.0.0.1/unused",
    JWT_ACCESS_SECRET: randomBytes(40).toString("hex"), JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
    FRONTEND_URL: "http://localhost:3000", R2_ACCOUNT_ID: "test-account",
    R2_ACCESS_KEY_ID: "test-access", R2_SECRET_ACCESS_KEY: "test-secret",
    R2_BUCKET_NAME: "test-bucket", R2_PUBLIC_BASE_URL: "https://images.example.test",
  });
  assert.ok(hasImageStorageConfig(config));
  const image = {contentType: "image/webp" as const, extension: "webp" as const};
  const bytes = Buffer.from("mock optimized image");
  const conflict = () => Object.assign(new Error("Existing object"), {name: "PreconditionFailed", $metadata: {httpStatusCode: 412}});
  for (const kind of ["giving", "events", "categories"] as const) {
    await t.test(kind, async () => {
      const objects = new Map<string, PutObjectCommand["input"]>();
      let writes = 0, reads = 0;
      const storage = new R2ImageStorage(config, {async send(command) {
        const key = command.input.Key!;
        if (command instanceof PutObjectCommand) {
          assert.equal(command.input.IfNoneMatch, "*");
          if (objects.has(key)) throw conflict();
          objects.set(key, command.input); writes++; return {};
        }
        assert.ok(command instanceof HeadObjectCommand); reads++;
        const original = objects.get(key)!;
        return {ContentLength: original.ContentLength, ContentType: original.ContentType, Metadata: original.Metadata};
      }});
      const context = {slug: "test-owner", ...(kind === "events" ? {placement: "gallery" as const} : {})};
      const first = await storage.upload(kind, bytes, image, "admin", context);
      const repeated = await storage.upload(kind, bytes, image, "admin", context);
      assert.deepEqual(repeated, first); assert.equal(writes, 1); assert.equal(reads, 1);
      const different = await storage.upload(kind, Buffer.from("different optimized image"), image, "admin", context);
      assert.notEqual(different.key, first.key); assert.equal(writes, 2);
    });
  }
  t.mock.method(console, "log", () => {});
  for (const mismatch of ["sha256", "entity-slug", "kind", "ownership-class", "retention-policy", "placement", "size", "type", "head-failure"]) {
    await t.test(`rejects ${mismatch}`, async () => {
      let input: PutObjectCommand["input"];
      const storage = new R2ImageStorage(config, {async send(command) {
        if (command instanceof PutObjectCommand) {input = command.input; throw conflict();}
        if (mismatch === "head-failure") throw Object.assign(new Error("Not authorized"), {name: "AccessDenied"});
        const metadata = {...input.Metadata};
        if (!["size", "type"].includes(mismatch)) metadata[mismatch] = "mismatch";
        return {ContentLength: mismatch === "size" ? 0 : input.ContentLength, ContentType: mismatch === "type" ? "image/png" : input.ContentType, Metadata: metadata};
      }});
      await assert.rejects(storage.upload("giving", bytes, image, "admin", {slug: "test-owner"}),
        (error: unknown) => error instanceof AppError && error.code === (mismatch === "head-failure" ? "IMAGE_UPLOAD_FAILED" : "IMAGE_CONTENT_CONFLICT"));
    });
  }
});
