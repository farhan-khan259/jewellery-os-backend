import mongoose from "mongoose";
const { Schema } = mongoose;
const common = { timestamps: true, strict: "throw" };
const tenantSchema = new Schema(
  {
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ["trial", "active", "grace", "expired", "suspended", "archived"],
      default: "trial",
    },
    plan: { type: String, default: "starter" },
    expiresAt: Date,
    graceUntil: Date,
    billingCycle: { type: String, default: "monthly" },
    paymentStatus: { type: String, default: "unpaid" },
    limits: {
      users: { type: Number, default: 2 },
      branches: { type: Number, default: 1 },
      features: { type: [String], default: ["*"] },
    },
    profile: { type: Schema.Types.Mixed, default: {} },
    notes: String,
  },
  common,
);
const identitySchema = new Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    password: { type: String, required: true, select: false },
    type: {
      type: String,
      enum: ["platformAdmin", "tenantUser"],
      required: true,
    },
    tenantId: { type: Schema.Types.ObjectId, index: true },
    role: { type: String, default: "owner" },
    branches: { type: [String], default: ["main"] },
    status: { type: String, default: "active" },
    firstLoginChangeRequired: { type: Boolean, default: true },
    language: { type: String, default: "en" },
    totpSecret: { type: String, select: false },
    totpEnabled: { type: Boolean, default: false },
  },
  common,
);
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, unique: true },
    csrf: String,
    userId: { type: Schema.Types.ObjectId, index: true },
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
  },
  common,
);
const recordSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    branch: { type: String, default: "main" },
    kind: { type: String, required: true },
    key: String,
    data: { type: Schema.Types.Mixed, required: true },
    actor: String,
  },
  common,
);
recordSchema.index({ tenantId: 1, kind: 1, branch: 1, createdAt: -1 });
recordSchema.index(
  { tenantId: 1, kind: 1, key: 1 },
  { unique: true, partialFilterExpression: { key: { $type: "string" } } },
);
const saleSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    branch: String,
    number: String,
    idempotencyKey: String,
    customerId: String,
    customer: Schema.Types.Mixed,
    profile: Schema.Types.Mixed,
    lines: [Schema.Types.Mixed],
    totals: Schema.Types.Mixed,
    payments: [Schema.Types.Mixed],
    oldGold: Schema.Types.Mixed,
    rateSnapshot: Schema.Types.Mixed,
    cashier: String,
    status: { type: String, default: "issued" },
    voidReason: String,
    orderId: String,
  },
  common,
);
saleSchema.index({ tenantId: 1, number: 1 }, { unique: true });
saleSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
const auditSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, index: true },
    actor: String,
    action: String,
    target: String,
    reason: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
  },
  common,
);
const invitationSchema = new Schema(
  {
    userId: Schema.Types.ObjectId,
    tokenHash: { type: String, unique: true },
    expiresAt: Date,
    consumedAt: Date,
  },
  common,
);
const attachmentSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, index: true },
    branch: String,
    mime: String,
    size: Number,
    name: String,
    storageKey: String,
    backend: String,
  },
  common,
);
export const Tenant = mongoose.model("Tenant", tenantSchema),
  Identity = mongoose.model("Identity", identitySchema),
  Session = mongoose.model("Session", sessionSchema),
  Record = mongoose.model("Record", recordSchema),
  Sale = mongoose.model("Sale", saleSchema),
  Audit = mongoose.model("Audit", auditSchema),
  Invitation = mongoose.model("Invitation", invitationSchema),
  Attachment = mongoose.model("Attachment", attachmentSchema);
export const Counter = mongoose.model(
  "Counter",
  new Schema({ _id: String, value: Number }),
);
export async function connect(uri = process.env.MONGODB_URI) {
  if (!uri) throw Error("Set MONGODB_URI to a MongoDB replica set");
  await mongoose.connect(uri);
  await Promise.all(
    [
      Tenant,
      Identity,
      Session,
      Record,
      Sale,
      Counter,
      Invitation,
      Audit,
      Attachment,
    ].map((m) => m.init()),
  );
}
export async function transaction(fn) {
  return mongoose.connection.transaction(fn);
}
export async function number(tenant, prefix, session) {
  const c = await Counter.findOneAndUpdate(
    { _id: `${tenant}:${prefix}` },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  return `${prefix}-${String(c.value).padStart(6, "0")}`;
}
export async function audit(
  req,
  action,
  target,
  before,
  after,
  reason = "",
  session,
) {
  await Audit.create(
    [
      {
        tenantId: req.tenant?._id,
        actor: req.user?.username || "system",
        action,
        target: String(target || ""),
        reason,
        before,
        after,
      },
    ],
    { session },
  );
}
export async function addRecord(req, kind, data, session, key) {
  const [r] = await Record.create(
    [
      {
        tenantId: req.tenant._id,
        branch: req.branch || "main",
        kind,
        data,
        actor: req.user.username,
        ...(key ? { key } : {}),
      },
    ],
    { session },
  );
  return r;
}
