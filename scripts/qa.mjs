// Uses real API requests and an isolated MongoDB replica set; no mocked business responses.
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { chromium } from "playwright";
import mongoose from "mongoose";
import fs from "node:fs/promises";
import { connect } from "../db.mjs";
import { createApp } from "../app.mjs";
import { seedDemo } from "./seed.mjs";
const mongo = await MongoMemoryReplSet.create({
  replSet: { count: 1, args: ["--nounixsocket"] },
});
await connect(mongo.getUri("jos_ui_qa"));
const app = createApp();
const credentials = await seedDemo(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
process.env.APP_ORIGIN = base;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = process.env.QA_OUTPUT || "qa-preview";
await fs.mkdir(out, { recursive: true });
try {
  await page.goto(base + "/access");
  await page.getByLabel("Username", { exact: true }).fill(credentials.shop);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page
    .getByRole("button", { name: "Open dashboard", exact: true })
    .click();
  await page.waitForURL("**/app");
  await page.getByText("Today’s overview", { exact: true }).waitFor();
  await page.screenshot({ path: out + "/dashboard.png", fullPage: true });
  for (const route of [
    "inventory",
    "customers",
    "karigars",
    "orders",
    "repairs",
    "old-gold",
    "expenses",
    "reports",
    "audits",
    "reconciliation",
    "team",
    "settings",
    "activity",
    "pos",
  ]) {
    await page.goto(base + "/app/" + route);
    await page.waitForTimeout(300);
    if (await page.getByRole("alert").count())
      throw Error(
        "Error state on " +
          route +
          ": " +
          (await page.getByRole("alert").textContent()),
      );
  }
  await page.goto(base + "/app/customers");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("UI verification customer");
  await page.getByLabel("Phone", { exact: true }).fill("03001230000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("UI verification customer", { exact: true }).waitFor();
  await page.goto(base + "/app/pos");
  await page.screenshot({ path: out + "/pos.png", fullPage: true });
  await page.goto(base + "/app");
  await page.getByLabel("Language / زبان").selectOption("ur");
  await page.waitForTimeout(250);
  if ((await page.locator("html").getAttribute("dir")) !== "rtl")
    throw Error("Urdu RTL missing");
  await page.screenshot({ path: out + "/dashboard-urdu.png", fullPage: true });
  await page.getByLabel("Language / زبان").selectOption("roman");
  await page.getByText("Aaj ka jaiza", { exact: true }).waitFor();
  await page.getByLabel("Language / زبان").selectOption("en");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out + "/mobile.png", fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  if (overflow) throw Error("Mobile horizontal overflow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "/app/sales");
  await page.locator("tbody a").first().click();
  const id = page.url().split("/").pop();
  const pdf = await page.request.get(
    base + `/api/v1/sales/${id}/document?lang=bilingual`,
  );
  if (!pdf.ok()) throw Error("PDF failed " + (await pdf.text()));
  await fs.writeFile(out + "/invoice-a4.pdf", await pdf.body());
  const thermal = await page.request.get(
    base + `/api/v1/sales/${id}/document?paper=thermal&lang=ur`,
  );
  if (!thermal.ok()) throw Error("Thermal PDF failed");
  await fs.writeFile(out + "/invoice-thermal.pdf", await thermal.body());
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto(base + "/admin");
  await page.getByLabel("Username", { exact: true }).fill(credentials.admin);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page
    .getByRole("button", { name: "Open dashboard", exact: true })
    .click();
  await page.waitForURL("**/admin/overview");
  await page.getByText("Platform overview", { exact: true }).waitFor();
  await page.screenshot({ path: out + "/admin.png", fullPage: true });
  await page.getByRole("button", { name: "Create shop", exact: true }).click();
  await page
    .getByLabel("Shop name", { exact: true })
    .fill("UI Provisioned Shop");
  await page.getByLabel("Owner name", { exact: true }).fill("New Owner");
  await page
    .getByLabel("Owner username", { exact: true })
    .fill("ui.provisioned");
  await page
    .getByRole("button", { name: "Create & issue credentials" })
    .click();
  await page.getByText("Issued access · shown once").waitFor();
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "shop sign-in",
        "14 live API screens",
        "create customer",
        "Urdu RTL",
        "Roman English",
        "mobile overflow",
        "A4 PDF",
        "Urdu thermal PDF",
        "admin sign-in",
        "provision shop",
      ],
      screenshots: out,
    }),
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();
}
