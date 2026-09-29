import Decimal from "decimal.js";
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
export const round = (v) => {
  const n = new Decimal(v).toDecimalPlaces(0).toNumber();
  if (!Number.isSafeInteger(n))
    throw Object.assign(Error("Value exceeds supported precision"), {
      status: 400,
      code: "VALUE_TOO_LARGE",
    });
  return n;
};
export const money = (v) => round(new Decimal(v || 0).times(100));
export const mg = (v) => round(new Decimal(v || 0).times(1000));
export const pure = (weight, purity) =>
  round(new Decimal(weight).times(purity).div(24));
export const equivalent = (weight, from, to) =>
  round(new Decimal(weight).times(from).div(to));
export const TOLA = 11.6638038;
export const metalValue = (weightMg, ratePaisa) =>
  round(new Decimal(weightMg).times(ratePaisa).div(1000));
export function invoiceLine(item, rates, policyRate) {
  const d = item.data || item;
  const rate =
    policyRate ?? rates[d.metal === "gold" ? String(d.purity) : d.metal];
  if (!rate || rate <= 0)
    throw Object.assign(
      Error("Set an active rate for every item purity first"),
      { status: 400, code: "RATE_REQUIRED" },
    );
  const net = mg(d.grossWeight) - mg(d.stoneWeight);
  if (net <= 0)
    throw Object.assign(Error("Net metal weight must be positive"), {
      status: 400,
      code: "INVALID_WEIGHT",
    });
  const gold = metalValue(net, rate),
    wastageMg =
      d.wastageMode === "grams"
        ? mg(d.wastage)
        : round(new Decimal(net).times(d.wastage || 0).div(100));
  const making =
    d.makingMode === "perGram"
      ? metalValue(net, money(d.making))
      : d.makingMode === "percent"
        ? round(new Decimal(gold).times(d.making || 0).div(100))
        : money(d.making);
  const wastage = metalValue(wastageMg, rate),
    stone = money(d.stoneValue),
    total = gold + making + wastage + stone;
  return {
    itemId: String(item._id || ""),
    sku: item.key || d.sku,
    description: d.name,
    metal: d.metal,
    purity: d.purity,
    grossMg: mg(d.grossWeight),
    stoneMg: mg(d.stoneWeight),
    netMg: net,
    rate,
    gold,
    making,
    wastageMg,
    wastage,
    stone,
    total,
    cost: money(d.cost),
  };
}
export function invoiceTotals(
  lines,
  {
    discount = 0,
    taxPercent = 0,
    exchange = 0,
    credit = 0,
    received = 0,
    previousBalance = 0,
  } = {},
) {
  const subtotal = round(
    lines.reduce((s, l) => s.plus(l.total), new Decimal(0)),
  );
  const disc = money(discount);
  if (disc > subtotal)
    throw Object.assign(Error("Discount exceeds subtotal"), {
      status: 400,
      code: "INVALID_DISCOUNT",
    });
  const tax = round(new Decimal(subtotal - disc).times(taxPercent).div(100)),
    total = subtotal - disc + tax;
  if (exchange + credit > total)
    throw Object.assign(Error("Exchange and credit exceed invoice total"), {
      status: 400,
      code: "INVALID_CREDIT",
    });
  const payable = total - exchange - credit;
  if (received > payable)
    throw Object.assign(Error("Payment exceeds remaining amount"), {
      status: 400,
      code: "OVERPAYMENT",
    });
  return {
    subtotal,
    discount: disc,
    tax,
    total,
    exchange,
    credit,
    payable,
    received,
    balance: payable - received,
    previousBalance,
  };
}
export function oldGoldValue(d) {
  const net = mg(d.weight) - mg(d.deductions) - mg(d.loss);
  if (net <= 0)
    throw Object.assign(Error("Net old-gold weight must be positive"), {
      status: 400,
      code: "INVALID_WEIGHT",
    });
  return {
    netMg: net,
    pureMg: pure(net, d.purity),
    value: metalValue(pure(net, d.purity), money(d.rate24)),
  };
}
export function karigarReturn(d) {
  return pure(
    mg(d.finished) + mg(d.scrap) + mg(d.remaining) + mg(d.wastage),
    d.purity,
  );
}
export function reconciliation(opening, movements, physical) {
  const expected = opening + movements.reduce((s, m) => s + m, 0);
  return { expected, physical, difference: physical - expected };
}
