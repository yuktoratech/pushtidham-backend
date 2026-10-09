import "dotenv/config";
import { z } from "zod";
const secret = z
  .string()
  .min(32)
  .refine((v) => !/replace|example|changeme/i.test(v), "Use a random secret");
const duration = z.string().regex(/^\d+[smhd]$/);
const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const optionalUrl = z.union([z.literal(""), z.url()]).optional().transform((v) => v || undefined);
const optionalSecret = z.union([z.literal(""), z.string().min(16)]).optional().transform((v) => v || undefined);
export function seconds(value: string): number {
  const factors: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(value.slice(0, -1)) * factors[value.slice(-1)]!;
}
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    JWT_ACCESS_EXPIRES_IN: duration.default("15m"),
    JWT_REFRESH_EXPIRES_IN: duration.default("7d"),
    FRONTEND_URL: z
      .url()
      .refine(
        (v) => new URL(v).origin === v,
        "Use an origin without a trailing slash",
      ),
    COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    ADMIN_SEED_NAME: z.string().optional(),
    ADMIN_SEED_EMAIL: z.string().optional(),
    ADMIN_SEED_PASSWORD: z.string().optional(),
    STRIPE_SECRET_KEY: optionalSecret,
    STRIPE_WEBHOOK_SECRET: optionalSecret,
    STRIPE_API_VERSION: z.literal("2026-09-30.endive").default("2026-09-30.endive"),
    STRIPE_CHECKOUT_SUCCESS_URL: optionalUrl,
    STRIPE_CHECKOUT_CANCEL_URL: optionalUrl,
    STRIPE_CARD_ENABLED: boolean,
    STRIPE_ACH_ENABLED: boolean,
    STRIPE_FINANCIAL_CONNECTIONS_ENABLED: boolean,
    PAYMENT_STATUS_TOKEN_SECRET: optionalSecret,
    STRIPE_CARD_FEE_BPS: z.coerce.number().int().min(0).max(9999).optional(),
    STRIPE_CARD_FEE_FIXED_CENTS: z.coerce.number().int().min(0).optional(),
    STRIPE_ACH_FEE_BPS: z.coerce.number().int().min(0).max(9999).optional(),
    STRIPE_ACH_FEE_FIXED_CENTS: z.coerce.number().int().min(0).optional(),
    STRIPE_ACH_FEE_CAP_CENTS: z.coerce.number().int().min(0).optional(),
    STRIPE_ACH_VERIFICATION_CENTS: z.coerce.number().int().min(0).optional(),
    STRIPE_ACH_COVER_VERIFICATION_COST: boolean,
    STRIPE_RECONCILIATION_MIN_AGE_MINUTES: z.coerce.number().int().min(5).max(10080).default(60),
    STRIPE_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    PAYPAL_CLIENT_ID: optionalSecret,
    PAYPAL_CLIENT_SECRET: optionalSecret,
    PAYPAL_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
    PAYPAL_WEBHOOK_ID: optionalSecret,
    PAYPAL_RETURN_URL: optionalUrl,
    PAYPAL_CANCEL_URL: optionalUrl,
    PAYPAL_ENABLED: boolean,
    PAYPAL_VENMO_ENABLED: boolean,
    PAYPAL_MERCHANT_ID: z.string().trim().min(3).max(255).optional(),
    PAYPAL_FEE_BPS: z.coerce.number().int().min(0).max(9999).optional(),
    PAYPAL_FEE_FIXED_CENTS: z.coerce.number().int().min(0).optional(),
    PAYPAL_RECONCILIATION_MIN_AGE_MINUTES: z.coerce.number().int().min(5).max(10080).default(60),
    PAYPAL_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine((v, c) => {
    if (v.JWT_ACCESS_SECRET === v.JWT_REFRESH_SECRET)
      c.addIssue({
        code: "custom",
        path: ["JWT_REFRESH_SECRET"],
        message: "Secrets must differ",
      });
    if (
      seconds(v.JWT_ACCESS_EXPIRES_IN) > 1800 ||
      seconds(v.JWT_ACCESS_EXPIRES_IN) < 60
    )
      c.addIssue({
        code: "custom",
        path: ["JWT_ACCESS_EXPIRES_IN"],
        message: "Use 60 seconds to 30 minutes",
      });
    if (
      seconds(v.JWT_REFRESH_EXPIRES_IN) > 2592000 ||
      seconds(v.JWT_REFRESH_EXPIRES_IN) < 3600
    )
      c.addIssue({
        code: "custom",
        path: ["JWT_REFRESH_EXPIRES_IN"],
        message: "Use one hour to 30 days",
      });
    if (v.NODE_ENV === "production" && !v.FRONTEND_URL.startsWith("https://"))
      c.addIssue({
        code: "custom",
        path: ["FRONTEND_URL"],
        message: "Production requires HTTPS",
      });
    if (v.COOKIE_SAME_SITE === "none" && v.NODE_ENV !== "production")
      c.addIssue({
        code: "custom",
        path: ["COOKIE_SAME_SITE"],
        message: "Cross-site cookies require production HTTPS",
      });
    const stripeEnabled = v.STRIPE_CARD_ENABLED || v.STRIPE_ACH_ENABLED;
    if (stripeEnabled) {
      for (const key of [
        "STRIPE_SECRET_KEY",
        "STRIPE_CHECKOUT_SUCCESS_URL",
        "STRIPE_CHECKOUT_CANCEL_URL",
        "PAYMENT_STATUS_TOKEN_SECRET",
      ] as const)
        if (!v[key])
          c.addIssue({ code: "custom", path: [key], message: "Required when Stripe checkout is enabled" });
    }
    if (
      v.NODE_ENV === "production" &&
      stripeEnabled &&
      (!v.STRIPE_CHECKOUT_SUCCESS_URL?.startsWith("https://") ||
        !v.STRIPE_CHECKOUT_CANCEL_URL?.startsWith("https://"))
    )
      c.addIssue({
        code: "custom",
        path: ["STRIPE_CHECKOUT_SUCCESS_URL"],
        message: "Production Stripe redirects require HTTPS",
      });
    if (v.PAYPAL_ENABLED) {
      for (const key of [
        "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID",
        "PAYPAL_RETURN_URL", "PAYPAL_CANCEL_URL", "PAYPAL_MERCHANT_ID",
        "PAYMENT_STATUS_TOKEN_SECRET",
      ] as const)
        if (!v[key])
          c.addIssue({ code: "custom", path: [key], message: "Required when PayPal is enabled" });
    }
    if (
      v.NODE_ENV === "production" && v.PAYPAL_ENABLED &&
      (!v.PAYPAL_RETURN_URL?.startsWith("https://") || !v.PAYPAL_CANCEL_URL?.startsWith("https://"))
    )
      c.addIssue({ code: "custom", path: ["PAYPAL_RETURN_URL"], message: "Production PayPal redirects require HTTPS" });
  });
export function loadConfig(input: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Invalid configuration: " +
        result.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; "),
    );
  return result.data;
}
export type Config = ReturnType<typeof loadConfig>;
