import { Router } from "express";
import QRCode from "qrcode";
import {
  Record,
  Sale,
  Identity,
  transaction,
  addRecord,
  audit,
  number,
} from "../db.mjs";
import { z, id, text, num } from "../validation.mjs";
import { permit, scope, findRecord, fail } from "../security.mjs";
import { pure, money, round } from "../services/math.mjs";
import { frame, sendDocument } from "../services/documents.mjs";
export const stock = Router();
stock.post("/inventory/:id/reserve", permit("inventory"), async (req, res) => {
  const d = z.object({ reserve: z.boolean(), reason: text }).parse(req.body);
  let item;
  await transaction(async (session) => {
    item = await findRecord(req, "inventory", req.params.id, session);
    if (item.data.status !== (d.reserve ? "in-stock" : "reserved"))
      throw fail(409, "ITEM_UNAVAILABLE");
    const before = item.data.status;
    item.data = { ...item.data, status: d.reserve ? "reserved" : "in-stock" };
    item.markModified("data");
    await item.save({ session });
    await audit(
      req,
      "inventory.reservation",
      item._id,
      { status: before },
      { status: item.data.status },
      d.reason,
      session,
    );
  });
  res.json(item);
});
stock.post("/inventory/:id/transfer", permit("inventory"), async (req, res) => {
  const d = z
    .object({
      branch: text,
      location: z.string().max(200).default(""),
      reason: text,
    })
    .parse(req.body);
  if (!req.user.branches.includes(d.branch) || req.branch === d.branch)
    throw fail(403, "BRANCH_DENIED");
  if (
    !(await Record.exists({
      tenantId: req.tenant._id,
      kind: "branches",
      key: d.branch,
    }))
  )
    throw fail(400, "BRANCH_INVALID");
  await transaction(async (session) => {
    const item = await findRecord(req, "inventory", req.params.id, session);
    if (item.data.status !== "in-stock") throw fail(409, "ITEM_UNAVAILABLE");
    const before = item.toObject();
    await addRecord(
      req,
      "metalMovements",
      {
        name: "Branch transfer out",
        source: item.key,
        physicalMg: -item.data.netMg,
        pureMg: -pure(item.data.netMg, item.data.purity),
        purity: item.data.purity,
        metal: item.data.metal,
      },
      session,
    );
    await addRecord(
      { ...req, branch: d.branch },
      "metalMovements",
      {
        name: "Branch transfer in",
        source: item.key,
        physicalMg: item.data.netMg,
        pureMg: pure(item.data.netMg, item.data.purity),
        purity: item.data.purity,
        metal: item.data.metal,
      },
      session,
    );
    item.branch = d.branch;
    item.data = { ...item.data, location: d.location };
    item.markModified("data");
    await item.save({ session });
    await audit(
      req,
      "inventory.transferred",
      item._id,
      before,
      item.toObject(),
      d.reason,
      session,
    );
  });
  res.json({ ok: true });
});
stock.get("/inventory/:id/tag", permit("inventory"), async (req, res) => {
  const item = await findRecord(req, "inventory", req.params.id),
    qr = await QRCode.toDataURL(item.key);
  const escape = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const html = frame(
    item.key,
    `<div style="width:55mm;border:1px solid #ddd;padding:10px;text-align:center"><img src="${qr}" width="110" height="110"><h2>${escape(item.key)}</h2><p>${escape(item.data.name)}</p><p>${item.data.purity}K · ${(item.data.netMg / 1000).toFixed(3)} g</p></div>`,
  );
  await sendDocument(req, res, html);
});
stock.post("/sales/:id/returns", permit("sales"), async (req, res) => {
  if (!["owner", "manager"].includes(req.user.role))
    throw fail(403, "FORBIDDEN");
  const d = z
    .object({
      items: z.array(id).min(1).max(50),
      refund: num,
      method: z.enum(["cash", "bank", "card", "transfer"]),
      reason: text,
      idempotencyKey: z.string().min(16).max(100),
    })
    .parse(req.body);
  let result;
  await transaction(async (session) => {
    result = await Record.findOne(
      scope(req, { kind: "returns", key: d.idempotencyKey }),
    ).session(session);
    if (result) return;
    const sale = await Sale.findOne(scope(req, { _id: req.params.id })).session(
      session,
    );
    if (!sale || sale.status === "void") throw fail(404, "NOT_FOUND");
    if (new Set(d.items).size !== d.items.length)
      throw fail(400, "DUPLICATE_ITEM");
    const lines = d.items.map((id) => sale.lines.find((l) => l.itemId === id));
    if (lines.some((l) => !l)) throw fail(400, "INVALID_RETURN");
    const previous = await Record.find(
      scope(req, { kind: "returns", "data.saleId": String(sale._id) }),
    ).session(session);
    const returned = previous.flatMap((r) => r.data.items);
    if (d.items.some((id) => returned.includes(id)))
      throw fail(409, "ALREADY_RETURNED");
    const alreadyCredited = previous.reduce((s, r) => s + r.data.credit, 0);
    const isFinal = returned.length + d.items.length === sale.lines.length;
    const credit = isFinal
      ? sale.totals.total - alreadyCredited
      : round(
          (lines.reduce((s, l) => s + l.total, 0) / sale.totals.subtotal) *
            sale.totals.total,
        );
    const refund = money(d.refund);
    if (refund > credit) throw fail(400, "REFUND_TOO_LARGE");
    result = await addRecord(
      req,
      "returns",
      {
        name: "Return " + sale.number,
        saleId: String(sale._id),
        customerId: sale.customerId,
        items: d.items,
        cost: lines.reduce((s, l) => s + l.cost, 0),
        netRevenue: sale.totals.total
          ? round(
              (credit * (sale.totals.subtotal - sale.totals.discount)) /
                sale.totals.total,
            )
          : 0,
        credit,
        refund,
        method: d.method,
        reason: d.reason,
      },
      session,
      d.idempotencyKey,
    );
    for (const line of lines) {
      const updated = await Record.updateOne(
        scope(req, {
          _id: line.itemId,
          kind: "inventory",
          "data.status": "sold",
        }),
        { $set: { "data.status": "in-stock" } },
        { session },
      );
      if (updated.modifiedCount !== 1) throw fail(409, "RETURN_STOCK_CONFLICT");
      await addRecord(
        req,
        "metalMovements",
        {
          name: "Sale return",
          source: sale.number,
          physicalMg: line.netMg,
          pureMg: pure(line.netMg, line.purity),
          purity: line.purity,
          metal: line.metal,
        },
        session,
      );
    }
    await addRecord(
      req,
      "customerLedger",
      {
        customerId: sale.customerId,
        name: "Return " + sale.number,
        amount: -credit,
        returnId: String(result._id),
      },
      session,
    );
    if (refund) {
      await addRecord(
        req,
        "payments",
        {
          customerId: sale.customerId,
          name: "Return refund " + sale.number,
          amount: -refund,
          method: d.method,
          returnId: String(result._id),
        },
        session,
      );
      await addRecord(
        req,
        "customerLedger",
        {
          customerId: sale.customerId,
          name: "Return refund " + sale.number,
          amount: refund,
          returnId: String(result._id),
        },
        session,
      );
    }
    await audit(
      req,
      "sale.returned",
      sale._id,
      null,
      result.data,
      d.reason,
      session,
    );
  });
  res.json(result);
});

stock.post("/cash-adjustments", permit("settings"), async (req, res) => {
  const d = z
    .object({
      name: text,
      amount: z.coerce
        .number()
        .finite()
        .min(-1e9)
        .max(1e9)
        .refine((n) => n !== 0),
      method: z.enum(["cash", "bank", "card", "transfer"]),
      reason: text,
    })
    .parse(req.body);
  let r;
  await transaction(async (session) => {
    r = await addRecord(
      req,
      "payments",
      {
        name: d.name,
        amount: money(d.amount),
        method: d.method,
        capital: true,
        reason: d.reason,
      },
      session,
    );
    await audit(req, "cash.adjusted", r._id, null, r.data, d.reason, session);
  });
  res.json(r);
});
