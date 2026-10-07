import { z } from "zod";
import { email } from "./common.js";
export const password = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v, "utf8") <= 72,
    "Password exceeds bcrypt byte limit",
  );
export const register = z
  .object({ name: z.string().trim().min(1).max(120), email, password })
  .strict();
export const login = z
  .object({
    email,
    password: z
      .string()
      .min(1)
      .max(72)
      .refine((v) => Buffer.byteLength(v, "utf8") <= 72),
  })
  .strict();
export const empty = z.object({}).strict();
