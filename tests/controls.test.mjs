import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connect, Identity, Record, Tenant } from "../db.mjs";
import { createApp } from "../app.mjs";
let mongo, app, owner, cashier, csrf, cashCsrf, tenant, customer, stock;
const password = "ControlTest-2026!",
  sub = {
    plan: "pro",
    status: "active",
    expiresAt: new Date("2030-01-01"),
    limits: { users: 5, branches: 2, features: ["*"] },
  };
const call = (method, path, body) =>
  owner[method]("/api/v1" + path)
    .set("x-csrf-token", csrf)
    .send(body);
before(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ["--nounixsocket"] },
  });
  await connect(mongo.getUri("controls"));
  app = createApp();
  tenant = await Tenant.create({
    name: "Controls",
    profile: { name: "Controls" },
    ...sub,
  });
  await Record.create({
    tenantId: tenant._id,
    branch: "main",
    kind: "branches",
    key: "main",
    data: { name: "Main" },
  });
  for (const role of ["owner", "cashier"])
    await Identity.create({
      username: "controls-" + role,
      name: role,
      password: await bcrypt.hash(password, 12),
      type: "tenantUser",
      tenantId: tenant._id,
      role,
      firstLoginChangeRequired: false,
    });
  owner = request.agent(app);
  cashier = request.agent(app);
  csrf = (
    await owner
      .post("/api/v1/access/sign-in")
      .send({ username: "controls-owner", password })
  ).body.csrf;
  cashCsrf = (
    await cashier
      .post("/api/v1/access/sign-in")
      .send({ username: "controls-cashier", password })
  ).body.csrf;
  customer = (
    await call("post", "/records/customers", { name: "Returns customer" })
  ).body;
  await call("post", "/rates", { rate24: 40000, silver: 500, reason: "Test" });
  stock = (
    await call("post", "/records/inventory", {
      name: "Test bangle",
      category: "Bangle",
      purity: 22,
      grossWeight: 10,
      cost: 200000,
    })
  ).body;
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
test("cost redaction, cashier restrictions and first-use API enforcement", async () => {
  const r = await cashier.get("/api/v1/records/inventory/" + stock._id);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.cost, undefined);
  assert.equal((await cashier.get("/api/v1/reports/profit")).status, 403);
  assert.equal(
    (
      await cashier
        .post("/api/v1/rates")
        .set("x-csrf-token", cashCsrf)
        .send({ rate24: 1, silver: 1, reason: "invalid" })
    ).status,
    403,
  );
  await Identity.updateOne(
    { username: "controls-cashier" },
    { $set: { firstLoginChangeRequired: true } },
  );
  assert.equal((await cashier.get("/api/v1/records/inventory")).status, 403);
  await Identity.updateOne(
    { username: "controls-cashier" },
    { $set: { firstLoginChangeRequired: false } },
  );
});
test("reservation blocks sales, release restores availability, partial return is append-only", async () => {
  assert.equal(
    (
      await call("post", "/inventory/" + stock._id + "/reserve", {
        reserve: true,
        reason: "Customer hold",
      })
    ).status,
    200,
  );
  const payload = {
    customerId: customer._id,
    items: [stock._id],
    payments: [{ method: "cash", amount: 300000 }],
    idempotencyKey: "control-sale-unique-001",
  };
  assert.equal((await call("post", "/sales", payload)).status, 409);
  await call("post", "/inventory/" + stock._id + "/reserve", {
    reserve: false,
    reason: "Release",
  });
  const sale = await call("post", "/sales", payload);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const ret = {
    items: [stock._id],
    refund: 100000,
    method: "cash",
    reason: "Customer return",
    idempotencyKey: "return-unique-0001",
  };
  let r = await call("post", "/sales/" + sale.body._id + "/returns", ret);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    (await call("post", "/sales/" + sale.body._id + "/returns", ret)).body._id,
    r.body._id,
  );
  assert.equal(
    (
      await call("post", "/sales/" + sale.body._id + "/returns", {
        ...ret,
        idempotencyKey: "return-unique-0002",
      })
    ).status,
    409,
  );
  assert.equal(
    (await owner.get("/api/v1/records/inventory/" + stock._id)).body.data
      .status,
    "in-stock",
  );
  assert.equal(
    (
      await call("post", "/sales/" + sale.body._id + "/void", {
        reason: "No double reversal",
      })
    ).status,
    400,
  );
});
test("stock audit keeps differences, reconciliation traces movements, branch transfer is scoped", async () => {
  const a = await call("post", "/audits", { name: "Count" });
  assert.equal(a.status, 200);
  await call("post", "/audits/" + a.body._id + "/scan", {
    sku: stock.key,
    weight: 9.999,
  });
  const close = await call("post", "/audits/" + a.body._id + "/close", {
    reason: "1mg weighing difference reviewed",
  });
  assert.equal(close.body.data.mismatched.length, 1);
  assert.equal(
    (
      await call("post", "/audits/" + a.body._id + "/scan", {
        sku: stock.key,
        weight: 10,
      })
    ).status,
    409,
  );
  const rec = await call("post", "/reconciliation", {
    name: "Closing",
    physical: 9.999,
    purity: 22,
    metal: "gold",
    notes: "Scale tolerance",
  });
  assert.equal(rec.body.data.difference, -1);
  const b = await call("post", "/records/branches", { name: "Second" });
  assert.equal(b.status, 201);
  const transfer = await call("post", "/inventory/" + stock._id + "/transfer", {
    branch: b.body.key,
    reason: "Move showcase",
  });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  assert.equal(
    (await owner.get("/api/v1/records/inventory/" + stock._id)).status,
    404,
  );
  assert.equal(
    (
      await owner
        .get("/api/v1/records/inventory/" + stock._id)
        .set("x-branch", b.body.key)
    ).status,
    200,
  );
  assert.equal(
    (await cashier.get("/api/v1/records/inventory").set("x-branch", b.body.key))
      .status,
    403,
  );
});
test("plan expiry by date blocks writes, feature limits and user limits are effective", async () => {
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { expiresAt: new Date(Date.now() - 86400000) } },
  );
  assert.equal(
    (await call("post", "/records/customers", { name: "Expired write" }))
      .status,
    403,
  );
  assert.equal((await owner.get("/api/v1/records/customers")).status, 200);
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        expiresAt: new Date("2030-01-01"),
        "limits.features": ["inventory"],
        "limits.users": 1,
      },
    },
  );
  assert.equal((await owner.get("/api/v1/sales")).status, 403);
  assert.equal((await cashier.get("/api/v1/records/inventory")).status, 403);
});
