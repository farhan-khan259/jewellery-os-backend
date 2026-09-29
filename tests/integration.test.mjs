import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connect, Identity, Record, Sale, Audit } from "../db.mjs";
import { createApp } from "../app.mjs";
let mongo,
  app,
  admin,
  adminCsrf,
  shop,
  shopCsrf,
  tenant,
  customer,
  item,
  other,
  otherCsrf;
const password = "VerifiedPass-2026!";
const sub = {
  plan: "business",
  status: "active",
  expiresAt: "2030-01-01",
  billingCycle: "monthly",
  paymentStatus: "paid",
  limits: { users: 5, branches: 2, features: ["*"] },
};
async function send(agent, csrf, method, path, body) {
  const r = await agent[method]("/api/v1" + path)
    .set("x-csrf-token", csrf)
    .send(body);
  return r;
}
async function createShop(name) {
  const r = await send(admin, adminCsrf, "post", "/platform-admin/tenants", {
    name,
    username: name.toLowerCase(),
    ownerName: name,
    subscription: sub,
    profile: { name, address: "Peshawar", phone: "03000000000" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const agent = request.agent(app);
  let login = await agent
    .post("/api/v1/access/sign-in")
    .send({ username: name.toLowerCase(), password: r.body.temporaryPassword });
  assert.equal(login.status, 200);
  let csrf = login.body.csrf;
  const changed = await send(agent, csrf, "post", "/access/change-password", {
    currentPassword: r.body.temporaryPassword,
    password,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  return { agent, csrf: changed.body.csrf, tenant: r.body.tenant };
}
before(async () => {
  if (process.env.TEST_MONGODB_URI) {
    await connect(process.env.TEST_MONGODB_URI);
  } else {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, args: ["--nounixsocket"] },
    });
    await connect(mongo.getUri("jos_test"));
  }
  app = createApp();
  await Identity.create({
    username: "platform-test",
    name: "Test Admin",
    password: await bcrypt.hash(password, 12),
    type: "platformAdmin",
    firstLoginChangeRequired: false,
  });
  admin = request.agent(app);
  const r = await admin
    .post("/api/v1/access/sign-in")
    .send({ username: "platform-test", password, portal: "admin" });
  adminCsrf = r.body.csrf;
  const first = await createShop("TestOne");
  shop = first.agent;
  shopCsrf = first.csrf;
  tenant = first.tenant;
  const second = await createShop("TestTwo");
  other = second.agent;
  otherCsrf = second.csrf;
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
test("tenant scope, platform restriction and no public provisioning", async () => {
  assert.equal((await shop.get("/api/v1/platform-admin/overview")).status, 403);
  assert.equal(
    (await request(app).post("/api/v1/platform-admin/tenants").send({})).status,
    401,
  );
  let c = await send(shop, shopCsrf, "post", "/records/customers", {
    name: "Customer A",
    phone: "03001234567",
    creditLimit: 10000000,
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  customer = c.body;
  assert.equal(
    (await other.get("/api/v1/records/customers/" + customer._id)).status,
    404,
  );
  assert.equal(
    (await shop.post("/api/v1/records/customers").send({ name: "CSRF" }))
      .status,
    403,
  );
});
test("rate, inventory, sale, idempotency and immutable invoice profile", async () => {
  const r = await send(shop, shopCsrf, "post", "/rates", {
    rate24: 40000,
    silver: 500,
    reason: "Daily market rate",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const i = await send(shop, shopCsrf, "post", "/records/inventory", {
    name: "Gold ring",
    category: "Ring",
    purity: 22,
    grossWeight: 9,
    stoneWeight: 0.5,
    making: 25500,
    stoneValue: 6000,
    cost: 200000,
  });
  assert.equal(i.status, 201, JSON.stringify(i.body));
  item = i.body;
  const payload = {
    customerId: customer._id,
    items: [item._id],
    idempotencyKey: "sale-test-unique-0001",
    payments: [{ method: "cash", amount: 100000 }],
  };
  const s = await send(shop, shopCsrf, "post", "/sales", payload);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const repeated = await send(shop, shopCsrf, "post", "/sales", payload);
  assert.equal(repeated.body._id, s.body._id);
  assert.equal(
    (
      await send(shop, shopCsrf, "post", "/sales", {
        ...payload,
        idempotencyKey: "sale-test-unique-0002",
      })
    ).status,
    409,
  );
  assert.equal((await other.get("/api/v1/sales/" + s.body._id)).status, 404);
  await send(shop, shopCsrf, "put", "/settings", { name: "New Branding" });
  assert.equal(
    (await shop.get("/api/v1/sales/" + s.body._id)).body.profile.name,
    "TestOne",
  );
  const html = await shop.get(
    "/api/v1/sales/" + s.body._id + "/document?format=html",
  );
  assert.equal(html.status, 200);
  assert.match(html.text, /TestOne/);
  assert.equal(
    (await other.get("/api/v1/sales/" + s.body._id + "/document?format=html"))
      .status,
    404,
  );
});
test("payment idempotency, old gold exchange and karigar accountability", async () => {
  const p = {
    customerId: customer._id,
    amount: 1000,
    method: "cash",
    idempotencyKey: "payment-unique-0001",
  };
  const a = await send(shop, shopCsrf, "post", "/payments", p),
    b = await send(shop, shopCsrf, "post", "/payments", p);
  assert.equal(a.body._id, b.body._id);
  const g = await send(shop, shopCsrf, "post", "/old-gold", {
    customerId: customer._id,
    name: "Old bangle",
    weight: 10,
    purity: 22,
    rate24: 40000,
    mode: "cash",
  });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const k = await send(shop, shopCsrf, "post", "/records/karigars", {
    name: "Karigar A",
  });
  const issue = await send(shop, shopCsrf, "post", "/karigar-movements", {
    karigarId: k.body._id,
    type: "issue",
    purity: 22,
    weight: 10,
    sourceId: g.body._id,
    sourceKind: "old-gold",
    name: "Bangle work",
  });
  assert.equal(issue.status, 200, JSON.stringify(issue.body));
  const rec = await send(shop, shopCsrf, "post", "/karigar-movements", {
    karigarId: k.body._id,
    type: "receive",
    purity: 22,
    finished: 9,
    scrap: 0.5,
    remaining: 0.3,
    wastage: 0.2,
    name: "Returned bangle",
  });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  const ledger = await shop.get(
    "/api/v1/records/karigarLedger?karigarId=" + k.body._id,
  );
  assert.equal(
    ledger.body.rows.reduce((s, r) => s + r.data.pureMg, 0),
    0,
  );
});
test("expiry blocks writes, suspension revokes sessions, reset link is single use", async () => {
  const update = {
    name: "TestOne",
    subscription: { ...sub, status: "expired" },
    reason: "Test expiry",
  };
  let r = await send(
    admin,
    adminCsrf,
    "patch",
    "/platform-admin/tenants/" + tenant._id,
    update,
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await shop.get("/api/v1/me")).status, 401);
  const login = await shop
    .post("/api/v1/access/sign-in")
    .send({ username: "testone", password });
  shopCsrf = login.body.csrf;
  assert.equal(
    (
      await send(shop, shopCsrf, "post", "/records/customers", {
        name: "Blocked",
      })
    ).status,
    403,
  );
  assert.equal((await shop.get("/api/v1/records/customers")).status, 200);
  await send(
    admin,
    adminCsrf,
    "patch",
    "/platform-admin/tenants/" + tenant._id,
    { ...update, subscription: { ...sub, status: "suspended" } },
  );
  assert.equal((await shop.get("/api/v1/me")).status, 401);
  const detail = await admin.get(
    "/api/v1/platform-admin/tenants/" + tenant._id,
  );
  const u = detail.body.users[0];
  const reset = await send(
    admin,
    adminCsrf,
    "post",
    "/platform-admin/users/" + u._id + "/reset",
    { reason: "Test reset" },
  );
  const token = reset.body.accessPath.split("invite=")[1];
  const accept = await request(app)
    .post("/api/v1/access/accept-invitation")
    .send({ token, password: "FreshPassword-2026!" });
  assert.equal(accept.status, 200);
  assert.equal(
    (
      await request(app)
        .post("/api/v1/access/accept-invitation")
        .send({ token, password: "FreshPassword-2026!" })
    ).status,
    400,
  );
  assert.ok(await Audit.countDocuments({ action: "platform.shop.updated" }));
});
