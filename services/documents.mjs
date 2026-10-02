import fs from "node:fs";
import { chromium } from "playwright";
import { Sale, Record, Attachment } from "../db.mjs";
import { scope, fail, findRecord } from "../security.mjs";
import { attachmentBytes } from "../routes/attachments.mjs";
const arabicFont = fs
  .readFileSync(
    new URL("../assets/NotoSansArabic-Regular.ttf", import.meta.url),
  )
  .toString("base64");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cash = (v) =>
    (Number(v || 0) / 100).toLocaleString("en-PK", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  weight = (v) => (Number(v || 0) / 1000).toFixed(3);
export function frame(title, body, thermal = false) {
  body = body.replace(/<img class="qr"[^>]*>/g, "");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@font-face{font-family:InvoiceArabic;src:url(data:font/ttf;base64,${arabicFont})} [dir=rtl]{font-family:InvoiceArabic,Arial,sans-serif} @page{size:${thermal ? "80mm auto" : "A4"};margin:${thermal ? "5mm" : "14mm"}}*{box-sizing:border-box}body{font:12px Arial,InvoiceArabic,sans-serif;color:#17312a;margin:0;line-height:1.45}h1,h2,p{margin:0 0 8px}h1{font-size:26px}small{color:#63736c}header{display:flex;justify-content:space-between;border-bottom:3px solid #b58b3f;padding-bottom:16px;margin-bottom:16px}header img{max-width:90px;max-height:70px;object-fit:contain}table{width:100%;border-collapse:collapse;margin:14px 0}th{text-align:start;background:#edf2ef}td,th{padding:8px 6px;border-bottom:1px solid #dde5e0;vertical-align:top}td.num{text-align:end;white-space:nowrap}tfoot{font-weight:bold}.totals{margin-inline-start:auto;width:50%}.totals div{display:flex;justify-content:space-between;padding:4px}.grand{background:#17312a;color:white;padding:10px!important}footer{break-inside:avoid;margin-top:24px;border-top:1px solid #dde5e0;padding-top:15px}.signatures{display:flex;justify-content:space-between;margin-top:35px}.signatures span{border-top:1px solid #a1aea6;padding-top:8px;min-width:150px}.qr{width:70px;height:70px}tr{break-inside:avoid}${thermal ? "body{font-size:10px}header{display:block}h1{font-size:18px}table{font-size:9px}td,th{padding:4px 2px}.totals{width:100%}.signatures{display:none}" : ""}@media print{button{display:none}}</style></head><body>${body}</body></html>`;
}
export async function invoiceHTML(req) {
  const s = await Sale.findOne(scope(req, { _id: req.params.id })).lean();
  if (!s) throw fail(404, "NOT_FOUND");
  const p = s.profile || {},
    thermal = req.query.paper === "thermal",
    lang = ["en", "ur", "bilingual"].includes(req.query.lang)
      ? req.query.lang
      : p.invoiceLanguage || "en";
  const tr = (en, ur) =>
    lang === "ur" ? ur : lang === "bilingual" ? `${en} / ${ur}` : en;
  let logo = "";
  if (p.logoId) {
    const a = await Attachment.findOne({
      _id: p.logoId,
      tenantId: req.tenant._id,
    });
    if (a)
      logo = `<img src="data:${a.mime};base64,${(await attachmentBytes(a)).toString("base64")}"/>`;
  }
  const qr = "";
  const lineRows = s.lines
    .map((l) =>
      thermal
        ? `<tr><td colspan="2"><b>${esc(l.description)}</b> · ${esc(l.sku)}<br>${l.purity}K · ${weight(l.netMg)} g × ${cash(l.rate)}<br>Making ${cash(l.making)} · Stone ${cash(l.stone)} · Wastage ${cash(l.wastage)}</td><td class="num">${cash(l.total)}</td></tr>`
        : `<tr><td><b>${esc(l.description)}</b><br><small>${esc(l.sku)} · ${l.purity}K</small></td><td class="num">${weight(l.grossMg)}<br><small>${weight(l.stoneMg)}</small></td><td class="num">${weight(l.netMg)}</td><td class="num">${cash(l.rate)}</td><td class="num">${cash(l.making)}<br><small>${cash(l.wastage)}</small></td><td class="num">${cash(l.stone)}</td><td class="num">${cash(l.total)}</td></tr>`,
    )
    .join("");
  const t = s.totals,
    entry = (label, n) => `<div><span>${label}</span><b>${cash(n)}</b></div>`;
  return frame(
    s.number,
    `<section ${lang === "ur" ? 'dir="rtl"' : ""}><header><div>${logo}<h1>${esc(p.name)}</h1><p>${esc(p.address)} ${esc(p.city)}</p><p>${esc(p.phone)} · ${esc(p.email)}</p><small>${esc(p.registration)}</small></div><div><h2>${tr("SALES INVOICE", "فروخت کی رسید")}</h2><b>${esc(s.number)}</b><p>${new Date(s.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Karachi" })}</p><b>${s.status === "void" ? "VOID / منسوخ" : ""}</b></div></header><p><small>${tr("BILL TO", "گاہک")}</small><br><b>${esc(s.customer.name)}</b><br>${esc(s.customer.phone)}<br>${esc(s.customer.address)}</p><table><thead><tr>${(thermal ? [tr("Item", "زیور"), "", "PKR"] : [tr("Description", "تفصیل"), tr("Gross / stone g", "کل / نگینہ"), tr("Net g", "خالص وزن"), tr("Rate / g", "فی گرام"), tr("Making / wastage", "بنوائی / ضیاع"), tr("Stone", "نگینہ"), tr("Total PKR", "کل رقم")]).map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${lineRows}</tbody></table>${s.oldGold ? `<p><b>${tr("Old gold exchange", "پرانے سونے کی تبدیلی")}</b>: ${esc(s.oldGold.name)} · ${s.oldGold.purity}K · ${weight(s.oldGold.netMg)} g · Pure ${weight(s.oldGold.pureMg)} g · 24K rate ${cash(Math.round(s.oldGold.rate24 * 100))}/g</p>` : ""}<div class="totals">${entry(tr("Subtotal", "ذیلی کل"), t.subtotal)}${entry(tr("Discount", "رعایت"), -t.discount)}${entry(tr("Tax", "ٹیکس"), t.tax)}${entry(tr("Old gold adjustment", "پرانے سونے کی رقم"), -t.exchange)}${entry(tr("Customer credit / advance", "پیشگی رقم"), -t.credit)}<div class="grand"><span>${tr("Amount payable", "قابل ادا رقم")}</span><b>PKR ${cash(t.payable)}</b></div>${entry(tr("Amount received", "وصول شدہ رقم"), t.received)}${entry(tr("Invoice balance", "باقی رقم"), t.balance)}${entry(tr("Previous account balance", "پچھلا کھاتہ"), t.previousBalance)}${entry(tr("Updated account balance", "موجودہ کھاتہ"), t.previousBalance + t.total - t.exchange - t.received)}</div><p>${tr("Payment breakdown", "ادائیگی کی تفصیل")}: ${s.payments.map((x) => `${esc(x.method)} PKR ${cash(x.amount)}`).join(" · ") || "Credit / ادھار"}</p><p>${tr("Prepared by", "تیار کنندہ")}: ${esc(s.cashier)}</p><div class="signatures"><span>${tr("Customer signature", "گاہک کے دستخط")}</span><span>${tr("Authorised signature", "مجاز دستخط")}</span></div><footer><img class="qr" src="${qr}"/><p>${esc(p.terms)}</p><p>${esc(p.bank)}</p><b>${esc(p.footer || "Thank you for your trust.")}</b><p><small>Invoice link requires authorised shop access. Amounts in PKR; weights in grams.</small></p></footer></section>`,
    thermal,
  );
}
export async function recordHTML(req) {
  const kind = req.params.kind,
    r = await findRecord(req, kind, req.params.id),
    p = req.tenant.profile,
    d = r.data;
  let customer;
  if (d.customerId) customer = await findRecord(req, "customers", d.customerId);
  const heading =
    kind === "orders"
      ? "CUSTOM ORDER / خصوصی آرڈر"
      : kind === "repairs"
        ? "REPAIR RECEIPT / مرمت کی رسید"
        : "OLD GOLD RECEIPT / پرانے سونے کی رسید";
  const row = (label, value) =>
    `<tr><th>${label}</th><td>${esc(value)}</td></tr>`;
  let rows = row("Description / تفصیل", d.name);
  if (kind === "orders") {
    rows +=
      row("Due date / تاریخ", new Date(d.dueDate).toLocaleDateString("en-GB")) +
      row("Rate policy / نرخ کا اصول", d.ratePolicy) +
      row("Budget / بجٹ", "PKR " + cash(Math.round(d.budget * 100))) +
      row("Advance / پیشگی رقم", "PKR " + cash(d.advancePaisa)) +
      row("Measurements / پیمائش", d.measurements) +
      row("Payment schedule / ادائیگی", d.paymentSchedule);
    for (const item of d.items)
      rows += row(
        item.description,
        `${item.targetWeight.toFixed(3)} g · ${item.purity}K · ${item.stones || ""}`,
      );
  } else if (kind === "repairs") {
    rows +=
      row("Received weight / وصول شدہ وزن", d.weight.toFixed(3) + " g") +
      row("Purity / خالص پن", d.purity + "K") +
      row("Condition / حالت", d.condition) +
      row("Metal added / شامل دھات", d.metalAdded.toFixed(3) + " g") +
      row("Metal removed / نکالی دھات", d.metalRemoved.toFixed(3) + " g") +
      row(
        "Service charge / مرمت کی رقم",
        "PKR " + cash(Math.round(d.serviceCharge * 100)),
      ) +
      row("Due date / تاریخ", new Date(d.dueDate).toLocaleDateString("en-GB"));
  } else {
    rows +=
      row("Gross weight / کل وزن", Number(d.weight).toFixed(3) + " g") +
      row("Deductions / کٹوتی", Number(d.deductions || 0).toFixed(3) + " g") +
      row("Testing loss / جانچ کی کمی", Number(d.loss || 0).toFixed(3) + " g") +
      row("Tested purity / خالص پن", d.purity + "K") +
      row("Net metal / خالص دھات", weight(d.netMg) + " g") +
      row("Pure gold equivalent / خالص سونا", weight(d.pureMg) + " g") +
      row(
        "24K rate / فی گرام نرخ",
        "PKR " + cash(Math.round((d.rate24 || 0) * 100)),
      ) +
      row("Valuation / قیمت", "PKR " + cash(d.value)) +
      row("Settlement / طریقہ", d.mode);
  }
  rows += row("Notes / تفصیلات", d.notes || "");
  return frame(
    r.key || d.name,
    `<header><div><h1>${esc(p.name)}</h1><p>${esc(p.address)} · ${esc(p.phone)}</p></div><div><h2>${heading}</h2><b>${esc(r.key)}</b><p>${new Date(r.createdAt).toLocaleDateString("en-GB")}</p></div></header><h2>${esc(customer?.data.name || "")}</h2><p>${esc(customer?.data.phone || "")}</p><table>${rows}</table><div class="signatures"><span>Customer / گاہک</span><span>Authorised / مجاز</span></div><footer>${esc(p.footer)}</footer>`,
  );
}
export async function statementHTML(req) {
  const c = await findRecord(req, "customers", req.params.id),
    filter = scope(req, {
      kind: "customerLedger",
      "data.customerId": String(c._id),
    });
  const all = await Record.find(filter).sort({ createdAt: 1 }).lean();
  let balance = 0;
  const rows = all
    .map((r) => {
      balance += r.data.amount;
      return `<tr><td>${new Date(r.createdAt).toLocaleDateString("en-GB")}</td><td>${esc(r.data.name)}</td><td class="num">${cash(r.data.amount)}</td><td class="num">${cash(balance)}</td></tr>`;
    })
    .join("");
  return frame(
    "Customer statement",
    `<header><div><h1>${esc(req.tenant.profile.name)}</h1><p>${esc(req.tenant.profile.address)} · ${esc(req.tenant.profile.phone)}</p></div><h2>Customer statement / کھاتہ</h2></header><h2>${esc(c.data.name)}</h2><p>${esc(c.data.phone)}</p><table><tr><th>Date</th><th>Transaction</th><th>PKR</th><th>Balance</th></tr>${rows}</table><h2>Closing balance: PKR ${cash(balance)}</h2>`,
  );
}
export async function sendDocument(req, res, html) {
  res.set("Cache-Control", "no-store");
  if (req.query.format === "html") return res.type("html").send(html);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const thermal = req.query.paper === "thermal";
    const height = thermal
      ? Math.max(
          400,
          (await page.evaluate(() => document.body.scrollHeight)) + 100,
        )
      : 0;
    const pdf = await page.pdf({
      printBackground: true,
      ...(thermal
        ? { width: "80mm", height: height + "px" }
        : { format: "A4" }),
      preferCSSPageSize: !thermal,
    });
    res
      .type("application/pdf")
      .attachment(`${req.params.id || "document"}.pdf`)
      .send(pdf);
  } finally {
    await browser?.close();
  }
}
