import test from "node:test";
import assert from "node:assert/strict";
import {
  mg,
  money,
  pure,
  equivalent,
  invoiceLine,
  invoiceTotals,
  oldGoldValue,
  karigarReturn,
  reconciliation,
} from "../services/math.mjs";
test("currency and weight round half-up at storage precision", () => {
  assert.equal(money("1.005"), 101);
  assert.equal(mg("0.0005"), 1);
  assert.equal(pure(12000, 22), 11000);
  assert.equal(equivalent(18000, 18, 24), 13500);
});
test("PDF example: 8.50g at 38,000 plus making and stones, old-gold adjustment", () => {
  const l = invoiceLine(
    {
      name: "Ring",
      metal: "gold",
      purity: 22,
      grossWeight: 9,
      stoneWeight: 0.5,
      makingMode: "fixed",
      making: 25500,
      stoneValue: 6000,
      wastage: 0,
      cost: 0,
    },
    { 22: 3800000 },
  );
  const t = invoiceTotals([l], { exchange: 10000000 });
  assert.equal(l.gold, 32300000);
  assert.equal(t.subtotal, 35450000);
  assert.equal(t.payable, 25450000);
  assert.equal(t.balance, 25450000);
});
test("making per gram, percent and wastage use explicit rounding", () => {
  let l = invoiceLine(
    {
      name: "Chain",
      metal: "gold",
      purity: 22,
      grossWeight: 3.125,
      stoneWeight: 0,
      makingMode: "perGram",
      making: 150,
      wastageMode: "percent",
      wastage: 2,
      stoneValue: 0,
      cost: 0,
    },
    { 22: 100000 },
  );
  assert.equal(l.making, 46875);
  assert.equal(l.wastageMg, 63);
  assert.equal(l.wastage, 6300);
  assert.throws(() => invoiceTotals([l], { discount: 99999 }));
  assert.throws(() => invoiceTotals([l], { received: 999999999 }));
});
test("old gold applies deductions and converts tested purity", () => {
  const v = oldGoldValue({
    weight: 10,
    purity: 18,
    deductions: 0.5,
    loss: 0.1,
    rate24: 40000,
  });
  assert.equal(v.netMg, 9400);
  assert.equal(v.pureMg, 7050);
  assert.equal(v.value, 28200000);
});
test("karigar reconciles finished + scrap + returned metal + wastage", () =>
  assert.equal(
    karigarReturn({
      finished: 8,
      scrap: 1,
      remaining: 0.5,
      wastage: 0.5,
      purity: 22,
    }),
    9167,
  ));
test("daily reconciliation example has -1.500 g discrepancy", () =>
  assert.deepEqual(
    reconciliation(3825500, [85200, -112800, -150000, 143500], 3789900),
    { expected: 3791400, physical: 3789900, difference: -1500 },
  ));
