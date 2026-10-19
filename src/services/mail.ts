import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { Config } from "../config/env.js";
import { AppError } from "../utils/errors.js";

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};
export interface MailSender {
  send(message: Mail): Promise<void>;
}

export type MailTransport = {
  sendMail(message: Record<string, unknown>): Promise<{
    accepted?: Array<string | { address?: string }>;
  }>;
};

type SmtpConfig = Config & {
  MAIL_PROVIDER: "smtp";
  SMTP_HOST: string;
  SMTP_PORT: 465 | 587;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  MAIL_FROM: string;
  CONTACT_TO: string;
};

export function hasSmtpConfig(config: Config): config is SmtpConfig {
  return (
    config.MAIL_PROVIDER === "smtp" &&
    Boolean(
      config.SMTP_HOST &&
        config.SMTP_PORT &&
        config.SMTP_SECURE !== undefined &&
        config.SMTP_USER &&
        config.SMTP_PASSWORD &&
        config.MAIL_FROM &&
        config.CONTACT_TO,
    )
  );
}

export function smtpTransportOptions(config: SmtpConfig): SMTPTransport.Options {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: config.SMTP_PORT === 587,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return escaped[character]!;
  });
}

/** SMTP acceptance means queued for delivery, not proof of recipient delivery. */
export class SmtpMailSender implements MailSender {
  private readonly transport: MailTransport;

  constructor(
    private readonly config: SmtpConfig,
    transport?: MailTransport,
  ) {
    this.transport =
      transport ??
      (nodemailer.createTransport(smtpTransportOptions(config)) as MailTransport);
  }

  async send(message: Mail) {
    try {
      const result = await this.transport.sendMail({
        from: this.config.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
      if (!result.accepted?.length)
        throw new AppError(
          503,
          "MAIL_UNAVAILABLE",
          "Email service did not confirm acceptance",
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        "MAIL_UNAVAILABLE",
        "Email service is temporarily unavailable",
      );
    }
  }
}
