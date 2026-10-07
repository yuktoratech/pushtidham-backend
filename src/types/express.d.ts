import type { Types } from "mongoose";
declare module "express-serve-static-core" {
  interface Request {
    validated: {
      body?: unknown;
      query?: unknown;
      params?: unknown;
    };
    principal?: {
      id: Types.ObjectId;
      role: "donor" | "admin";
      sessionId: string;
    };
    requestId: string;
  }
}
