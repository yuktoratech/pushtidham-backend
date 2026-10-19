import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import {
  hasSmtpConfig,
  SmtpMailSender,
  smtpTransportOptions,
  type MailTransport,
} from "../src/services/mail.js";

const base = {
  NODE_ENV: "test",
  PORT: "4000",
  MONGODB_URI: "mongodb://127.0.0.1/test",
  JWT_ACCESS_SECRET: randomBytes(40).toString("hex"),
  JWT_REFRESH_SECRET: randomBytes(40).toString("hex"),
  FRONTEND_URL: "http://localhost:3000",
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

function smtpConfig(port: 465 | 587, secure: boolean) {
  const config = loadConfig(smtpEnv(port, secure));
  assert.ok(hasSmtpConfig(config));
  return config;
}

function smtpEnv(port: 465 | 587, secure: boolean) {
  return {
    ...base,
    MAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: String(port),
    SMTP_SECURE: String(secure),
    SMTP_USER: "mailer@example.test",
    SMTP_PASSWORD: "development-app-password",
    MAIL_FROM: "mailer@example.test",
    CONTACT_TO: "temple@example.test",
  };
}

class MockTransport implements MailTransport {
  messages: Array<Record<string, unknown>> = [];
  constructor(
    private readonly result: "accepted" | "rejected" | "failure" = "accepted",
  ) {}
  async sendMail(message: Record<string, unknown>) {
    this.messages.push(message);
    if (this.result === "failure") throw new Error("provider detail must stay private");
    return { accepted: this.result === "accepted" ? [String(message.to)] : [] };
  }
}

test("SMTP configuration supports implicit TLS and mandatory STARTTLS", () => {
  const implicit = smtpTransportOptions(smtpConfig(465, true));
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false);
  assert.equal(implicit.tls?.rejectUnauthorized, true);
  assert.equal(implicit.tls?.minVersion, "TLSv1.2");
  assert.equal(implicit.disableFileAccess, true);
  assert.equal(implicit.disableUrlAccess, true);

  const starttls = smtpTransportOptions(smtpConfig(587, false));
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true);
});

test("SMTP configuration rejects missing, mismatched and URL-style settings", () => {
  assert.throws(() => loadConfig({ ...base, MAIL_PROVIDER: "smtp" }));
  assert.throws(() =>
    loadConfig({
      ...smtpEnv(465, true),
      SMTP_SECURE: "false",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...base,
      MAIL_PROVIDER: "smtp",
      SMTP_HOST: "smtp://example.test:465",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "mailer@example.test",
      SMTP_PASSWORD: "development-app-password",
      MAIL_FROM: "mailer@example.test",
      CONTACT_TO: "temple@example.test",
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...smtpEnv(465, true),
      MAIL_FROM: "not-an-email-address",
    }),
  );
});

test("contact mail uses fixed sender, visitor Reply-To and escaped HTML", async () => {
  const config = smtpConfig(465, true);
  const transport = new MockTransport();
  const app = createApp(config, {
    mail: new SmtpMailSender(config, transport),
  });
  const response = await request(app)
    .post("/api/v1/contact")
    .set("Origin", config.FRONTEND_URL)
    .send({
      name: "Donor <script>alert(1)</script>",
      email: "visitor@example.test",
      subject: "Temple visit",
      message: "Hello <img src=x onerror=alert(1)> & thank you",
    });
  assert.equal(response.status, 202);
  assert.equal(transport.messages.length, 1);
  const sent = transport.messages[0]!;
  assert.equal(sent.from, config.MAIL_FROM);
  assert.equal(sent.to, config.CONTACT_TO);
  assert.equal(sent.replyTo, "visitor@example.test");
  assert.doesNotMatch(String(sent.html), /<script>|<img/i);
  assert.match(String(sent.html), /&lt;script&gt;/);
  assert.match(String(sent.html), /&amp; thank you/);
});

test("SMTP rejection and transport failures return only sanitized unavailable errors", async () => {
  for (const result of ["rejected", "failure"] as const) {
    const config = smtpConfig(587, false);
    const app = createApp(config, {
      mail: new SmtpMailSender(config, new MockTransport(result)),
    });
    const response = await request(app)
      .post("/api/v1/contact")
      .set("Origin", config.FRONTEND_URL)
      .send({
        name: "Donor",
        email: "visitor@example.test",
        subject: "Temple visit",
        message: "Please advise",
      });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "MAIL_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(response.body), /provider detail/i);
  }
});

test("contact origin and rate-limit protections remain active", async () => {
  const config = smtpConfig(465, true);
  const transport = new MockTransport();
  const app = createApp(config, {
    mail: new SmtpMailSender(config, transport),
  });
  const body = {
    name: "Donor",
    email: "visitor@example.test",
    subject: "Temple visit",
    message: "Please advise",
  };
  assert.equal(
    (
      await request(app)
        .post("/api/v1/contact")
        .set("Origin", "https://untrusted.example")
        .send(body)
    ).status,
    403,
  );
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal(
      (
        await request(app)
          .post("/api/v1/contact")
          .set("Origin", config.FRONTEND_URL)
          .send(body)
      ).status,
      202,
    );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/contact")
        .set("Origin", config.FRONTEND_URL)
        .send(body)
    ).status,
    429,
  );
});
