import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Identity, Session, Invitation, Audit, transaction } from "../db.mjs";
import { z } from "../validation.mjs";
import {
  authenticate,
  issueSession,
  publicUser,
  cookieName,
  fail,
  hash,
  verifyTotp,
  base32,
} from "../security.mjs";
export const access = Router();
const limit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: {
      code: "TOO_MANY_ATTEMPTS",
      message: "Too many attempts. Try again in 15 minutes.",
    },
  },
});
const password = z.string().min(12).max(128);
const dummy = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);
access.post("/sign-in", limit, async (req, res) => {
  const d = z
    .object({
      username: z.string().min(1).max(200),
      password: z.string().max(128),
      portal: z.enum(["shop", "admin"]).default("shop"),
      code: z.string().optional(),
    })
    .parse(req.body);
  const u = await Identity.findOne({
    username: d.username.toLowerCase().trim(),
    type: d.portal === "admin" ? "platformAdmin" : "tenantUser",
  }).select("+password +totpSecret");
  const valid = await bcrypt.compare(d.password, u?.password || dummy);
  if (
    !u ||
    !valid ||
    u.status !== "active" ||
    (u.totpEnabled && !verifyTotp(u.totpSecret, d.code))
  ) {
    await Audit.create({
      action: "login.failed",
      actor: d.username.slice(0, 200),
      reason: "Invalid credentials",
    });
    throw fail(
      401,
      "INVALID_CREDENTIALS",
      "Credentials or verification code are incorrect",
    );
  }
  const csrf = await issueSession(res, u);
  await Audit.create({
    tenantId: u.tenantId,
    actor: u.username,
    action: "login.success",
  });
  res.json({ user: publicUser(u), csrf });
});
access.post("/logout", authenticate, async (req, res) => {
  await Session.deleteOne({ _id: req.session._id });
  res.clearCookie(cookieName, { path: "/" });
  await Audit.create({
    tenantId: req.user.tenantId,
    actor: req.user.username,
    action: "logout",
  });
  res.json({ ok: true });
});
access.post("/change-password", authenticate, limit, async (req, res) => {
  const d = z.object({ currentPassword: z.string(), password }).parse(req.body),
    u = await Identity.findById(req.user._id).select("+password");
  if (!(await bcrypt.compare(d.currentPassword, u.password)))
    throw fail(400, "INVALID_CREDENTIALS", "Current password is incorrect");
  if (d.currentPassword === d.password)
    throw fail(400, "PASSWORD_DIFFERENT", "Choose a different password");
  u.password = await bcrypt.hash(d.password, 12);
  u.firstLoginChangeRequired = false;
  await transaction(async (session) => {
    await u.save({ session });
    await Session.deleteMany({ userId: u._id }, { session });
    await Invitation.deleteMany({ userId: u._id }, { session });
    await Audit.create(
      [{ tenantId: u.tenantId, actor: u.username, action: "password.changed" }],
      { session },
    );
  });
  res.json({ csrf: await issueSession(res, u), user: publicUser(u) });
});
access.post("/accept-invitation", limit, async (req, res) => {
  const d = z
      .object({ token: z.string().min(32).max(128), password })
      .parse(req.body),
    hashed = await bcrypt.hash(d.password, 12);
  let u;
  await transaction(async (session) => {
    const invitation = await Invitation.findOneAndUpdate(
      {
        tokenHash: hash(d.token),
        expiresAt: { $gt: new Date() },
        consumedAt: null,
      },
      { $set: { consumedAt: new Date() } },
      { new: true, session },
    );
    if (!invitation)
      throw fail(
        400,
        "INVITATION_INVALID",
        "This access link has expired or already been used",
      );
    u = await Identity.findById(invitation.userId).session(session);
    if (!u || u.status !== "active") throw fail(403, "ACCESS_REVOKED");
    u.password = hashed;
    u.firstLoginChangeRequired = false;
    await u.save({ session });
    await Session.deleteMany({ userId: u._id }, { session });
    await Audit.create(
      [
        {
          tenantId: u.tenantId,
          actor: u.username,
          action: "invitation.accepted",
        },
      ],
      { session },
    );
  });
  res.json({ user: publicUser(u), csrf: await issueSession(res, u) });
});
access.post("/2fa/setup", authenticate, async (req, res) => {
  if (req.user.type !== "platformAdmin" && req.user.role !== "owner")
    throw fail(403, "FORBIDDEN");
  if (req.user.totpEnabled) throw fail(409, "ALREADY_ENABLED");
  const secret = crypto.randomBytes(20).toString("hex");
  await Identity.updateOne(
    { _id: req.user._id },
    { $set: { totpSecret: secret } },
  );
  res.json({
    secret: base32(secret),
    uri: `otpauth://totp/JewellerOS:${encodeURIComponent(req.user.username)}?secret=${base32(secret)}&issuer=JewellerOS`,
  });
});
access.post("/2fa/enable", authenticate, async (req, res) => {
  const u = await Identity.findById(req.user._id).select("+totpSecret");
  if (!u.totpSecret || !verifyTotp(u.totpSecret, req.body.code))
    throw fail(400, "INVALID_CODE", "Incorrect verification code");
  u.totpEnabled = true;
  await u.save();
  await Session.deleteMany({ userId: u._id, _id: { $ne: req.session._id } });
  res.json({ ok: true });
});
