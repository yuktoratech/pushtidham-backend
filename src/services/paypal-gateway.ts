import type { Config } from "../config/env.js";

export type PayPalAmount = { currency_code: string; value: string };
export type PayPalCapture = {
  id: string;
  status: string;
  amount: PayPalAmount;
  supplementary_data?: { related_ids?: { order_id?: string } };
  seller_receivable_breakdown?: {
    paypal_fee?: PayPalAmount;
    net_amount?: PayPalAmount;
    gross_amount?: PayPalAmount;
  };
  payee?: { merchant_id?: string };
  create_time?: string;
  update_time?: string;
};
export type PayPalOrder = {
  id: string;
  status: string;
  intent?: string;
  purchase_units: Array<{
    reference_id?: string;
    custom_id?: string;
    amount: PayPalAmount;
    payee?: { merchant_id?: string };
    payments?: { captures?: PayPalCapture[] };
  }>;
  payment_source?: Record<string, unknown>;
  links?: Array<{ href: string; rel: string; method?: string }>;
};

export interface PayPalGateway {
  createOrder(payload: object, requestId: string): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrder>;
  getCapture(captureId: string): Promise<PayPalCapture>;
  verifyWebhook(headers: Record<string, string | undefined>, event: object): Promise<boolean>;
}

function baseUrl(environment: "sandbox" | "live") {
  return environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

export class PayPalHttpGateway implements PayPalGateway {
  private token?: { value: string; expiresAt: number };
  private readonly base: string;
  constructor(private readonly config: Config) {
    this.base = baseUrl(config.PAYPAL_ENVIRONMENT);
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const encoded = Buffer.from(`${this.config.PAYPAL_CLIENT_ID}:${this.config.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const response = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${encoded}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("PayPal OAuth failed");
    const value = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!value.access_token || !value.expires_in) throw new Error("PayPal OAuth response invalid");
    this.token = { value: value.access_token, expiresAt: Date.now() + value.expires_in * 1000 };
    return value.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const token = await this.accessToken();
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`PayPal request failed (${response.status})`);
    return (await response.json()) as T;
  }

  createOrder(payload: object, requestId: string) {
    return this.request<PayPalOrder>("/v2/checkout/orders", {
      method: "POST", headers: { "PayPal-Request-Id": requestId, Prefer: "return=representation" }, body: JSON.stringify(payload),
    });
  }
  getOrder(orderId: string) { return this.request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`); }
  captureOrder(orderId: string, requestId: string) {
    return this.request<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST", headers: { "PayPal-Request-Id": requestId, Prefer: "return=representation" }, body: "{}",
    });
  }
  getCapture(captureId: string) { return this.request<PayPalCapture>(`/v2/payments/captures/${encodeURIComponent(captureId)}`); }
  async verifyWebhook(headers: Record<string, string | undefined>, event: object) {
    const status = await this.request<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"], webhook_id: this.config.PAYPAL_WEBHOOK_ID,
        webhook_event: event,
      }),
    });
    return status.verification_status === "SUCCESS";
  }
}
