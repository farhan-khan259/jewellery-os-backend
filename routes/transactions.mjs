import { Router } from "express";
import { Record, Sale, transaction, number, addRecord, audit } from "../db.mjs";
import {
  z,
  num,
  positive,
  id,
  text,
  saleSchema,
  oldSchema,
} from "../validation.mjs";
import { permit, scope, findRecord, redact, fail } from "../security.mjs";
import {
  money,
  mg,
  pure,
  invoiceLine,
  invoiceTotals,
  oldGoldValue,
  karigarReturn,
  round,
  TOLA,
} from "../services/math.mjs";
export const transactions = Router();
export async function balance(req, customerId, session) {
  const rows = await Record.find(
    scope(req, {
      kind: "customerLedger",
      "data.customerId": String(customerId),
    }),
  ).session(session || null);
  return rows.reduce((s, r) => s + r.data.amount, 0);
}
transactions.post("/rates", permit("rates"), async (req, res) => {
  const d = z
    .object({
      rate24: positive,
      silver: positive,
      unit: z.enum(["gram", "tola"]).default("gram"),
      auto: z.boolean().default(true),
      rate22: num.optional(),
      rate21: num.optional(),
      rate18: num.optional(),
      reason: text,
    })
    .parse(req.body);
  const base = money(d.rate24 / (d.unit === "tola" ? TOLA : 1)),
    rates = {
      24: base,
      silver: money(d.silver / (d.unit === "tola" ? TOLA : 1)),
    };
  for (const k of [22, 21, 18]) {
    if (!d.auto && !d["rate" + k]) throw fail(400, "RATE_REQUIRED");
    rates[k] = d.auto
      ? round((base * k) / 24)
      : money(d["rate" + k] / (d.unit === "tola" ? TOLA : 1));
  }
  let r;
  await transaction(async (session) => {
    const before = await Record.findOne(scope(req, { kind: "rates" }))
      .sort({ createdAt: -1 })
      .session(session);
    r = await addRecord(
      req,
      "rates",
      { rates, unit: d.unit, reason: d.reason },
      session,
    );
    await audit(
      req,
      "rates.changed",
      r._id,
      before?.data,
      r.data,
      d.reason,
      session,
    );
  });
  res.json(r);
});
transactions.get("/sales", permit("sales"), async (req, res) => {
  const page = Math.max(1, +req.query.page || 1),
    filter = scope(req);
  if (req.query.customerId) filter.customerId = String(req.query.customerId);
  res.json({
    rows: (
      await Sale.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * 50)
        .limit(50)
    ).map((r) => redact(req, r)),
    total: await Sale.countDocuments(filter),
  });
});
transactions.get("/sales/:id", permit("sales"), async (req, res) => {
  const s = await Sale.findOne(scope(req, { _id: req.params.id }));
  if (!s) throw fail(404, "NOT_FOUND");
  res.json(redact(req, s));
});
async function prepareSale(req, d, session) {
  const customer = await findRecord(req, "customers", d.customerId, session),
    rate = await Record.findOne(scope(req, { kind: "rates" }))
      .sort({ createdAt: -1 })
      .session(session || null);
  if (!rate)
    throw fail(
      400,
      "RATE_REQUIRED",
      "Set today’s metal rates before making a sale",
    );
  if (new Set(d.items).size !== d.items.length)
    throw fail(400, "DUPLICATE_ITEM");
  let order;
  if (d.orderId) {
    order = await findRecord(req, "orders", d.orderId, session);
    if (order.data.customerId !== d.customerId || order.data.status !== "ready")
      throw fail(400, "ORDER_NOT_READY");
  }
  const items = [];
  for (const i of d.items)
    items.push(await findRecord(req, "inventory", i, session));
  if (items.some((i) => i.data.status !== "in-stock"))
    throw fail(409, "ITEM_UNAVAILABLE", "An item is no longer in stock");
  const lines = items.map((i) =>
    invoiceLine(
      i,
      rate.data.rates,
      order?.data.ratePolicy === "locked"
        ? money(order.data.lockedRate)
        : order?.data.ratePolicy === "booking"
          ? order.data.bookingRates[String(i.data.purity)]
          : undefined,
    ),
  );
  let oldGold;
  if (d.oldGoldId) {
    oldGold = await findRecord(req, "old-gold", d.oldGoldId, session);
    if (
      oldGold.data.mode !== "exchange" ||
      oldGold.data.saleId ||
      oldGold.data.customerId !== d.customerId
    )
      throw fail(400, "EXCHANGE_UNAVAILABLE");
  }
  const previousBalance = await balance(req, d.customerId, session),
    otherOrders = await Record.find(
      scope(req, {
        kind: "orders",
        "data.customerId": d.customerId,
        "data.status": { $ne: "delivered" },
      }),
    ).session(session || null);
  const reserved = otherOrders
    .filter((o) => String(o._id) !== d.orderId)
    .reduce((s, o) => s + (o.data.advancePaisa || 0), 0);
  const credit = money(d.credit) + (order?.data.advancePaisa || 0);
  if (credit > Math.max(0, -previousBalance - reserved))
    throw fail(
      400,
      "CREDIT_UNAVAILABLE",
      "Available customer credit is too low",
    );
  if (d.discount > 0 && !["owner", "manager"].includes(req.user.role))
    throw fail(403, "DISCOUNT_FORBIDDEN");
  if (
    d.taxPercent !== undefined &&
    d.taxPercent !== (req.tenant.profile.taxPercent || 0) &&
    req.user.role !== "owner"
  )
    throw fail(403, "TAX_FORBIDDEN");
  const totals = invoiceTotals(lines, {
    discount: d.discount,
    taxPercent: d.taxPercent ?? req.tenant.profile.taxPercent ?? 0,
    exchange: oldGold?.data.value || 0,
    credit,
    received: d.payments.reduce((s, p) => s + money(p.amount), 0),
    previousBalance,
  });
  if (
    customer.data.creditLimit &&
    previousBalance + totals.total - totals.exchange - totals.received >
      money(customer.data.creditLimit)
  )
    throw fail(400, "CREDIT_LIMIT", "Customer credit limit exceeded");
  return { customer, rate, items, lines, totals, oldGold, order };
}
transactions.post("/sales/quote", permit("sales"), async (req, res) => {
  const d = saleSchema.parse(req.body),
    p = await prepareSale(req, d);
  res.json({ lines: p.lines.map(({ cost, ...r }) => r), totals: p.totals });
});
transactions.post("/sales", permit("sales"), async (req, res) => {
  const d = saleSchema.parse(req.body);
  let saved;
  try {
    await transaction(async (session) => {
      const existing = await Sale.findOne({
        tenantId: req.tenant._id,
        idempotencyKey: d.idempotencyKey,
      }).session(session);
      if (existing) {
        if (existing.branch !== req.branch) throw fail(403, "BRANCH_DENIED");
        saved = existing;
        return;
      }
      const p = await prepareSale(req, d, session);
      const invoiceNumber = await number(req.tenant._id, "INV", session);
      for (const item of p.items) {
        const changed = await Record.updateOne(
          scope(req, { _id: item._id, "data.status": "in-stock" }),
          { $set: { "data.status": "sold" } },
          { session },
        );
        if (changed.modifiedCount !== 1) throw fail(409, "ITEM_UNAVAILABLE");
        await addRecord(
          req,
          "metalMovements",
          {
            name: "Jewellery sold",
            source: invoiceNumber,
            itemId: String(item._id),
            metal: item.data.metal,
            purity: item.data.purity,
            physicalMg: -item.data.netMg,
            pureMg: -pure(item.data.netMg, item.data.purity),
          },
          session,
        );
      }
      [saved] = await Sale.create(
        [
          {
            tenantId: req.tenant._id,
            branch: req.branch,
            number: invoiceNumber,
            idempotencyKey: d.idempotencyKey,
            customerId: d.customerId,
            customer: p.customer.data,
            profile: req.tenant.profile,
            lines: p.lines,
            totals: p.totals,
            payments: d.payments.map((v) => ({
              method: v.method,
              amount: money(v.amount),
            })),
            oldGold: p.oldGold?.data,
            rateSnapshot: p.rate.data,
            cashier: req.user.name,
            orderId: d.orderId,
          },
        ],
        { session },
      );
      if (p.oldGold) {
        p.oldGold.data = { ...p.oldGold.data, saleId: String(saved._id) };
        p.oldGold.markModified("data");
        await p.oldGold.save({ session });
      }
      if (p.order) {
        p.order.data = {
          ...p.order.data,
          status: "delivered",
          saleId: String(saved._id),
        };
        p.order.markModified("data");
        await p.order.save({ session });
      }
      await addRecord(
        req,
        "customerLedger",
        {
          customerId: d.customerId,
          name: invoiceNumber,
          saleId: String(saved._id),
          amount: p.totals.total - p.totals.exchange,
        },
        session,
      );
      for (const payment of d.payments) {
        const amount = money(payment.amount);
        await addRecord(
          req,
          "payments",
          {
            customerId: d.customerId,
            name: invoiceNumber,
            saleId: String(saved._id),
            amount,
            method: payment.method,
          },
          session,
        );
        await addRecord(
          req,
          "customerLedger",
          {
            customerId: d.customerId,
            name: "Payment " + invoiceNumber,
            saleId: String(saved._id),
            amount: -amount,
          },
          session,
        );
      }
      await audit(
        req,
        "sale.issued",
        saved._id,
        null,
        { number: invoiceNumber, totals: p.totals },
        "",
        session,
      );
      if (p.totals.discount > p.totals.subtotal * 0.1)
        await addRecord(
          req,
          "notifications",
          {
            name: "Large discount",
            notes: invoiceNumber + " has a discount above 10%",
            level: "warning",
          },
          session,
        );
    });
  } catch (e) {
    if (e.code === 11000) {
      saved = await Sale.findOne(
        scope(req, { idempotencyKey: d.idempotencyKey }),
      );
      if (!saved) throw e;
    } else throw e;
  }
  res.status(201).json(redact(req, saved));
});
transactions.post("/sales/:id/void", permit("sales"), async (req, res) => {
  if (!["owner", "manager"].includes(req.user.role))
    throw fail(403, "FORBIDDEN");
  const reason = text.parse(req.body.reason);
  await transaction(async (session) => {
    const sale = await Sale.findOne(scope(req, { _id: req.params.id })).session(
      session,
    );
    if (!sale) throw fail(404, "NOT_FOUND");
    if (sale.status === "void") throw fail(409, "ALREADY_VOID");
    if (
      await Record.exists(
        scope(req, { kind: "returns", "data.saleId": String(sale._id) }),
      ).session(session)
    )
      throw fail(
        400,
        "RETURN_EXISTS",
        "This invoice has returns; a full void is unavailable",
      );
    if (sale.orderId || sale.oldGold)
      throw fail(
        400,
        "LINKED_REVERSAL",
        "Invoices linked to an order or old gold need a reviewed adjustment; direct void is disabled",
      );
    sale.status = "void";
    sale.voidReason = reason;
    await sale.save({ session });
    for (const line of sale.lines) {
      await Record.updateOne(
        scope(req, { _id: line.itemId, "data.status": "sold" }),
        { $set: { "data.status": "in-stock" } },
        { session },
      );
      await addRecord(
        req,
        "metalMovements",
        {
          name: "Sale void",
          source: sale.number,
          metal: line.metal,
          purity: line.purity,
          physicalMg: line.netMg,
          pureMg: pure(line.netMg, line.purity),
        },
        session,
      );
    }
    await addRecord(
      req,
      "customerLedger",
      {
        customerId: sale.customerId,
        name: "Void " + sale.number,
        amount: -(sale.totals.total - sale.totals.exchange),
        saleId: String(sale._id),
      },
      session,
    );
    const payments = await Record.find(
      scope(req, { kind: "payments", "data.saleId": String(sale._id) }),
    ).session(session);
    for (const p of payments) {
      await addRecord(
        req,
        "payments",
        {
          ...p.data,
          name: "Refund " + sale.number,
          amount: -p.data.amount,
          voidId: String(sale._id),
        },
        session,
      );
      await addRecord(
        req,
        "customerLedger",
        {
          customerId: sale.customerId,
          name: "Refund " + sale.number,
          amount: p.data.amount,
        },
        session,
      );
    }
    await audit(
      req,
      "sale.voided",
      sale._id,
      { status: "issued" },
      { status: "void" },
      reason,
      session,
    );
  });
  res.json({ ok: true });
});
transactions.post("/payments", permit("payments"), async (req, res) => {
  const d = z
    .object({
      customerId: id,
      amount: positive,
      method: z.enum(["cash", "bank", "card", "transfer"]),
      idempotencyKey: z.string().min(16).max(100),
      notes: z.string().max(1000).default(""),
    })
    .parse(req.body);
  let r;
  await transaction(async (session) => {
    r = await Record.findOne(
      scope(req, { kind: "payments", key: d.idempotencyKey }),
    ).session(session);
    if (r) return;
    await findRecord(req, "customers", d.customerId, session);
    r = await addRecord(
      req,
      "payments",
      { ...d, name: "Payment received", amount: money(d.amount) },
      session,
      d.idempotencyKey,
    );
    await addRecord(
      req,
      "customerLedger",
      {
        customerId: d.customerId,
        name: "Payment received",
        amount: -money(d.amount),
        paymentId: String(r._id),
      },
      session,
    );
    await audit(req, "payment.received", r._id, null, r.data, "", session);
  });
  res.json(r);
});
transactions.post("/old-gold", permit("old-gold"), async (req, res) => {
  const d = oldSchema.parse(req.body);
  if (d.loss && req.user.role !== "owner") throw fail(403, "LOSS_FORBIDDEN");
  const values = oldGoldValue(d);
  let r;
  await transaction(async (session) => {
    await findRecord(req, "customers", d.customerId, session);
    r = await addRecord(
      req,
      "old-gold",
      { ...d, ...values, remainingMg: values.netMg, status: "available" },
      session,
      await number(req.tenant._id, "OG", session),
    );
    await addRecord(
      req,
      "metalMovements",
      {
        name: "Old gold received",
        source: r.key,
        physicalMg: values.netMg,
        pureMg: values.pureMg,
        purity: d.purity,
        metal: "gold",
      },
      session,
    );
    if (d.mode === "cash")
      await addRecord(
        req,
        "payments",
        {
          customerId: d.customerId,
          name: r.key,
          amount: -values.value,
          method: "cash",
          oldGoldId: String(r._id),
        },
        session,
      );
    await audit(req, "old-gold.received", r._id, null, r.data, "", session);
  });
  res.json(r);
});
transactions.post(
  "/karigar-movements",
  permit("karigars"),
  async (req, res) => {
    const d = z
      .object({
        karigarId: id,
        type: z.enum(["issue", "receive"]),
        purity: num.min(1).max(24),
        weight: num.default(0),
        finished: num.default(0),
        scrap: num.default(0),
        remaining: num.default(0),
        wastage: num.default(0),
        sourceId: z.union([id, z.literal("")]).default(""),
        sourceKind: z.enum(["inventory", "old-gold"]).default("old-gold"),
        name: text,
        jobId: z.union([id, z.literal("")]).default(""),
        notes: z.string().max(1000).default(""),
      })
      .parse(req.body);
    let r;
    await transaction(async (session) => {
      await findRecord(req, "karigars", d.karigarId, session);
      if (d.jobId) await findRecord(req, "orders", d.jobId, session);
      let delta;
      if (d.type === "issue") {
        if (!d.sourceId || d.weight <= 0)
          throw fail(400, "SOURCE_REQUIRED", "Select available stock to issue");
        const src = await findRecord(req, d.sourceKind, d.sourceId, session);
        if (src.data.purity !== d.purity) throw fail(400, "PURITY_MISMATCH");
        if (d.sourceKind === "inventory") {
          if (
            src.data.status !== "in-stock" ||
            src.data.metal !== "gold" ||
            mg(d.weight) !== src.data.netMg
          )
            throw fail(400, "SOURCE_UNAVAILABLE");
          src.data = {
            ...src.data,
            status: "with-karigar",
            karigarId: d.karigarId,
          };
        } else {
          if (
            src.data.remainingMg < mg(d.weight) ||
            (src.data.mode === "exchange" && !src.data.saleId)
          )
            throw fail(
              400,
              "SOURCE_UNAVAILABLE",
              "Exchange gold must be applied to an invoice before it can be issued",
            );
          src.data = {
            ...src.data,
            remainingMg: src.data.remainingMg - mg(d.weight),
          };
        }
        src.markModified("data");
        await src.save({ session });
        delta = pure(mg(d.weight), d.purity);
        await addRecord(
          req,
          "metalMovements",
          {
            name: "Gold issued to karigar",
            physicalMg: -mg(d.weight),
            pureMg: -delta,
            purity: d.purity,
            metal: "gold",
            karigarId: d.karigarId,
          },
          session,
        );
      } else {
        const history = await Record.find(
          scope(req, { kind: "karigarLedger", "data.karigarId": d.karigarId }),
        ).session(session);
        const outstanding = history.reduce((s, r) => s + r.data.pureMg, 0);
        delta = -karigarReturn(d);
        if (delta === 0 || -delta > outstanding)
          throw fail(
            400,
            "RETURN_EXCEEDS_ISSUE",
            "Return exceeds outstanding pure gold",
          );
        const returned = mg(d.finished) + mg(d.scrap) + mg(d.remaining);
        await addRecord(
          req,
          "metalMovements",
          {
            name: "Gold returned by karigar",
            physicalMg: returned,
            pureMg: pure(returned, d.purity),
            purity: d.purity,
            metal: "gold",
            karigarId: d.karigarId,
          },
          session,
        );
        if (d.finished)
          await addRecord(
            req,
            "inventory",
            {
              name: d.name,
              category: "Karigar work",
              metal: "gold",
              purity: d.purity,
              grossWeight: d.finished,
              stoneWeight: 0,
              netMg: mg(d.finished),
              status: "in-stock",
              makingMode: "fixed",
              making: 0,
              wastage: 0,
              stoneValue: 0,
              cost: 0,
              karigarId: d.karigarId,
            },
            session,
            await number(req.tenant._id, "JW", session),
          );
        if (d.scrap + d.remaining)
          await addRecord(
            req,
            "old-gold",
            {
              name: "Karigar scrap / remainder",
              weight: d.scrap + d.remaining,
              purity: d.purity,
              netMg: mg(d.scrap + d.remaining),
              remainingMg: mg(d.scrap + d.remaining),
              pureMg: pure(mg(d.scrap + d.remaining), d.purity),
              value: 0,
              mode: "return",
              status: "available",
            },
            session,
            await number(req.tenant._id, "OG", session),
          );
        if (
          (d.wastage / (d.finished + d.scrap + d.remaining + d.wastage)) * 100 >
          (req.tenant.profile.allowedWastage ?? 2)
        )
          await addRecord(
            req,
            "notifications",
            {
              name: "Wastage tolerance exceeded",
              notes: d.name,
              level: "warning",
            },
            session,
          );
      }
      r = await addRecord(
        req,
        "karigarLedger",
        {
          ...d,
          pureMg: delta,
          weightMg:
            d.type === "issue"
              ? mg(d.weight)
              : -(
                  mg(d.finished) +
                  mg(d.scrap) +
                  mg(d.remaining) +
                  mg(d.wastage)
                ),
        },
        session,
      );
      await audit(req, "karigar." + d.type, r._id, null, r.data, "", session);
    });
    res.json(r);
  },
);
transactions.post("/amanat", permit("customers"), async (req, res) => {
  const d = z
    .object({
      customerId: id,
      type: z.enum(["deposit", "return"]),
      weight: positive,
      purity: num.min(1).max(24),
      notes: z.string().max(1000).default(""),
    })
    .parse(req.body);
  let r;
  await transaction(async (session) => {
    await findRecord(req, "customers", d.customerId, session);
    const h = await Record.find(
      scope(req, {
        kind: "amanat",
        "data.customerId": d.customerId,
        "data.purity": d.purity,
      }),
    ).session(session);
    const outstanding = h.reduce((s, r) => s + r.data.weightMg, 0),
      amount = mg(d.weight) * (d.type === "deposit" ? 1 : -1);
    if (outstanding + amount < 0) throw fail(400, "AMANAT_BALANCE");
    r = await addRecord(
      req,
      "amanat",
      {
        ...d,
        name: "Customer amanat " + d.type,
        weightMg: amount,
        pureMg: pure(amount, d.purity),
      },
      session,
    );
    await audit(req, "amanat." + d.type, r._id, null, r.data, "", session);
  });
  res.json(r);
});
