import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  Record,
  Sale,
  Audit,
  Tenant,
  Identity,
  Session,
  transaction,
  addRecord,
  audit,
  number,
} from "../db.mjs";
import { z, text, num, id, profileSchema } from "../validation.mjs";
import {
  permit,
  scope,
  findRecord,
  redact,
  fail,
  publicUser,
  roles,
  hideSensitive,
} from "../security.mjs";
import { money, mg, pure, reconciliation } from "../services/math.mjs";
export const control = Router();
export async function overview(req) {
  const records = await Record.find(scope(req)).lean(),
    sales = await Sale.find(scope(req, { status: "issued" }))
      .sort({ createdAt: -1 })
      .lean();
  const kind = (k) => records.filter((r) => r.kind === k),
    sum = (r, f) => r.reduce((s, x) => s + (f(x) || 0), 0);
  const localDay = (d) =>
      new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }),
    today = localDay(new Date());
  const inventory = kind("inventory").filter(
      (i) => i.data.status === "in-stock",
    ),
    ledger = kind("customerLedger"),
    rates =
      kind("rates").sort((a, b) => b.createdAt - a.createdAt)[0]?.data.rates ||
      {},
    karigar = kind("karigarLedger"),
    old = kind("old-gold");
  const dues = {};
  for (const r of ledger)
    dues[r.data.customerId] = (dues[r.data.customerId] || 0) + r.data.amount;
  const openOrders = kind("orders").filter(
      (o) => o.data.status !== "delivered",
    ),
    openRepairs = kind("repairs").filter((o) => o.data.status !== "delivered");
  const returns = kind("returns");
  const salesToday = sales.filter((s) => localDay(s.createdAt) === today);
  const cash = sum(
    kind("payments").filter((p) => p.data.method === "cash"),
    (r) => r.data.amount,
  );
  const buckets = {};
  for (const s of sales) {
    const day = localDay(s.createdAt);
    buckets[day] = (buckets[day] || 0) + s.totals.total;
  }
  const result = {
    rates,
    stats: {
      goldInShopMg: sum(
        inventory.filter((i) => i.data.metal === "gold"),
        (r) => r.data.netMg,
      ),
      karigarPureMg: sum(karigar, (r) => r.data.pureMg),
      oldGoldMg: sum(old, (r) => r.data.remainingMg),
      amanatMg: sum(kind("amanat"), (r) => r.data.weightMg),
      repairMg: sum(openRepairs, (r) => mg(r.data.weight)),
      salesToday:
        sum(salesToday, (s) => s.totals.total) -
        sum(
          returns.filter((r) => localDay(r.createdAt) === today),
          (r) => r.data.credit,
        ),
      paymentsToday: sum(
        kind("payments").filter(
          (p) =>
            localDay(p.createdAt) === today &&
            p.data.amount > 0 &&
            p.data.customerId,
        ),
        (p) => p.data.amount,
      ),
      cash,
      receivables: Object.values(dues).reduce((s, n) => s + Math.max(0, n), 0),
      inventoryCount: inventory.length,
      pendingOrders: openOrders.length,
      pendingRepairs: openRepairs.length,
    },
    recentSales: sales.slice(0, 6).map((r) => redact(req, r)),
    orders: openOrders.slice(0, 8),
    repairs: openRepairs.slice(0, 8),
    trend: Object.entries(buckets)
      .sort()
      .slice(-14)
      .map(([date, total]) => ({ date, total })),
    notifications: [
      ...kind("notifications"),
      ...openOrders
        .concat(openRepairs)
        .filter((r) => new Date(r.data.dueDate) < new Date())
        .map((r) => ({
          _id: r._id,
          data: {
            name: r.data.name,
            notes: "Overdue · " + r.key,
            level: "warning",
          },
        })),
    ].slice(-30),
    customerBalances: dues,
  };
  if (req.user.role === "owner")
    result.stats.profit =
      sales.reduce(
        (s, x) =>
          s +
          x.totals.subtotal -
          x.totals.discount -
          x.lines.reduce((n, l) => n + l.cost, 0),
        0,
      ) -
      sum(kind("expenses"), (r) => money(r.data.amount)) -
      sum(returns, (r) => (r.data.netRevenue || 0) - (r.data.cost || 0));
  return result;
}
control.get("/dashboard", permit("dashboard"), async (req, res) =>
  res.json(await overview(req)),
);
control.get("/notifications", permit("notifications"), async (req, res) =>
  res.json((await overview(req)).notifications),
);
control.get("/audit-logs", permit("audit-logs"), async (req, res) =>
  res.json(
    hideSensitive(
      await Audit.find({ tenantId: req.tenant._id })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ),
  ),
);
control.post("/audits", permit("audits"), async (req, res) => {
  const name = text.parse(req.body.name);
  let a;
  await transaction(async (session) => {
    const items = await Record.find(
      scope(req, { kind: "inventory", "data.status": "in-stock" }),
    ).session(session);
    a = await addRecord(
      req,
      "audits",
      {
        name,
        status: "open",
        expected: items.map((i) => ({
          id: String(i._id),
          sku: i.key,
          name: i.data.name,
          netMg: i.data.netMg,
        })),
        scanned: [],
      },
      session,
      await number(req.tenant._id, "AUD", session),
    );
    await audit(
      req,
      "audit.started",
      a._id,
      null,
      { count: items.length },
      "",
      session,
    );
  });
  res.json(a);
});
control.post("/audits/:id/scan", permit("audits"), async (req, res) => {
  const d = z.object({ sku: text, weight: num }).parse(req.body);
  let a;
  await transaction(async (session) => {
    a = await findRecord(req, "audits", req.params.id, session);
    if (a.data.status !== "open") throw fail(409, "AUDIT_CLOSED");
    const scanned = [
      ...a.data.scanned.filter((s) => s.sku !== d.sku),
      { sku: d.sku, netMg: mg(d.weight) },
    ];
    a.data = { ...a.data, scanned };
    a.markModified("data");
    await a.save({ session });
  });
  res.json(a);
});
control.post("/audits/:id/close", permit("audits"), async (req, res) => {
  if (!["owner", "manager"].includes(req.user.role))
    throw fail(403, "FORBIDDEN");
  const reason = text.parse(req.body.reason);
  let a;
  await transaction(async (session) => {
    a = await findRecord(req, "audits", req.params.id, session);
    if (a.data.status !== "open") throw fail(409, "AUDIT_CLOSED");
    const e = a.data.expected,
      s = a.data.scanned;
    const missing = e.filter((x) => !s.some((y) => y.sku === x.sku)),
      unexpected = s.filter((x) => !e.some((y) => y.sku === x.sku)),
      mismatched = e.filter((x) =>
        s.some((y) => y.sku === x.sku && x.netMg !== y.netMg),
      );
    a.data = {
      ...a.data,
      status: "closed",
      missing,
      unexpected,
      mismatched,
      resolution: reason,
    };
    a.markModified("data");
    await a.save({ session });
    if (missing.length + unexpected.length + mismatched.length)
      await addRecord(
        req,
        "notifications",
        { name: "Stock audit discrepancies", notes: a.key, level: "warning" },
        session,
      );
    await audit(req, "audit.closed", a._id, null, a.data, reason, session);
  });
  res.json(a);
});
control.post("/reconciliation", permit("reconciliation"), async (req, res) => {
  const d = z
    .object({
      name: text,
      physical: num,
      purity: num.min(1).max(24),
      metal: z.enum(["gold", "silver"]).default("gold"),
      notes: text,
    })
    .parse(req.body);
  let r;
  await transaction(async (session) => {
    const movements = await Record.find(
      scope(req, {
        kind: "metalMovements",
        "data.purity": d.purity,
        "data.metal": d.metal,
      }),
    ).session(session);
    const day = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Karachi",
      }),
      start = new Date(day + "T00:00:00+05:00");
    const opening = movements
      .filter((m) => m.createdAt < start)
      .reduce((a, m) => a + m.data.physicalMg, 0);
    const current = movements.filter((m) => m.createdAt >= start);
    const value = {
      ...reconciliation(
        opening,
        current.map((m) => m.data.physicalMg),
        mg(d.physical),
      ),
      opening,
      date: day,
    };
    r = await addRecord(
      req,
      "reconciliation",
      {
        ...d,
        ...value,
        pureDifference: pure(value.difference, d.purity),
        movementIds: movements.map((x) => String(x._id)),
      },
      session,
    );
    await audit(
      req,
      "reconciliation.saved",
      r._id,
      null,
      r.data,
      d.notes,
      session,
    );
  });
  res.json(r);
});
const reportKinds = {
  stock: "inventory",
  "gold-movement": "metalMovements",
  "karigar-outstanding": "karigarLedger",
  wastage: "karigarLedger",
  expenses: "expenses",
  "old-gold": "old-gold",
  orders: "orders",
  repairs: "repairs",
  "cash-bank": "payments",
  "audit-discrepancies": "audits",
  reconciliation: "reconciliation",
  amanat: "amanat",
  returns: "returns",
};
control.get("/reports/:type", permit("reports"), async (req, res) => {
  const type = req.params.type,
    filter = scope(req);
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) {
      const date = new Date(String(req.query.from));
      if (Number.isNaN(+date)) throw fail(400, "INVALID_DATE");
      filter.createdAt.$gte = date;
    }
    if (req.query.to) {
      const date = new Date(String(req.query.to) + "T23:59:59.999Z");
      if (Number.isNaN(+date)) throw fail(400, "INVALID_DATE");
      filter.createdAt.$lte = date;
    }
  }
  let rows;
  if (["sales", "discounts", "profit", "design-performance"].includes(type)) {
    const sales = await Sale.find({ ...filter, status: "issued" }).lean();
    const returns = await Record.find({ ...filter, kind: "returns" }).lean();
    const saleReturns = (id) =>
      returns.filter((r) => r.data.saleId === String(id));
    if (type === "profit" && req.user.role !== "owner")
      throw fail(403, "OWNER_ONLY");
    rows = sales.map((s) => ({
      number: s.number,
      date: s.createdAt,
      customer: s.customer.name,
      total:
        (s.totals.total -
          saleReturns(s._id).reduce((a, r) => a + r.data.credit, 0)) /
        100,
      discount: s.totals.discount / 100,
      received: s.totals.received / 100,
      balance: s.totals.balance / 100,
      ...(type === "profit"
        ? {
            grossProfit:
              (s.totals.subtotal -
                s.totals.discount -
                s.lines.reduce((a, l) => a + l.cost, 0) -
                saleReturns(s._id).reduce(
                  (a, r) => a + (r.data.netRevenue || 0) - (r.data.cost || 0),
                  0,
                )) /
              100,
          }
        : {}),
    }));
    if (type === "discounts") rows = rows.filter((r) => r.discount);
    if (type === "design-performance") {
      const all = await Record.find(scope(req, { kind: "inventory" })).lean();
      rows = all.map((r) => ({
        sku: r.key,
        name: r.data.name,
        status: r.data.status,
        daysInStock: Math.floor((Date.now() - r.createdAt) / 86400000),
      }));
    }
  } else if (type === "receivables") {
    const o = await overview(req);
    const customers = await Record.find(
      scope(req, { kind: "customers" }),
    ).lean();
    rows = customers.map((c) => ({
      name: c.data.name,
      phone: c.data.phone,
      balance: (o.customerBalances[c._id] || 0) / 100,
    }));
  } else if (type === "activity") {
    rows = await Audit.find({ tenantId: req.tenant._id })
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    rows = rows.map((r) => ({
      date: r.createdAt,
      actor: r.actor,
      action: r.action,
      reason: r.reason,
    }));
  } else {
    if (!reportKinds[type]) throw fail(404, "NOT_FOUND");
    rows = (
      await Record.find({ ...filter, kind: reportKinds[type] }).lean()
    ).map((r) => ({
      reference: r.key || String(r._id),
      date: r.createdAt,
      ...redact(req, r).data,
    }));
  }
  if (req.query.format === "csv") {
    const keys = [...new Set(rows.flatMap(Object.keys))].filter(
      (k) => !["photos", "expected", "scanned", "movementIds"].includes(k),
    );
    const esc = (v) =>
      '"' +
      String(typeof v === "object" ? JSON.stringify(v) : (v ?? ""))
        .replace(/^[=+@-]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    res
      .type("text/csv")
      .attachment(`${type}.csv`)
      .send(
        [
          keys.map(esc).join(","),
          ...rows.map((r) => keys.map((k) => esc(r[k])).join(",")),
        ].join("\r\n"),
      );
  } else res.json({ type, rows });
});
control.get("/settings", permit("settings"), async (req, res) =>
  res.json({
    profile: req.tenant.profile,
    subscription: {
      plan: req.tenant.plan,
      status: req.accessState,
      expiresAt: req.tenant.expiresAt,
      limits: req.tenant.limits,
    },
    branches: await Record.find({
      tenantId: req.tenant._id,
      kind: "branches",
    }).lean(),
  }),
);
control.put("/settings", permit("settings"), async (req, res) => {
  const data = profileSchema.parse(req.body);
  if (data.logoId) {
    const { Attachment } = await import("../db.mjs");
    if (
      !(await Attachment.exists({ _id: data.logoId, tenantId: req.tenant._id }))
    )
      throw fail(400, "LOGO_INVALID");
  }
  await transaction(async (session) => {
    await Tenant.updateOne(
      { _id: req.tenant._id },
      { $set: { profile: data, name: data.name } },
      { session },
    );
    await audit(
      req,
      "profile.updated",
      req.tenant._id,
      req.tenant.profile,
      data,
      "Shop profile changed",
      session,
    );
  });
  res.json({ ok: true });
});
control.get("/users", permit("users"), async (req, res) =>
  res.json((await Identity.find({ tenantId: req.tenant._id })).map(publicUser)),
);
control.post("/users", permit("users"), async (req, res) => {
  const d = z
    .object({
      name: text,
      username: text,
      role: z.enum(roles.filter((r) => r !== "owner")),
      branches: z.array(text).min(1),
    })
    .parse(req.body);
  const temporary = crypto.randomBytes(16).toString("base64url"),
    password = await bcrypt.hash(temporary, 12);
  let user;
  await transaction(async (session) => {
    if (
      (await Identity.countDocuments({
        tenantId: req.tenant._id,
        status: "active",
      }).session(session)) >= req.tenant.limits.users
    )
      throw fail(403, "PLAN_LIMIT", "User limit reached");
    const branches = await Record.find({
      tenantId: req.tenant._id,
      kind: "branches",
    }).session(session);
    if (d.branches.some((b) => !branches.some((x) => x.key === b)))
      throw fail(400, "BRANCH_INVALID");
    [user] = await Identity.create(
      [{ ...d, password, type: "tenantUser", tenantId: req.tenant._id }],
      { session },
    );
    await audit(
      req,
      "user.created",
      user._id,
      null,
      publicUser(user),
      "",
      session,
    );
  });
  res.json({ user: publicUser(user), temporaryPassword: temporary });
});
control.patch("/users/:id", permit("users"), async (req, res) => {
  const d = z
    .object({
      role: z.enum(roles.filter((r) => r !== "owner")),
      status: z.enum(["active", "revoked"]),
      reason: text,
    })
    .parse(req.body);
  await transaction(async (session) => {
    const user = await Identity.findOne({
      _id: req.params.id,
      tenantId: req.tenant._id,
    }).session(session);
    if (!user || user.role === "owner") throw fail(403, "OWNER_PROTECTED");
    const before = publicUser(user);
    if (
      user.status !== "active" &&
      d.status === "active" &&
      (await Identity.countDocuments({
        tenantId: req.tenant._id,
        status: "active",
      }).session(session)) >= req.tenant.limits.users
    )
      throw fail(403, "PLAN_LIMIT");
    user.role = d.role;
    user.status = d.status;
    await user.save({ session });
    await Session.deleteMany({ userId: user._id }, { session });
    await audit(
      req,
      "user.updated",
      user._id,
      before,
      publicUser(user),
      d.reason,
      session,
    );
  });
  res.json({ ok: true });
});
control.get("/export", permit("settings"), async (req, res) => {
  res
    .attachment("jeweller-os-export.json")
    .json({
      exportedAt: new Date(),
      profile: req.tenant.profile,
      records: await Record.find(scope(req)).lean(),
      sales: await Sale.find(scope(req)).lean(),
      audit: await Audit.find({ tenantId: req.tenant._id }).lean(),
    });
});
