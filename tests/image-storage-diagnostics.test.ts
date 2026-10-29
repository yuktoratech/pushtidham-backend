import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {loadConfig} from "../src/config/env.js";
import {hasImageStorageConfig, R2ImageStorage} from "../src/services/image-storage.js";
import {AppError} from "../src/utils/errors.js";

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
