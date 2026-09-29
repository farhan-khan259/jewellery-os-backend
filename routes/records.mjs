import { Router } from "express";
import {
  Identity,
  Record,
  Sale,
  transaction,
  number,
  addRecord,
  audit,
} from "../db.mjs";
import { schemas, z, text } from "../validation.mjs";
import { permit, scope, findRecord, redact, fail } from "../security.mjs";
import { money, mg, pure } from "../services/math.mjs";
export const records = Router();
const kinds = [
  ...Object.keys(schemas),
  "customerLedger",
  "karigarLedger",
  "metalMovements",
  "payments",
  "old-gold",
  "rates",
  "audits",
  "reconciliation",
  "amanat",
  "returns",
];
const moduleFor = (k) =>
  ({
    customerLedger: "customers",
    karigarLedger: "karigars",
    metalMovements: "reconciliation",
    amanat: "customers",
    returns: "sales",
    drafts: "sales",
    branches: "settings",
    support: "settings",
  })[k] || k;
records.use("/:kind", (req, res, next) => {
  if (!kinds.includes(req.params.kind)) return next(fail(404, "NOT_FOUND"));
  permit(moduleFor(req.params.kind))(req, res, next);
});
records.get("/:kind", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1),
    limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50)),
    filter = scope(req, { kind: req.params.kind });
  if (req.query.customerId)
    filter["data.customerId"] = String(req.query.customerId);
  if (req.query.karigarId)
    filter["data.karigarId"] = String(req.query.karigarId);
  if (req.query.status) filter["data.status"] = String(req.query.status);
  if (req.query.q) {
    const escaped = String(req.query.q)
      .slice(0, 150)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { "data.name": new RegExp(escaped, "i") },
      { key: new RegExp(escaped, "i") },
      { "data.phone": new RegExp(escaped, "i") },
    ];
  }
  const [rows, total] = await Promise.all([
    Record.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Record.countDocuments(filter),
  ]);
  res.json({ rows: rows.map((r) => redact(req, r)), total, page, limit });
});
records.get("/:kind/:id", async (req, res) =>
  res.json(redact(req, await findRecord(req, req.params.kind, req.params.id))),
);
records.post("/:kind", async (req, res) => {
  const kind = req.params.kind;
  if (!schemas[kind])
    throw fail(405, "IMMUTABLE", "Use the dedicated transaction action");
  if (["branches"].includes(kind) && req.user.role !== "owner")
    throw fail(403, "FORBIDDEN");
  const data = schemas[kind].parse(req.body);
  let r;
  await transaction(async (session) => {
    if (data.customerId)
      await findRecord(req, "customers", data.customerId, session);
    if (data.karigarId)
      await findRecord(req, "karigars", data.karigarId, session);
    if (
      kind === "branches" &&
      (await Record.countDocuments({
        tenantId: req.tenant._id,
        kind: "branches",
      }).session(session)) >= req.tenant.limits.branches
    )
      throw fail(403, "PLAN_LIMIT", "Branch limit reached");
    if (kind === "inventory") {
      data.status = "in-stock";
      data.netMg = mg(data.grossWeight) - mg(data.stoneWeight);
      if (req.user.role !== "owner") data.cost = 0;
    }
    if (kind === "orders") {
      data.status = "draft";
      const rate = await Record.findOne(scope(req, { kind: "rates" }))
        .sort({ createdAt: -1 })
        .session(session);
      if (data.ratePolicy !== "delivery" && !rate)
        throw fail(400, "RATE_REQUIRED");
      data.bookingRates = rate?.data.rates || {};
      data.advancePaisa = money(data.advance);
    }
    if (kind === "repairs") data.status = "received";
    const prefix =
      {
        inventory: "JW",
        orders: "ORD",
        repairs: "REP",
        customers: "CUS",
        karigars: "KAR",
        expenses: "EXP",
        branches: "BR",
      }[kind] || "REC";
    r = await addRecord(
      req,
      kind,
      data,
      session,
      await number(req.tenant._id, prefix, session),
    );
    if (kind === "branches")
      await Identity.updateMany(
        { tenantId: req.tenant._id, role: "owner" },
        { $addToSet: { branches: r.key } },
        { session },
      );
    if (kind === "inventory")
      await addRecord(
        req,
        "metalMovements",
        {
          name: "Stock received",
          source: String(r._id),
          purity: data.purity,
          metal: data.metal,
          physicalMg: data.netMg,
          pureMg: pure(data.netMg, data.purity),
        },
        session,
      );
    if (kind === "customers" && data.openingBalance)
      await addRecord(
        req,
        "customerLedger",
        {
          customerId: String(r._id),
          name: "Opening balance",
          amount: money(data.openingBalance),
        },
        session,
      );
    if (kind === "karigars" && data.openingWeight)
      await addRecord(
        req,
        "karigarLedger",
        {
          karigarId: String(r._id),
          name: "Opening metal balance",
          type: "opening",
          weightMg: mg(data.openingWeight),
          pureMg: pure(mg(data.openingWeight), data.purity),
          purity: data.purity,
        },
        session,
      );
    if (kind === "orders" && data.advance) {
      await addRecord(
        req,
        "payments",
        {
          customerId: data.customerId,
          name: "Order advance",
          orderId: String(r._id),
          amount: money(data.advance),
          method: "cash",
        },
        session,
      );
      await addRecord(
        req,
        "customerLedger",
        {
          customerId: data.customerId,
          name: "Order advance",
          orderId: String(r._id),
          amount: -money(data.advance),
        },
        session,
      );
    }
    if (kind === "expenses")
      await addRecord(
        req,
        "payments",
        {
          name: data.name,
          amount: -money(data.amount),
          method: data.method,
          expenseId: String(r._id),
        },
        session,
      );
    await audit(req, `${kind}.created`, r._id, null, data, "", session);
  });
  res.status(201).json(redact(req, r));
});
records.patch("/:kind/:id", async (req, res) => {
  const kind = req.params.kind;
  if (
    ![
      "customers",
      "karigars",
      "inventory",
      "orders",
      "repairs",
      "branches",
    ].includes(kind)
  )
    throw fail(405, "IMMUTABLE");
  const reason = text.parse(req.body.reason);
  let r;
  await transaction(async (session) => {
    r = await findRecord(req, kind, req.params.id, session);
    const before = structuredClone(r.data);
    if (["orders", "repairs"].includes(kind)) {
      const pipeline =
        kind === "orders"
          ? [
              "draft",
              "confirmed",
              "design",
              "gold-issued",
              "manufacturing",
              "polishing",
              "qc",
              "ready",
              "delivered",
            ]
          : ["received", "assigned", "in-progress", "ready", "delivered"];
      const status = z.enum(pipeline).parse(req.body.status);
      if (r.data.status === "delivered") throw fail(409, "ALREADY_DELIVERED");
      if (pipeline.indexOf(status) !== pipeline.indexOf(r.data.status) + 1)
        throw fail(400, "STATUS_SEQUENCE", "Move to the next stage");
      if (
        kind === "orders" &&
        status === "gold-issued" &&
        !(await Record.exists(
          scope(req, {
            kind: "karigarLedger",
            "data.jobId": String(r._id),
            "data.type": "issue",
          }),
        ).session(session))
      )
        throw fail(
          400,
          "GOLD_NOT_ISSUED",
          "Issue gold to this job before advancing",
        );
      if (kind === "orders" && status === "delivered")
        throw fail(
          400,
          "SETTLE_ORDER",
          "Use the sale screen to settle this order",
        );
      if (kind === "repairs" && status === "delivered") {
        if (req.body.confirmation !== true) throw fail(400, "CONFIRM_DELIVERY");
        const amount = money(r.data.serviceCharge);
        await addRecord(
          req,
          "customerLedger",
          {
            customerId: r.data.customerId,
            name: "Repair service",
            repairId: String(r._id),
            amount,
          },
          session,
        );
        await addRecord(
          req,
          "customerLedger",
          {
            customerId: r.data.customerId,
            name: "Repair payment",
            repairId: String(r._id),
            amount: -amount,
          },
          session,
        );
        await addRecord(
          req,
          "payments",
          {
            customerId: r.data.customerId,
            name: "Repair payment",
            repairId: String(r._id),
            amount,
            method: "cash",
          },
          session,
        );
      }
      r.data = { ...r.data, status };
    } else {
      const d = schemas[kind].parse(req.body.data);
      if (kind === "inventory") {
        if (
          !["owner", "manager", "inventory"].includes(req.user.role) ||
          r.data.status !== "in-stock"
        )
          throw fail(403, "EDIT_DENIED");
        if (req.user.role !== "owner") d.cost = r.data.cost;
        const next = mg(d.grossWeight) - mg(d.stoneWeight);
        if (d.purity !== r.data.purity || d.metal !== r.data.metal)
          throw fail(
            400,
            "METAL_IMMUTABLE",
            "Create a controlled replacement for a purity or metal change",
          );
        const delta = next - r.data.netMg;
        if (delta)
          await addRecord(
            req,
            "metalMovements",
            {
              name: "Weight correction",
              source: String(r._id),
              physicalMg: delta,
              pureMg: pure(delta, d.purity),
              purity: d.purity,
              metal: d.metal,
              reason,
            },
            session,
          );
        r.data = { ...d, status: r.data.status, netMg: next };
      } else {
        if (kind === "customers" && d.openingBalance !== r.data.openingBalance)
          throw fail(400, "OPENING_IMMUTABLE");
        if (
          kind === "karigars" &&
          (d.openingWeight !== r.data.openingWeight ||
            d.purity !== r.data.purity)
        )
          throw fail(400, "OPENING_IMMUTABLE");
        r.data = d;
      }
    }
    r.markModified("data");
    await r.save({ session });
    await audit(req, `${kind}.updated`, r._id, before, r.data, reason, session);
  });
  res.json(redact(req, r));
});
