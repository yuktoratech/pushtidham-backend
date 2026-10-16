import type {Config} from "../config/env.js";
import {AppError} from "../utils/errors.js";

export type Mail = {to: string; subject: string; text: string; replyTo?: string};
export interface MailSender { send(message: Mail): Promise<void> }

/** Provider acceptance means queued for delivery, not proof of recipient delivery. */
export class ResendMailSender implements MailSender {
  constructor(private config: Config) {}
  async send(message: Mail) {
    if (!this.config.RESEND_API_KEY || !this.config.MAIL_FROM)
      throw new AppError(503, "MAIL_UNAVAILABLE", "Email service is not configured");
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {Authorization: `Bearer ${this.config.RESEND_API_KEY}`, "Content-Type": "application/json"},
        body: JSON.stringify({from: this.config.MAIL_FROM, to: [message.to], subject: message.subject, text: message.text, ...(message.replyTo ? {reply_to: message.replyTo} : {})}),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new AppError(503, "MAIL_UNAVAILABLE", "Email service is temporarily unavailable");
    }
    if (!response.ok) throw new AppError(503, "MAIL_UNAVAILABLE", "Email service is temporarily unavailable");
    const accepted = await response.json() as {id?: unknown};
    if (typeof accepted.id !== "string" || !accepted.id)
      throw new AppError(503, "MAIL_UNAVAILABLE", "Email service did not confirm acceptance");
  }
}
