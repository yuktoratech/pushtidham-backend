import bcrypt from "bcrypt";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import type { Config } from "../config/env.js";
import { seconds } from "../config/env.js";
import { User } from "../models/user.js";
import { Session } from "../models/session.js";
import { AppError } from "../utils/errors.js";
import { BCRYPT_COST } from "../constants/domain.js";
import {escapeHtml, type MailSender} from "./mail.js";
export const safeUser = (user: {
  _id: unknown;
  name: string;
  email: string;
  phone?: string;
  role: string;
  status: string;
    canManageGivingCategories?: boolean;
}) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  phone: user.phone ?? "",
  role: user.role,
  status: user.status,
    canManageGivingCategories: user.role === "admin" && user.canManageGivingCategories === true,
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
  async register(input: { name: string; email: string; password: string; phone?: string }) {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    const user = await User.create({
      name: input.name,
      email: input.email,
      phone: input.phone ?? "",
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
    if (user.passwordChangedAt && session.createdAt < user.passwordChangedAt) throw denied();
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
    if (user.passwordChangedAt) {
      const validSession = await Session.exists({sessionId: claims.sid, user: claims.sub, createdAt: {$gte: user.passwordChangedAt}});
      if (!validSession) throw denied();
    }
    return {
      id: user._id,
      role: user.role as "donor" | "admin",
        canManageGivingCategories: user.role === "admin" && user.canManageGivingCategories === true,
      sessionId: claims.sid,
    };
  }
  async updateProfile(userId: string, input: {name: string; email: string; phone: string}) {
    const current = await User.findOne({_id: userId, role: "donor", status: "active"});
    if (!current) throw denied();
    if (input.email.toLowerCase() !== current.email.toLowerCase())
      throw new AppError(400, "EMAIL_CHANGE_NOT_ALLOWED", "Your account email address cannot be changed.");
    const user = await User.findOneAndUpdate(
      {_id: userId, role: "donor", status: "active", email: current.email},
      {$set: {name: input.name, phone: input.phone}},
      {new: true, runValidators: true},
    );
    if (!user) throw denied();
    return safeUser(user);
  }
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await User.findOne({_id: userId, role: "donor", status: "active"}).select("+passwordHash");
    if (!user) throw denied();
    if (!await bcrypt.compare(currentPassword, user.passwordHash))
      throw new AppError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const changedAt = new Date();
    const updated = await User.updateOne({_id: user._id, passwordHash: user.passwordHash}, {$set: {passwordHash, passwordChangedAt: changedAt}});
    if (!updated.modifiedCount) throw new AppError(409, "PASSWORD_CHANGED", "Password changed in another session; please sign in again");
    await Session.updateMany({user: user._id, revokedAt: null}, {$set: {revokedAt: changedAt}});
  }
  async requestPasswordReset(email: string, mail: MailSender | undefined, frontendUrl: string) {
    if (!mail) throw new AppError(503, "MAIL_UNAVAILABLE", "Email service is not configured");
    const user = await User.findOne({email, role: "donor", status: "active"});
    if (!user) return;
    const token = randomBytes(32).toString("hex");
    const resetTokenHash = hash(token);
    await User.updateOne({_id: user._id}, {$set: {resetTokenHash, resetExpiresAt: new Date(Date.now() + 30 * 60_000)}});
    const url = new URL("/reset-password", frontendUrl);
    url.searchParams.set("token", token);
    await mail.send({
      to: user.email,
      subject: "Pushtidham password reset",
      text: `A password reset was requested for your account. This link expires in 30 minutes:\n${url.href}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>A password reset was requested for your account.</p><p><a href="${escapeHtml(url.href)}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
    });
  }
  async resetPassword(token: string, newPassword: string) {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const changedAt = new Date();
    const user = await User.findOneAndUpdate(
      {resetTokenHash: hash(token), resetExpiresAt: {$gt: changedAt}, role: "donor", status: "active"},
      {$set: {passwordHash, passwordChangedAt: changedAt}, $unset: {resetTokenHash: 1, resetExpiresAt: 1}},
    );
    if (!user) throw new AppError(400, "INVALID_RESET_TOKEN", "Reset link is invalid or expired");
    await Session.updateMany({user: user._id, revokedAt: null}, {$set: {revokedAt: changedAt}});
  }
}
