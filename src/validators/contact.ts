import {z} from "zod";
import {email} from "./common.js";
export const contactBody = z.object({
  name: z.string().trim().min(1).max(120),
  email,
  phone: z.string().trim().max(30).regex(/^[+0-9() .-]*$/).optional().default(""),
  subject: z.string().trim().min(1).max(150).refine((v) => !/[\r\n]/.test(v)),
  message: z.string().trim().min(1).max(5000),
}).strict();
