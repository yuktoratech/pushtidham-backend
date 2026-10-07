import "dotenv/config";
import { z } from "zod";
const secret = z
  .string()
  .min(32)
  .refine((v) => !/replace|example|changeme/i.test(v), "Use a random secret");
const duration = z.string().regex(/^\d+[smhd]$/);
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
