import crypto from "node:crypto";
import { Identity, Session, Tenant, Audit, Record } from "./db.mjs";
export const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const fail = (status, code, message = code) =>
  Object.assign(Error(message), { status, code });
export const cookieName =
  process.env.NODE_ENV === "production" ? "__Host-jos" : "jos";
export const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  username: u.username,
  type: u.type,
  role: u.role,
  branches: u.branches,
  language: u.language,
  firstLoginChangeRequired: u.firstLoginChangeRequired,
  totpEnabled: u.totpEnabled,
  status: u.status,
});
export async function issueSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex"),
    csrf = crypto.randomBytes(24).toString("hex");
  const hours = Math.max(
    1,
    Math.min(24, Number(process.env.SESSION_HOURS) || 8),
  );
  await Session.create({
    tokenHash: hash(token),
    csrf,
    userId: user._id,
    expiresAt: new Date(Date.now() + hours * 3600000),
  });
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: hours * 3600000,
  });
  return csrf;
}
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies[cookieName];
    if (!token)
      throw fail(401, "AUTH_REQUIRED", "Enter your issued credentials");
    const session = await Session.findOne({
      tokenHash: hash(token),
      expiresAt: { $gt: new Date() },
    });
    if (!session)
      throw fail(401, "SESSION_EXPIRED", "Session expired. Sign in again");
    const user = await Identity.findById(session.userId);
    if (!user || user.status !== "active") throw fail(401, "ACCESS_REVOKED");
    req.user = user;
    req.session = session;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("x-csrf-token") !== session.csrf
    )
      throw fail(403, "CSRF_INVALID");
    if (user.type === "tenantUser") {
      req.tenant = await Tenant.findById(user.tenantId);
      if (!req.tenant) throw fail(403, "ACCESS_REVOKED");
    }
    next();
  } catch (e) {
    next(e);
  }
}
export function platform(req, res, next) {
  if (req.user.firstLoginChangeRequired)
    return next(fail(403, "PASSWORD_CHANGE_REQUIRED"));
  if (req.user.type !== "platformAdmin")
    return next(fail(403, "PLATFORM_ONLY"));
  next();
}
export async function tenantAccess(req, res, next) {
  if (req.user.type !== "tenantUser" || !req.tenant)
    return next(fail(403, "SHOP_ONLY"));
  if (req.user.firstLoginChangeRequired)
    return next(fail(403, "PASSWORD_CHANGE_REQUIRED"));
  const t = req.tenant;
  let state = t.status;
  if (
    ["trial", "active", "grace"].includes(state) &&
    t.expiresAt &&
    t.expiresAt < new Date()
  )
    state = t.graceUntil > new Date() ? "grace" : "expired";
  req.accessState = state;
  if (req.user.role !== "owner") {
    const enabled = await Identity.find({ tenantId: t._id, status: "active" })
      .sort({ createdAt: 1 })
      .limit(t.limits.users)
      .select("_id");
    if (!enabled.some((u) => u._id.equals(req.user._id)))
      return next(
        fail(403, "PLAN_LIMIT", "User limit exceeded. Contact the shop owner"),
      );
  }

  if (["suspended", "archived"].includes(state))
    return next(
      fail(
        403,
        "ACCOUNT_SUSPENDED",
        "Shop access is suspended. Contact Ahmed Solutions",
      ),
    );
  if (state === "expired" && !["GET", "HEAD"].includes(req.method))
    return next(
      fail(
        403,
        "ACCOUNT_EXPIRED",
        "Plan expired. Contact Ahmed Solutions to renew",
      ),
    );
  req.branch = String(req.get("x-branch") || req.user.branches[0] || "main");
  if (!req.user.branches.includes(req.branch))
    return next(fail(403, "BRANCH_DENIED"));
  if (!["GET", "HEAD"].includes(req.method)) {
    const entitled = await Record.find({ tenantId: t._id, kind: "branches" })
      .sort({ createdAt: 1 })
      .limit(t.limits.branches)
      .select("key");
    if (!entitled.some((b) => b.key === req.branch))
      return next(fail(403, "PLAN_LIMIT", "Branch limit exceeded"));
  }
  next();
}
const permissions = {
  owner: ["*"],
  manager: [
    "dashboard",
    "inventory",
    "customers",
    "rates:read",
    "sales",
    "payments",
    "old-gold",
    "karigars",
    "orders",
    "repairs",
    "audits",
    "reconciliation",
    "reports",
    "attachments",
    "notifications",
  ],
  cashier: [
    "dashboard",
    "inventory:read",
    "customers",
    "rates:read",
    "sales",
    "payments",
    "orders:read",
    "repairs:read",
    "attachments:read",
    "notifications",
  ],
  accountant: [
    "dashboard",
    "customers:read",
    "sales:read",
    "payments",
    "expenses",
    "reports",
    "reconciliation",
    "rates:read",
    "old-gold:read",
    "notifications",
  ],
  inventory: ["inventory", "rates:read", "audits", "attachments"],
  coordinator: [
    "karigars",
    "inventory:read",
    "orders",
    "repairs",
    "rates:read",
    "attachments",
    "notifications",
  ],
  auditor: [
    "reports",
    "audit-logs",
    "reconciliation:read",
    "audits:read",
    "rates:read",
  ],
};
export function permit(module) {
  return (req, res, next) => {
    const p = permissions[req.user.role] || [],
      read = ["GET", "HEAD"].includes(req.method);
    if (
      !p.includes("*") &&
      !p.includes(module) &&
      !(read && p.includes(module + ":read"))
    )
      return next(
        fail(403, "FORBIDDEN", "Your role does not allow this action"),
      );
    const features = req.tenant.limits.features || [];
    if (
      !features.includes("*") &&
      !["dashboard", "settings", "attachments", "notifications"].includes(
        module,
      ) &&
      !features.includes(module)
    )
      return next(
        fail(403, "PLAN_LIMIT", "This feature is not included in your plan"),
      );
    next();
  };
}
export function scope(req, extra = {}) {
  return { tenantId: req.tenant._id, branch: req.branch, ...extra };
}
export async function findRecord(req, kind, id, session) {
  if (!/^[a-f\d]{24}$/i.test(String(id))) throw fail(404, "NOT_FOUND");
  const r = await Record.findOne(scope(req, { kind, _id: id })).session(
    session || null,
  );
  if (!r) throw fail(404, "NOT_FOUND");
  return r;
}
export function redact(req, record) {
  const r = record.toObject ? record.toObject() : structuredClone(record);
  if (req.user.role !== "owner") {
    if (r.data) {
      delete r.data.cost;
      delete r.data.margin;
      delete r.data.profit;
    }
    if (r.lines) r.lines = r.lines.map(({ cost, ...rest }) => rest);
  }
  return r;
}
export const roles = Object.keys(permissions);
export function totp(secret, offset = 0) {
  const key = Buffer.from(secret, "hex"),
    b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac("sha1", key).update(b).digest(),
    o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}
export function verifyTotp(secret, code) {
  return (
    typeof code === "string" &&
    /^\d{6}$/.test(code) &&
    [-1, 0, 1].some((n) =>
      crypto.timingSafeEqual(Buffer.from(totp(secret, n)), Buffer.from(code)),
    )
  );
}
export function base32(hex) {
  let bits = "";
  for (const b of Buffer.from(hex, "hex"))
    bits += b.toString(2).padStart(8, "0");
  return bits
    .match(/.{1,5}/g)
    .map(
      (v) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(v.padEnd(5, "0"), 2)],
    )
    .join("");
}

export function hideSensitive(value) {
  if (Array.isArray(value)) return value.map(hideSensitive);
  if (value && typeof value === "object" && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !["cost", "profit", "margin", "password", "totpSecret"].includes(k),
        )
        .map(([k, v]) => [k, hideSensitive(v)]),
    );
  return value;
}
