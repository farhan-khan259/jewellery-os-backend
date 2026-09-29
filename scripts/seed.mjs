import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";
import { connect, Identity } from "../db.mjs";
import { createApp } from "../app.mjs";
export async function seedDemo(
  app,
  password = process.env.DEMO_PASSWORD ||
    crypto.randomBytes(15).toString("base64url"),
) {
  if (process.env.NODE_ENV === "production")
    throw Error("Demo seed is disabled in production");
  if (await Identity.exists({ username: "demo.admin" })) return null;
  await Identity.create({
    username: "demo.admin",
    name: "Ahmed Solutions",
    type: "platformAdmin",
    password: await bcrypt.hash(password, 12),
    firstLoginChangeRequired: false,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  let cookie = "",
    csrf = "";
  const request = async (path, body, method = "POST") => {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const data = await r.json();
    if (!r.ok) throw Error(path + ": " + JSON.stringify(data));
    if (data.csrf) csrf = data.csrf;
    return data;
  };
  try {
    await request("/access/sign-in", {
      username: "demo.admin",
      password,
      portal: "admin",
    });
    const shop = await request("/platform-admin/tenants", {
      name: "Mehrab Jewellers · Demo",
      username: "demo.shop",
      ownerName: "Shop Owner",
      subscription: {
        plan: "business",
        status: "active",
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        billingCycle: "yearly",
        paymentStatus: "paid",
        limits: { users: 8, branches: 3, features: ["*"] },
      },
      profile: {
        name: "Mehrab Jewellers",
        ownerName: "Demo Owner",
        phone: "0300 0000000",
        address: "Demo Jewellery Market",
        city: "Peshawar",
        footer: "Thank you for your trust. Har gram ka hisaab.",
        invoiceLanguage: "bilingual",
        terms: "Please keep your invoice for future reference.",
      },
    });
    cookie = "";
    csrf = "";
    await request("/access/sign-in", {
      username: "demo.shop",
      password: shop.temporaryPassword,
    });
    await request("/access/change-password", {
      currentPassword: shop.temporaryPassword,
      password,
    });
    await request("/cash-adjustments", {
      name: "Demo opening funds",
      amount: 6000000,
      method: "cash",
      reason: "Development opening cash only",
    });
    await request("/rates", {
      rate24: 41000,
      silver: 470,
      reason: "Sample rate for development only",
    });
    const customers = [];
    for (const [name, phone] of [
      ["Ayesha Khan", "03001110001"],
      ["Hassan Ali", "03001110002"],
      ["Fatima Ahmed", "03001110003"],
      ["Usman Shah", "03001110004"],
    ])
      customers.push(
        await request("/records/customers", {
          name,
          phone,
          address: "Peshawar",
          creditLimit: 10000000,
        }),
      );
    const karigars = [];
    for (const name of ["Rashid · Demo", "Nadeem · Demo"])
      karigars.push(
        await request("/records/karigars", {
          name,
          phone: "03001119999",
          skill: "Goldsmith",
        }),
      );
    const definitions = [
      ["Classic gold ring", "Ring", 5.72, 22],
      ["Heritage bangles", "Bangle", 23.84, 22],
      ["Crescent pendant", "Pendant", 4.18, 21],
      ["Bridal necklace", "Necklace", 42.65, 22],
      ["Everyday chain", "Chain", 12.45, 21],
      ["Pearl drop earrings", "Earrings", 8.34, 18],
      ["Wedding band", "Ring", 6.25, 22],
      ["Traditional jhumkay", "Earrings", 15.32, 22],
      ["Gold cuff", "Bangle", 20.25, 22],
      ["Fine rope chain", "Chain", 10.1, 18],
      ["Floral ring", "Ring", 6.12, 22],
      ["Silver bracelet", "Bangle", 18.25, 24],
      ["Petal pendant", "Pendant", 4.67, 22],
      ["Classic stud earrings", "Earrings", 3.28, 18],
    ];
    const items = [];
    for (const [name, category, weight, purity] of definitions)
      items.push(
        await request("/records/inventory", {
          name,
          category,
          purity,
          metal: name.startsWith("Silver") ? "silver" : "gold",
          grossWeight: weight,
          stoneWeight: 0,
          making: weight * 950,
          cost: weight * 30000,
          location: "Main showcase",
        }),
      );
    for (let i = 0; i < 4; i++)
      await request("/sales", {
        customerId: customers[i]._id,
        items: [items[i]._id],
        payments: [{ method: i % 2 ? "bank" : "cash", amount: 100000 }],
        idempotencyKey: crypto.randomUUID(),
      });
    const gold = await request("/old-gold", {
      customerId: customers[0]._id,
      name: "Old gold bangles",
      weight: 120,
      purity: 22,
      rate24: 41000,
      mode: "cash",
    });
    await request("/karigar-movements", {
      karigarId: karigars[0]._id,
      type: "issue",
      weight: 65,
      purity: 22,
      sourceId: gold._id,
      sourceKind: "old-gold",
      name: "Bridal set production",
    });
    for (let i = 0; i < 3; i++)
      await request("/records/orders", {
        customerId: customers[i]._id,
        name: [
          "Bridal necklace set",
          "Wedding bangles",
          "Custom engagement ring",
        ][i],
        items: [
          { description: "Custom jewellery", targetWeight: 15, purity: 22 },
        ],
        budget: 600000,
        advance: 25000,
        dueDate: new Date(Date.now() + (i + 1) * 86400000).toISOString(),
        ratePolicy: "delivery",
        karigarId: karigars[0]._id,
      });
    await request("/records/repairs", {
      customerId: customers[3]._id,
      name: "Chain clasp repair",
      weight: 7.42,
      purity: 22,
      condition: "Broken clasp",
      serviceCharge: 2500,
      dueDate: new Date(Date.now() + 86400000).toISOString(),
    });
    await request("/amanat", {
      customerId: customers[1]._id,
      type: "deposit",
      weight: 25,
      purity: 22,
    });
    await request("/records/expenses", {
      name: "Workshop supplies",
      amount: 2500,
      method: "cash",
      date: new Date().toISOString(),
    });
    return { admin: "demo.admin", shop: "demo.shop", password };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connect();
  const result = await seedDemo(createApp());
  console.log(
    result
      ? `DEVELOPMENT ONLY\nAdmin: ${result.admin}\nShop: ${result.shop}\nPassword: ${result.password}\nSample rates and transactions are not live business data.`
      : "Demo accounts already exist; no data changed.",
  );
  process.exit(0);
}
