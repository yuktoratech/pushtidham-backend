import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    sessionId: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
  },
  { timestamps: true },
);
schema.index({ sessionId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ user: 1, revokedAt: 1 });
export const Session = model("Session", schema);
