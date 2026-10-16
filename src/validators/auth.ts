import { z } from "zod";
import { email } from "./common.js";
export const password = z
  .string()
  .min(8)
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v, "utf8") <= 72,
    "Password exceeds bcrypt byte limit",
  );
export const register = z
  .object({ name: z.string().trim().min(1).max(120), email, password, phone: z.string().trim().max(30).regex(/^[+0-9() .-]*$/).optional() })
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
export const profile = z.object({
  name: z.string().trim().min(1).max(120),
  email,
  phone: z.string().trim().max(30).regex(/^[+0-9() .-]*$/, "Invalid phone number"),
}).strict();
export const changePassword = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
  confirmPassword: z.string(),
}).strict().refine((value) => value.newPassword === value.confirmPassword, {
  path: ["confirmPassword"], message: "Passwords do not match",
}).refine((value) => value.newPassword !== value.currentPassword, {
  path: ["newPassword"], message: "Choose a different password",
});
export const forgotPassword = z.object({ email }).strict();
export const resetPassword = z.object({
  token: z.string().min(32).max(256),
  newPassword: password,
  confirmPassword: z.string(),
}).strict().refine((value) => value.newPassword === value.confirmPassword, {
  path: ["confirmPassword"], message: "Passwords do not match",
});
