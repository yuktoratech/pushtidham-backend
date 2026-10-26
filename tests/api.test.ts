import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { User } from "../src/models/user.js";
import { Session } from "../src/models/session.js";
import { Giving } from "../src/models/giving.js";
import { Event } from "../src/models/event.js";
import { Donation } from "../src/models/donation.js";
import { AuthService } from "../src/services/auth.js";
import { escapeRegex } from "../src/utils/pagination.js";
const testPassword = randomBytes(20).toString("hex");
const env = {
  NODE_ENV: "test",
  PORT: "4000",
  MONGODB_URI: "mongodb://127.0.0.1/test",
  JWT_ACCESS_SECRET: randomBytes(40).toString("hex"),
  JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
  FRONTEND_URL: "http://localhost:3000",
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};
const config = loadConfig(env);
const app = createApp(config);
let mongo: MongoMemoryServer;
let adminToken: string;
let donorToken: string;
let otherToken: string;
let donorId: string;
let givingId: string;
let eventId: string;
let donationId: string;
const cookie = (res: request.Response) => {
  const cookies = res.headers["set-cookie"] as unknown as string[];
  assert.ok(cookies?.length);
  return cookies.map((c) => c.split(";")[0]!).join("; ");
};
const auth = (token: string) => ({ Authorization: "Bearer " + token });
const general = () => ({
  donorName: "Test donor",
  donorEmail: "donor@example.test",
  type: "general",
  giving: givingId,
  amountCents: 2500,
  paymentMethod: "card",
});
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "isolated_test" });
  await Promise.all([
    User.init(),
    Session.init(),
    Giving.init(),
    Event.init(),
    Donation.init(),
  ]);
  const hash = await bcrypt.hash(testPassword, 12);
  await User.create({
    name: "Admin",
    email: "admin@example.test",
    passwordHash: hash,
    role: "admin",
  });
  const admin = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "admin@example.test", password: testPassword });
  assert.equal(admin.status, 200);
  adminToken = admin.body.data.accessToken;
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
test("environment validation rejects placeholders, identical keys and unsafe cookie policy", () => {
  assert.throws(() =>
    loadConfig({
      ...env,
      JWT_ACCESS_SECRET: "replace-this-secret-with-real-randomness",
    }),
  );
  assert.throws(() =>
    loadConfig({ ...env, JWT_REFRESH_SECRET: env.JWT_ACCESS_SECRET }),
  );
  assert.throws(() => loadConfig({ ...env, NODE_ENV: "production" }));
  assert.throws(() => loadConfig({ ...env, COOKIE_SAME_SITE: "none" }));
  assert.equal(escapeRegex("a.*$[x]"), "a\\.\\*\\$\\[x\\]");
});
test("registration hashes passwords, normalizes email and rejects duplicates/admin mass assignment", async () => {
  const res = await request(app).post("/api/v1/auth/register").send({
    name: "Donor",
    email: " DONOR@EXAMPLE.TEST ",
    password: testPassword,
  });
  assert.equal(res.status, 201);
  donorToken = res.body.data.accessToken;
  donorId = res.body.data.user.id;
  assert.equal(res.body.data.user.role, "donor");
  assert.equal(res.body.data.user.passwordHash, undefined);
  const user = await User.findById(donorId).select("+passwordHash");
  assert.ok(user);
  assert.notEqual(user.passwordHash, testPassword);
  assert.ok(await bcrypt.compare(testPassword, user.passwordHash));
  assert.equal(user.toJSON().passwordHash, undefined);
  assert.equal(
    (
      await request(app).post("/api/v1/auth/register").send({
        name: "Duplicate",
        email: "donor@example.test",
        password: testPassword,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(app).post("/api/v1/auth/register").send({
        name: "Attacker",
        email: "attacker@example.test",
        password: testPassword,
        role: "admin",
      })
    ).status,
    400,
  );
  const other = await request(app).post("/api/v1/auth/register").send({
    name: "Other",
    email: "other@example.test",
    password: testPassword,
  });
  assert.equal(other.status, 201);
  otherToken = other.body.data.accessToken;
});
test("login success/failure, me, admin protection and server-owned role", async () => {
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "donor@example.test", password: "incorrect-password" })
    ).status,
    401,
  );
  assert.equal(
    (await request(app).get("/api/v1/auth/me").set(auth(donorToken))).status,
    200,
  );
  assert.equal((await request(app).get("/api/v1/admin/giving")).status, 401);
  assert.equal(
    (await request(app).get("/api/v1/admin/giving").set(auth(donorToken)))
      .status,
    403,
  );
  assert.equal(
    (await request(app).get("/api/v1/admin/giving").set(auth(adminToken)))
      .status,
    200,
  );
});
test("refresh rotates hashed tokens, replay revokes session, logout immediately invalidates access", async () => {
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "donor@example.test", password: testPassword });
  const first = cookie(login);
  const initialSession = await Session.findOne({ user: donorId });
  assert.match(
    (login.headers["set-cookie"] as unknown as string[])[0]!,
    /HttpOnly/,
  );
  assert.ok(!JSON.stringify(login.body).includes("refreshToken"));
  const refreshed = await request(app)
    .post("/api/v1/auth/refresh")
    .set("Origin", config.FRONTEND_URL)
    .set("Cookie", first)
    .send({});
  assert.equal(refreshed.status, 200);
  assert.notEqual(cookie(refreshed), first);
  const renewedSession = await Session.findOne({ user: donorId });
  assert.ok(renewedSession!.expiresAt.getTime() >= initialSession!.expiresAt.getTime());
  const sessions = await Session.find({ user: donorId }).select("+tokenHash");
  assert.ok(sessions.every((s) => /^[a-f0-9]{64}$/.test(s.tokenHash)));
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/refresh")
        .set("Origin", config.FRONTEND_URL)
        .set("Cookie", first)
        .send({})
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/v1/auth/me")
        .set(auth(refreshed.body.data.accessToken))
    ).status,
    401,
  );
  const fresh = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "donor@example.test", password: testPassword });
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/logout")
        .set("Origin", config.FRONTEND_URL)
        .set("Cookie", cookie(fresh))
        .send({})
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/v1/auth/me")
        .set(auth(fresh.body.data.accessToken))
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", cookie(fresh))
        .send({})
    ).status,
    403,
  );
});
test("disabled users cannot login, refresh or use existing access tokens", async () => {
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "other@example.test", password: testPassword });
  await User.updateOne(
    { email: "other@example.test" },
    { $set: { status: "disabled" } },
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "other@example.test", password: testPassword })
    ).status,
    401,
  );
  assert.equal(
    (await request(app).get("/api/v1/auth/me").set(auth(otherToken))).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/refresh")
        .set("Origin", config.FRONTEND_URL)
        .set("Cookie", cookie(login))
        .send({})
    ).status,
    401,
  );
  await User.updateOne(
    { email: "other@example.test" },
    { $set: { status: "active" } },
  );
});
test("Giving validates modes, normalizes fixed cents, filters public records and protects admin writes", async () => {
  const body = {
    title: "Giving",
    slug: "giving",
    description: "Test",
    amountType: "fixed",
    fixedAmountsCents: [5000, 2500, 2500],
  };
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/giving")
        .set(auth(donorToken))
        .send(body)
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/giving")
        .set(auth(adminToken))
        .send({ ...body, fixedAmountsCents: [] })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/giving")
        .set(auth(adminToken))
        .send({ ...body, fixedAmountsCents: [2.5] })
    ).status,
    400,
  );
  const made = await request(app)
    .post("/api/v1/admin/giving")
    .set(auth(adminToken))
    .send(body);
  assert.equal(made.status, 201);
  givingId = made.body.data._id;
  assert.deepEqual(made.body.data.fixedAmountsCents, [2500, 5000]);
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/giving")
        .set(auth(adminToken))
        .send({
          ...body,
          slug: "combined",
          amountType: "fixed_and_custom",
          fixedAmountsCents: [],
        })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/giving")
        .set(auth(adminToken))
        .send({
          ...body,
          slug: "custom",
          amountType: "custom",
          fixedAmountsCents: [],
          status: "inactive",
        })
    ).status,
    201,
  );
  const list = await request(app).get("/api/v1/giving");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal((await request(app).get("/api/v1/giving/custom")).status, 404);
  assert.equal(
    (
      await request(app)
        .get("/api/v1/admin/giving/not-an-id")
        .set(auth(adminToken))
    ).status,
    400,
  );
});
test("Events validate dates, publish visibility and admin authorization", async () => {
  const body = {
    title: "Event",
    slug: "event",
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    location: "Temple",
    status: "published",
  };
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/events")
        .set(auth(donorToken))
        .send(body)
    ).status,
    403,
  );
  const made = await request(app)
    .post("/api/v1/admin/events")
    .set(auth(adminToken))
    .send(body);
  assert.equal(made.status, 201);
  eventId = made.body.data._id;
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/events")
        .set(auth(adminToken))
        .send({ ...body, slug: "draft", status: "draft" })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/events")
        .set(auth(adminToken))
        .send({ ...body, slug: "invalid", endsAt: "2000-01-01T00:00:00Z" })
    ).status,
    400,
  );
  assert.equal((await request(app).get("/api/v1/events")).body.data.length, 1);
  assert.equal((await request(app).get("/api/v1/events/draft")).status, 404);
});
test("legacy public donation creation is retired; Card checkout owns online creation", async () => {
  const base = general();
  for (const input of [base, { ...base, paymentMethod: "paypal" }, { ...base, paymentMethod: "ach" }]) {
    const response = await request(app).post("/api/v1/donations").send(input);
    assert.equal(response.status, 404);
    assert.equal(await Donation.countDocuments(), 0);
  }
  donationId = String(new mongoose.Types.ObjectId());
  await Donation.create({
    _id: donationId,
    donationNumber: "PD-HISTORICAL-READ-001",
    user: donorId,
    donorName: "Test donor",
    donorEmail: "donor@example.test",
    type: "general",
    giving: givingId,
    designationTitle: "Test Giving",
    amountCents: 2500,
    currency: "USD",
    paymentMethod: "card",
    status: "pending",
    source: "online",
  });
  assert.equal(
    (
      await request(app)
        .patch("/api/v1/admin/donations/" + donationId + "/status")
        .set(auth(adminToken))
        .send({ status: "completed" })
    ).status,
    409,
  );
});
test("donor history uses authenticated user ID and omits admin/private fields", async () => {
  assert.equal(
    (await request(app).get("/api/v1/donations/" + donationId)).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/v1/donations/" + donationId)
        .set(auth(otherToken))
    ).status,
    404,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/v1/donations/" + donationId)
        .set(auth(donorToken))
    ).status,
    200,
  );
  const history = await request(app)
    .get("/api/v1/donations")
    .set(auth(donorToken));
  assert.equal(history.status, 200);
  assert.equal(history.body.pagination.total, 1);
  assert.equal(history.body.data[0].adminNote, undefined);
  assert.equal(
    (await request(app).get("/api/v1/admin/donations").set(auth(donorToken)))
      .status,
    403,
  );
});
test("offline donations require admin, share model and enforce terminal status transitions", async () => {
  const body = { ...general() };
  Reflect.deleteProperty(body, "paymentMethod");
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/donations/offline")
        .set(auth(donorToken))
        .send(body)
    ).status,
    403,
  );
  const made = await request(app)
    .post("/api/v1/admin/donations/offline")
    .set(auth(adminToken))
    .send({
      ...body,
      user: donorId,
      offlineReference: "manual-test",
      adminNote: "Private note",
    });
  assert.equal(made.status, 201);
  assert.equal(made.body.data.source, "offline");
  assert.equal(made.body.data.paymentMethod, "offline");
  const update = await request(app)
    .patch("/api/v1/admin/donations/" + made.body.data._id + "/status")
    .set(auth(adminToken))
    .send({ status: "completed" });
  assert.equal(update.status, 200);
  assert.ok(update.body.data.verifiedBy);
  assert.ok(update.body.data.completedAt);
  assert.equal(
    (
      await request(app)
        .patch("/api/v1/admin/donations/" + made.body.data._id + "/status")
        .set(auth(adminToken))
        .send({ status: "rejected" })
    ).status,
    409,
  );
  const detail = await request(app)
    .get("/api/v1/donations/" + made.body.data._id)
    .set(auth(donorToken));
  assert.equal(detail.body.data.adminNote, undefined);
  assert.equal(
    (
      await request(app)
        .delete("/api/v1/admin/giving/" + givingId)
        .set(auth(adminToken))
    ).status,
    409,
  );
});
test("custom and combined Giving eligibility remains read-only outside Card checkout", async () => {
  const custom = await request(app)
    .post("/api/v1/admin/giving")
    .set(auth(adminToken))
    .send({
      title: "Custom giving",
      slug: "custom-active",
      amountType: "custom",
    });
  const combined = await request(app)
    .post("/api/v1/admin/giving")
    .set(auth(adminToken))
    .send({
      title: "Combined giving",
      slug: "combined-active",
      amountType: "fixed_and_custom",
      fixedAmountsCents: [2500],
    });
  for (const id of [custom.body.data._id, combined.body.data._id]) {
    assert.equal((await request(app).post("/api/v1/donations").send({ ...general(), giving: id, amountCents: 1234 })).status, 404);
  }
  assert.equal(
    (
      await request(app)
        .get("/api/v1/admin/donations?limit=101")
        .set(auth(adminToken))
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/v1/admin/donations?search=%24")
        .set(auth(adminToken))
    ).body.pagination.total,
    0,
  );
  const filtered = await request(app)
    .get("/api/v1/admin/donations?source=offline&status=completed")
    .set(auth(adminToken));
  assert.equal(filtered.body.pagination.total, 1);
  assert.equal(
    (
      await request(app)
        .patch("/api/v1/admin/giving/" + givingId + "/status")
        .set(auth(adminToken))
        .send({ status: "inactive" })
    ).status,
    200,
  );
  assert.equal(
    (await request(app).post("/api/v1/donations").send(general())).status,
    404,
  );
  await request(app)
    .patch("/api/v1/admin/giving/" + givingId + "/status")
    .set(auth(adminToken))
    .send({ status: "active" });
  await request(app)
    .patch("/api/v1/admin/events/" + eventId + "/status")
    .set(auth(adminToken))
    .send({ status: "inactive" });
  assert.equal(
    (
      await request(app)
        .post("/api/v1/donations")
        .send({
          ...general(),
          type: "event",
          giving: undefined,
          event: eventId,
        })
    ).status,
    404,
  );
  await request(app)
    .patch("/api/v1/admin/events/" + eventId + "/status")
    .set(auth(adminToken))
    .send({ status: "published" });
  assert.equal(
    (
      await request(app)
        .delete("/api/v1/admin/giving/" + custom.body.data._id)
        .set(auth(adminToken))
    ).status,
    204,
  );
  assert.equal((await request(app).get("/api/v1/giving/custom-active")).status,404);
  const unused = await request(app)
    .post("/api/v1/admin/giving")
    .set(auth(adminToken))
    .send({ title: "Unused", slug: "unused", amountType: "custom" });
  assert.equal(
    (
      await request(app)
        .delete("/api/v1/admin/giving/" + unused.body.data._id)
        .set(auth(adminToken))
    ).status,
    204,
  );
  assert.equal((await request(app).get("/api/v1/giving/unused")).status, 404);
  assert.ok(await Giving.exists({ _id: unused.body.data._id }));
});
test("database donation references remain unique", async () => {
  const originals = await Promise.all(Array.from({ length: 12 }, (_, index) => Donation.create({
    donationNumber: `PD-TEST-UNIQUE-${index}`,
    donorName: "Test donor",
    donorEmail: "donor@example.test",
    type: "general",
    giving: givingId,
    designationTitle: "Test Giving",
    amountCents: 2500,
    currency: "USD",
    paymentMethod: "offline",
    status: "pending",
    source: "offline",
  })));
  assert.equal(new Set(originals.map((row) => row.donationNumber)).size, 12);
  const original = await Donation.findById(originals[0]!._id).lean();
  assert.ok(original);
  const clone = { ...original };
  for (const key of ["_id", "createdAt", "updatedAt"])
    Reflect.deleteProperty(clone, key);
  await assert.rejects(
    Donation.create(clone),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000,
  );
});
test("CORS, malformed JSON, body limit, health and non-sensitive error responses", async () => {
  assert.equal((await request(app).get("/api/v1/health")).status, 200);
  assert.equal(
    (
      await request(app)
        .get("/api/v1/health")
        .set("Origin", "https://evil.example")
    ).status,
    403,
  );
  assert.equal((await request(app).post("/api/v1/payments/stripe/checkout-sessions").set("Content-Type", "application/json").send("{bad")).status, 400);
  assert.equal(
    (
      await request(app)
        .post("/api/v1/payments/stripe/checkout-sessions")
        .send({ data: "x".repeat(40000) })
    ).status,
    413,
  );
  assert.equal(
    (await request(app).get("/missing")).body.error.code,
    "NOT_FOUND",
  );
});
test("compiled server starts on isolated MongoDB and answers health without real environment files", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: "development",
      MONGODB_URI: mongo.getUri("startup_test"),
      PORT: String(port),
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + port + "/api/v1/health",
        );
        if (response.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        /* Wait for the process to listen. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(healthy, "Server did not answer health; output: " + output);
    assert.ok(!output.includes(env.JWT_ACCESS_SECRET));
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }
});

test("logout propagates database failure without reporting successful revocation", async (t) => {
  const authService = new AuthService(config);
  const session = await authService.login({
    email: "donor@example.test",
    password: testPassword,
  });
  const failure = new Error("Simulated database unavailable");
  const mocked = t.mock.method(Session, "updateOne", () => {
    throw failure;
  });
  await assert.rejects(authService.logout(session.refreshToken), failure);
  mocked.mock.restore();
  await authService.logout(session.refreshToken);
  await assert.rejects(authService.authenticate(session.accessToken));
});
test("production cookie policy sets Secure, HttpOnly and explicit cross-site SameSite", async () => {
  const production = createApp(
    loadConfig({
      ...env,
      NODE_ENV: "production",
      FRONTEND_URL: "https://frontend.example.test",
      COOKIE_SAME_SITE: "none",
    }),
  );
  const res = await request(production)
    .post("/api/v1/auth/login")
    .send({ email: "donor@example.test", password: testPassword });
  assert.equal(res.status, 200);
  const header = (res.headers["set-cookie"] as unknown as string[])[0]!;
  assert.match(header, /Secure/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=None/);
});
test("manual seed is repeatable and preserves admin password/status", async () => {
  const dbName = "seed_isolated";
  const seedPassword = randomBytes(20).toString("hex");
  const seedEnv = {
    ...process.env,
    ...env,
    NODE_ENV: "development",
    MONGODB_URI: mongo.getUri(dbName),
    MONGODB_DATABASE: "",
    ADMIN_SEED_NAME: "Seed Admin",
    ADMIN_SEED_EMAIL: "SEED@EXAMPLE.TEST",
    ADMIN_SEED_PASSWORD: seedPassword,
  };
  const runSeed = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "scripts/seed.ts"],
        { cwd: process.cwd(), windowsHide: true, env: seedEnv },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Seed failed: " + output));
      });
    });
  await runSeed();
  const isolated = mongoose.connection.useDb(dbName);
  const users = isolated.collection("users");
  const admin = await users.findOne({ email: "seed@example.test" });
  assert.ok(admin);
  assert.ok(await bcrypt.compare(seedPassword, admin.passwordHash));
  await users.updateOne({ _id: admin._id }, { $set: { status: "disabled" } });
  seedEnv.ADMIN_SEED_PASSWORD = randomBytes(20).toString("hex");
  await runSeed();
  const retained = await users.findOne({ _id: admin._id });
  assert.ok(retained);
  assert.equal(retained.passwordHash, admin.passwordHash);
  assert.equal(retained.status, "disabled");
  assert.equal(await users.countDocuments({ email: "seed@example.test" }), 1);
});

test("health reports database unavailability using the standard error envelope", async () => {
  await mongoose.disconnect();
  try {
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "DATABASE_UNAVAILABLE");
    assert.equal(res.body.error.stack, undefined);
  } finally {
    await mongoose.connect(mongo.getUri(), { dbName: "isolated_test" });
  }
});

test("public Events reject new donations; offline historical Events only need to exist", async () => {
  const past = new Date("2020-01-01T00:00:00Z");
  const published = await Event.create({
    title: "Published historical event",
    slug: "published-historical",
    startsAt: past,
    location: "Temple",
    status: "published",
  });
  const historical = await Event.create({
    title: "Inactive historical event",
    slug: "inactive-historical",
    startsAt: past,
    location: "Temple",
    status: "inactive",
  });
  const input = {
    donorName: "Historical donor",
    donorEmail: "historical@example.test",
    type: "event",
    event: String(published._id),
    amountCents: 1200,
  };
  assert.equal(
    (await request(app).get("/api/v1/events/published-historical")).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/donations")
        .send({ ...input, paymentMethod: "card" })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/donations")
        .send({
          ...input,
          event: String(historical._id),
          paymentMethod: "paypal",
        })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/donations/offline")
        .set(auth(adminToken))
        .send({ ...input, event: String(historical._id) })
    ).status,
    201,
  );
  await Event.updateOne(
    { _id: historical._id },
    { $set: { deletedAt: new Date() } },
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/donations/offline")
        .set(auth(adminToken))
        .send({ ...input, event: String(historical._id) })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/admin/donations/offline")
        .set(auth(adminToken))
        .send({ ...input, event: String(new mongoose.Types.ObjectId()) })
    ).status,
    404,
  );
});
test("development CORS credentials allow only the configured frontend origin", async () => {
  const allowed = await request(app)
    .get("/api/v1/health")
    .set("Origin", config.FRONTEND_URL);
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers["access-control-allow-origin"],
    config.FRONTEND_URL,
  );
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  const denied = await request(app)
    .get("/api/v1/health")
    .set("Origin", "http://localhost:3001");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});
test("donor profile persists, protected fields stay protected, and password changes revoke old sessions", async () => {
  const address = `profile-${randomBytes(5).toString("hex")}@example.test`;
  const registered = await request(app).post("/api/v1/auth/register").send({name: "Profile Donor", email: address, password: "eight123", phone: "352-555-0123"});
  assert.equal(registered.status, 201);
  const token = registered.body.data.accessToken as string;
  const update = await request(app).patch("/api/v1/auth/profile").set(auth(token)).send({name: "Updated Donor", email: address, phone: "+1 352 555 0199"});
  assert.equal(update.status, 200);
  assert.equal(update.body.data.phone, "+1 352 555 0199");
  assert.equal(update.body.data.role, "donor");
  assert.equal((await request(app).patch("/api/v1/auth/profile").set(auth(token)).send({name: "Bad", email: address, phone: "", role: "admin"})).status, 400);
  assert.equal((await request(app).patch("/api/v1/auth/profile").set(auth(adminToken)).send({name: "Bad", email: address, phone: ""})).status, 403);
  const incorrect = await request(app).post("/api/v1/auth/change-password").set(auth(token)).send({currentPassword: "wrong", newPassword: "newpass123", confirmPassword: "newpass123"});
  assert.equal(incorrect.status, 400);
  assert.equal((await request(app).get("/api/v1/auth/me").set(auth(token))).status, 200);
  const changed = await request(app).post("/api/v1/auth/change-password").set(auth(token)).send({currentPassword: "eight123", newPassword: "newpass123", confirmPassword: "newpass123"});
  assert.equal(changed.status, 200);
  assert.equal((await request(app).get("/api/v1/auth/me").set(auth(token))).status, 401);
  assert.equal((await request(app).post("/api/v1/auth/login").send({email: address, password: "eight123"})).status, 401);
  const relogin = await request(app).post("/api/v1/auth/login").send({email: address, password: "newpass123"});
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.data.user.name, "Updated Donor");
  assert.equal(relogin.body.data.user.phone, "+1 352 555 0199");
});
test("contact and reset emails use an injected adapter and never claim unaccepted delivery", async () => {
  const sent: Array<{to: string; subject: string; text: string; html?: string; replyTo?: string}> = [];
  const mail = {send: async (message: {to: string; subject: string; text: string; html?: string; replyTo?: string}) => {sent.push(message);}};
  const mailApp = createApp(loadConfig({...env, CONTACT_TO: "temple@example.test"}), {mail});
  const address = `mail-${randomBytes(5).toString("hex")}@example.test`;
  assert.equal((await request(mailApp).post("/api/v1/contact").set("Origin", config.FRONTEND_URL).send({name: "Donor", email: address, subject: "Visit", message: "Please advise"})).status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "temple@example.test");
  assert.equal(sent[0]!.replyTo, address);
  assert.match(sent[0]!.html ?? "", /Please advise/);
  assert.equal((await request(mailApp).post("/api/v1/contact").set("Origin", "http://localhost:3001").send({name: "Donor", email: address, subject: "Visit", message: "Please advise"})).status, 403);
  assert.equal((await request(app).post("/api/v1/contact").set("Origin", config.FRONTEND_URL).send({name: "Donor", email: address, subject: "Visit", message: "Please advise"})).status, 503);
  assert.equal((await request(mailApp).post("/api/v1/auth/forgot-password").send({email: `missing-${address}`})).status, 202);
  assert.equal(sent.length, 1);
  await request(app).post("/api/v1/auth/register").send({name: "Reset Donor", email: address, password: "eight123"});
  const forgot = await request(mailApp).post("/api/v1/auth/forgot-password").send({email: address});
  assert.equal(forgot.status, 202);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.html ?? "", /Reset your password/);
  const url = sent[1]!.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(url);
  const resetToken = new URL(url).searchParams.get("token");
  assert.ok(resetToken);
  const reset = await request(mailApp).post("/api/v1/auth/reset-password").send({token: resetToken, newPassword: "changed123", confirmPassword: "changed123"});
  assert.equal(reset.status, 200);
  assert.equal((await request(mailApp).post("/api/v1/auth/reset-password").send({token: resetToken, newPassword: "changed123", confirmPassword: "changed123"})).status, 400);
  assert.equal((await request(mailApp).post("/api/v1/auth/login").send({email: address, password: "changed123"})).status, 200);
});
test("receipts require ownership and verification; CSV export filters and escapes spreadsheet formulas", async () => {
  const adminUser = await User.findOne({email: "admin@example.test"});
  assert.ok(adminUser);
  const now = new Date();
  const receipt = await Donation.create({donationNumber: `PD-RECEIPT-${randomBytes(4).toString("hex")}`, user: donorId, donorName: "=HYPERLINK(\"bad\")", donorEmail: "donor@example.test", type: "general", giving: givingId, designationTitle: "Receipt test", amountCents: 4200, currency: "USD", paymentMethod: "offline", source: "offline", status: "completed", verifiedBy: adminUser._id, verifiedAt: now, completedAt: now});
  const donorPdf = await request(app).get(`/api/v1/donations/${receipt.id}/receipt`).set(auth(donorToken));
  assert.equal(donorPdf.status, 200);
  assert.match(String(donorPdf.headers["content-type"]), /application\/pdf/);
  assert.equal(Buffer.from(donorPdf.body).subarray(0, 4).toString(), "%PDF");
  assert.equal((await request(app).get(`/api/v1/donations/${receipt.id}/receipt`).set(auth(otherToken))).status, 404);
  assert.equal((await request(app).get(`/api/v1/admin/donations/${receipt.id}/receipt`).set(auth(adminToken))).status, 200);
  assert.equal((await request(app).get(`/api/v1/admin/donations/${receipt.id}/receipt`).set(auth(donorToken))).status, 403);
  const pending = await Donation.create({donationNumber: `PD-PENDING-${randomBytes(4).toString("hex")}`, user: donorId, donorName: "Pending", donorEmail: "donor@example.test", type: "general", giving: givingId, designationTitle: "Pending test", amountCents: 1200, currency: "USD", paymentMethod: "offline", source: "offline", status: "pending"});
  assert.equal((await request(app).get(`/api/v1/donations/${pending.id}/receipt`).set(auth(donorToken))).status, 409);
  const csv = await request(app).get("/api/v1/admin/donations/export.csv").set(auth(adminToken)).query({search: receipt.donationNumber, status: "completed", type: "general"});
  assert.equal(csv.status, 200);
  assert.match(csv.text, /'=HYPERLINK/);
  assert.match(csv.text, /"42\.00"/);
  assert.match(csv.text, /TOTAL COMPLETED BASE/);
  assert.ok([403, 429].includes((await request(app).get("/api/v1/admin/donations/export.csv").set(auth(donorToken))).status));
});
