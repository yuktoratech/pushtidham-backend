import {test, mock} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import request from "supertest";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";
import {AuthService} from "../src/services/auth.js";
import {AppError} from "../src/utils/errors.js";
import bcrypt from "bcrypt";
import {User} from "../src/models/user.js";

function app(environment: "development" | "production" | "test") {
  return createApp(loadConfig({
    NODE_ENV: environment,
    MONGODB_URI: "mongodb://127.0.0.1/unused_rate_limit_test",
    JWT_ACCESS_SECRET: randomBytes(40).toString("hex"),
    JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
    FRONTEND_URL: "https://frontend.example.test",
  }));
}

test("development login skips only the auth attempt limit; credentials and other limits remain enforced", async () => {
  const login = mock.method(AuthService.prototype, "login", async () => {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  });
  try {
    const server = app("development");
    for (const email of ["admin@example.test", "donor@example.test"]) {
      for (let i = 0; i < 25; i++) {
        const response = await request(server).post("/api/v1/auth/login").send({email, password: randomBytes(16).toString("hex")});
        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "INVALID_CREDENTIALS");
      }
    }
    assert.equal(login.mock.callCount(), 50);
    assert.equal((await request(server).post("/api/v1/auth/login").send({email: "invalid", password: ""})).status, 400);
    // Invalid bodies stop before any database work or email sending.
    for (let i = 0; i < 20; i++) {
      assert.equal((await request(server).post("/api/v1/auth/forgot-password").send({})).status, 400);
    }
    assert.equal((await request(server).post("/api/v1/auth/forgot-password").send({})).status, 429);
    assert.equal((await request(server).post("/api/v1/auth/reset-password").send({})).status, 429);
    assert.equal((await request(server).post("/api/v1/auth/login").send({email: "donor@example.test", password: randomBytes(16).toString("hex")})).status, 401);
    for (let i = 0; i < 5; i++) {
      assert.equal((await request(server).post("/api/v1/contact").set("Origin", "https://frontend.example.test").send({})).status, 400);
    }
    assert.equal((await request(server).post("/api/v1/contact").send({})).status, 429);
  } finally {login.mock.restore();}
});

test("production and test login retain the shared per-IP 20-request limit for admin and donor", async () => {
  const login = mock.method(AuthService.prototype, "login", async () => {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  });
  try {
    for (const environment of ["production", "test"] as const) {
      const server = app(environment);
      for (let i = 0; i < 20; i++) {
        assert.equal((await request(server).post("/api/v1/auth/login").send({email: i % 2 ? "admin@example.test" : "donor@example.test", password: randomBytes(16).toString("hex")})).status, 401);
      }
      for (const email of ["admin@example.test", "donor@example.test"]) {
        const response = await request(server).post("/api/v1/auth/login").send({email, password: randomBytes(16).toString("hex")});
        assert.equal(response.status, 429);
        assert.equal(response.body.error.code, "RATE_LIMITED");
      }
    }
  } finally {login.mock.restore();}
});

test("development still rejects incorrect passwords through the real bcrypt login logic", async () => {
  const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), 12);
  let role = "admin";
  const lookup = mock.method(User, "findOne", () => ({
    select: async () => ({passwordHash, status: "active", role}),
  }));
  try {
    const server = app("development");
    for (const nextRole of ["admin", "donor"]) {
      role = nextRole;
      const response = await request(server).post("/api/v1/auth/login").send({email: `${role}@example.test`, password: randomBytes(24).toString("hex")});
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, "INVALID_CREDENTIALS");
    }
  } finally {lookup.mock.restore();}
});
