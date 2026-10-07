import bcrypt from "bcrypt";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import type { Config } from "../config/env.js";
import { seconds } from "../config/env.js";
import { User } from "../models/user.js";
import { Session } from "../models/session.js";
import { AppError } from "../utils/errors.js";
import { BCRYPT_COST } from "../constants/domain.js";
export const safeUser = (user: {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  status: string;
}) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  role: user.role,
  status: user.status,
});
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const dummyHash = bcrypt.hash(randomBytes(32).toString("hex"), BCRYPT_COST);
const denied = () =>
  new AppError(401, "UNAUTHENTICATED", "Authentication required");
export class AuthService {
  constructor(private config: Config) {}
  private verify(token: string, kind: "access" | "refresh") {
    try {
      const result = jwt.verify(
        token,
        kind === "access"
          ? this.config.JWT_ACCESS_SECRET
          : this.config.JWT_REFRESH_SECRET,
        { algorithms: ["HS256"], issuer: "pushtidham-api", audience: kind },
      );
      if (
        typeof result === "string" ||
        typeof result.sub !== "string" ||
        typeof result.sid !== "string" ||
        result.kind !== kind
      )
        throw denied();
      return result as JwtPayload & {
        sub: string;
        sid: string;
      };
    } catch {
      throw denied();
    }
  }
  private tokens(user: string, sid: string, expiresAt: Date) {
    const payload = { sub: user, sid };
    return {
      accessToken: jwt.sign(
        { ...payload, kind: "access" },
        this.config.JWT_ACCESS_SECRET,
        {
          algorithm: "HS256",
          issuer: "pushtidham-api",
          audience: "access",
          expiresIn: seconds(this.config.JWT_ACCESS_EXPIRES_IN),
          jwtid: randomUUID(),
        },
      ),
      refreshToken: jwt.sign(
        { ...payload, kind: "refresh" },
        this.config.JWT_REFRESH_SECRET,
        {
          algorithm: "HS256",
          issuer: "pushtidham-api",
          audience: "refresh",
          expiresIn: Math.max(
            1,
            Math.floor((expiresAt.getTime() - Date.now()) / 1000),
          ),
          jwtid: randomUUID(),
        },
      ),
      expiresAt,
    };
  }
  private async open(user: InstanceType<typeof User>) {
    const sid = randomUUID();
    const expiresAt = new Date(
      Date.now() + seconds(this.config.JWT_REFRESH_EXPIRES_IN) * 1000,
    );
    const tokens = this.tokens(String(user._id), sid, expiresAt);
    await Session.create({
      sessionId: sid,
      user: user._id,
      tokenHash: hash(tokens.refreshToken),
      expiresAt,
    });
    return { ...tokens, user: safeUser(user) };
  }
  async register(input: { name: string; email: string; password: string }) {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    const user = await User.create({
      name: input.name,
      email: input.email,
      passwordHash,
      role: "donor",
      status: "active",
    });
    return this.open(user);
  }
  async login(input: { email: string; password: string }) {
    const user = await User.findOne({ email: input.email }).select(
      "+passwordHash",
    );
    const valid = await bcrypt.compare(
      input.password,
      user?.passwordHash ?? (await dummyHash),
    );
    if (!user || !valid || user.status !== "active")
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Invalid email or password",
      );
    return this.open(user);
  }
  async refresh(token: string) {
    const claims = this.verify(token, "refresh");
    const session = await Session.findOne({
      sessionId: claims.sid,
      user: claims.sub,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).select("+tokenHash");
    if (!session) throw denied();
    const user = await User.findById(claims.sub);
    if (!user || user.status !== "active") {
      await Session.updateOne(
        { _id: session._id },
        { $set: { revokedAt: new Date() } },
      );
      throw denied();
    }
    const tokens = this.tokens(
      String(user._id),
      session.sessionId,
      session.expiresAt,
    );
    const changed = await Session.findOneAndUpdate(
      {
        _id: session._id,
        tokenHash: hash(token),
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { tokenHash: hash(tokens.refreshToken) } },
    );
    if (!changed) {
      await Session.updateOne(
        { _id: session._id },
        { $set: { revokedAt: new Date() } },
      );
      throw denied();
    }
    return { ...tokens, user: safeUser(user) };
  }
  async logout(token?: string) {
    if (!token) return;
    let claims: ReturnType<AuthService["verify"]>;
    try {
      claims = this.verify(token, "refresh");
    } catch {
      return;
    } // Invalid or expired JWTs cannot refresh; clear their cookie.
    // Database failures must propagate rather than falsely reporting revocation.
    await Session.updateOne(
      { sessionId: claims.sid, user: claims.sub },
      { $set: { revokedAt: new Date() } },
    );
  }
  async authenticate(token: string) {
    const claims = this.verify(token, "access");
    const [user, session] = await Promise.all([
      User.findById(claims.sub),
      Session.exists({
        sessionId: claims.sid,
        user: claims.sub,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
    ]);
    if (!user || user.status !== "active" || !session) throw denied();
    return {
      id: user._id,
      role: user.role as "donor" | "admin",
      sessionId: claims.sid,
    };
  }
}
