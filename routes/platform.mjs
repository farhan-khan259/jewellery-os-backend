import { upload, storeAttachment } from "./attachments.mjs";
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  Tenant,
  Identity,
  Session,
  Invitation,
  Audit,
  Record,
  Attachment,
  transaction,
  audit,
} from "../db.mjs";
import { z, text, num, date, profileSchema } from "../validation.mjs";
import { platform, fail, hash } from "../security.mjs";
export const admin = Router();
admin.use(platform);
const limits = z.object({
  users: num.min(1).max(500),
  branches: num.min(1).max(100),
  features: z.array(z.string()).min(1),
});
const subscription = z.object({
  plan: text,
  status: z.enum([
    "trial",
    "active",
    "grace",
    "expired",
    "suspended",
    "archived",
  ]),
  expiresAt: date,
  graceUntil: z.union([date, z.literal("")]).optional(),
  billingCycle: z.enum(["monthly", "yearly"]),
  paymentStatus: z.enum(["paid", "unpaid", "pending"]),
  limits,
});
admin.get("/overview", async (req, res) => {
  const shops = await Tenant.find().sort({ createdAt: -1 }).lean();
  res.json({
    shops,
    events: await Audit.find({ action: /^(platform|login)/ })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean(),
  });
});
admin.get("/tenants", async (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  res.json(
    (await Tenant.find().sort({ createdAt: -1 }).limit(1000).lean()).filter(
      (s) => s.name.toLowerCase().includes(q),
    ),
  );
});
admin.post("/tenants", async (req, res) => {
  const d = z
    .object({
      name: text,
      username: text,
      ownerName: text,
      subscription,
      profile: profileSchema.optional(),
    })
    .parse(req.body);
  const temporary = crypto.randomBytes(16).toString("base64url"),
    hashed = await bcrypt.hash(temporary, 12);
  let t, u;
  await transaction(async (session) => {
    [t] = await Tenant.create(
      [
        {
          name: d.name,
          ...d.subscription,
          graceUntil: d.subscription.graceUntil || undefined,
          profile: d.profile || { name: d.name },
        },
      ],
      { session },
    );
    [u] = await Identity.create(
      [
        {
          username: d.username.toLowerCase(),
          name: d.ownerName,
          password: hashed,
          type: "tenantUser",
          role: "owner",
          tenantId: t._id,
        },
      ],
      { session },
    );
    await Record.create(
      [
        {
          tenantId: t._id,
          branch: "main",
          kind: "branches",
          key: "main",
          data: { name: "Main branch" },
        },
      ],
      { session },
    );
    await audit(
      req,
      "platform.shop.created",
      t._id,
      null,
      { name: t.name, owner: u.username, subscription: d.subscription },
      "Provisioned by administrator",
      session,
    );
  });
  res
    .status(201)
    .json({ tenant: t, username: u.username, temporaryPassword: temporary });
});
admin.get("/tenants/:id", async (req, res) => {
  const t = await Tenant.findById(req.params.id);
  if (!t) throw fail(404, "NOT_FOUND");
  res.json({
    tenant: t,
    users: await Identity.find({ tenantId: t._id }).lean(),
    branches: await Record.find({ tenantId: t._id, kind: "branches" }).lean(),
    storage:
      (
        await Attachment.aggregate([
          { $match: { tenantId: t._id } },
          { $group: { _id: null, bytes: { $sum: "$size" } } },
        ])
      )[0]?.bytes || 0,
    events: await Audit.find({
      $or: [{ target: String(t._id) }, { tenantId: t._id }],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  });
});
admin.patch("/tenants/:id", async (req, res) => {
  const d = z
    .object({
      name: text,
      subscription,
      profile: profileSchema.optional(),
      notes: z.string().max(5000).default(""),
      reason: text,
    })
    .parse(req.body);
  await transaction(async (session) => {
    const t = await Tenant.findById(req.params.id).session(session);
    if (!t) throw fail(404, "NOT_FOUND");
    const before = t.toObject();
    Object.assign(t, {
      name: d.name,
      ...d.subscription,
      graceUntil: d.subscription.graceUntil || null,
      notes: d.notes,
    });
    if (d.profile) t.profile = d.profile;
    await t.save({ session });
    await Record.create(
      [
        {
          tenantId: t._id,
          kind: "subscriptions",
          branch: "main",
          data: { ...d.subscription, reason: d.reason },
          actor: req.user.username,
        },
      ],
      { session },
    );
    if (["suspended", "archived", "expired"].includes(t.status)) {
      const ids = await Identity.find({ tenantId: t._id })
        .distinct("_id")
        .session(session);
      await Session.deleteMany({ userId: { $in: ids } }, { session });
    }
    await audit(
      req,
      "platform.shop.updated",
      t._id,
      before,
      t.toObject(),
      d.reason,
      session,
    );
  });
  res.json({ ok: true });
});
admin.post("/users/:id/reset", async (req, res) => {
  const d = z.object({ reason: text }).parse(req.body),
    token = crypto.randomBytes(32).toString("hex");
  let u;
  await transaction(async (session) => {
    u = await Identity.findOne({
      _id: req.params.id,
      type: "tenantUser",
    }).session(session);
    if (!u) throw fail(404, "NOT_FOUND");
    await Invitation.deleteMany({ userId: u._id }, { session });
    await Invitation.create(
      [
        {
          userId: u._id,
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + 30 * 60000),
        },
      ],
      { session },
    );
    u.firstLoginChangeRequired = true;
    u.password = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    await u.save({ session });
    await Session.deleteMany({ userId: u._id }, { session });
    await audit(
      req,
      "platform.access.reset",
      u.tenantId,
      null,
      { user: u.username },
      d.reason,
      session,
    );
  });
  res.json({ accessPath: `/access?invite=${token}`, expiresInMinutes: 30 });
});
admin.post("/users/:id/status", async (req, res) => {
  const d = z
    .object({ status: z.enum(["active", "revoked"]), reason: text })
    .parse(req.body);
  await transaction(async (session) => {
    const u = await Identity.findOne({
      _id: req.params.id,
      type: "tenantUser",
    }).session(session);
    if (!u) throw fail(404, "NOT_FOUND");
    const before = u.status;
    u.status = d.status;
    await u.save({ session });
    await Session.deleteMany({ userId: u._id }, { session });
    await audit(
      req,
      "platform.access.status",
      u.tenantId,
      { status: before },
      { user: u.username, status: d.status },
      d.reason,
      session,
    );
  });
  res.json({ ok: true });
});
admin.get("/audit", async (req, res) =>
  res.json(await Audit.find().sort({ createdAt: -1 }).limit(200).lean()),
);
admin.post("/support", async (req, res) => {
  const d = z
    .object({ tenantId: z.string().regex(/^[a-f\d]{24}$/i), note: text })
    .parse(req.body);
  if (!(await Tenant.exists({ _id: d.tenantId }))) throw fail(404, "NOT_FOUND");
  await audit(
    req,
    "platform.support.note",
    d.tenantId,
    null,
    { note: d.note },
    d.note,
  );
  res.json({ ok: true });
});

admin.post("/tenants/:id/logo", upload.single("file"), async (req, res) => {
  req.tenant = await Tenant.findById(req.params.id);
  if (!req.tenant) throw fail(404, "NOT_FOUND");
  req.branch = "main";
  await storeAttachment(req, res);
});
