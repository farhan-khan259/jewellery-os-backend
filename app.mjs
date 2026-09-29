import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import mongoose from "mongoose";
import {
  authenticate,
  tenantAccess,
  permit,
  publicUser,
  fail,
} from "./security.mjs";
import { stock } from "./routes/stock.mjs";
import { access } from "./routes/access.mjs";
import { admin } from "./routes/platform.mjs";
import { records } from "./routes/records.mjs";
import { transactions } from "./routes/transactions.mjs";
import { control } from "./routes/control.mjs";
import { attachments } from "./routes/attachments.mjs";
import {
  invoiceHTML,
  recordHTML,
  statementHTML,
  sendDocument,
} from "./services/documents.mjs";
import { Identity } from "./db.mjs";
import { z } from "./validation.mjs";
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin && origin !== process.env.APP_ORIGIN)
        return next(fail(403, "ORIGIN_DENIED"));
    }
    next();
  });
  app.get("/api/health", (req, res) =>
    res
      .status(mongoose.connection.readyState === 1 ? 200 : 503)
      .json({ ok: mongoose.connection.readyState === 1 }),
  );
  app.use("/api/v1/access", access);
  app.use("/api/v1", authenticate);
  app.get("/api/v1/me", (req, res) =>
    res.json({
      user: publicUser(req.user),
      tenant: req.tenant
        ? {
            name: req.tenant.name,
            profile: req.tenant.profile,
            status: req.tenant.status,
            plan: req.tenant.plan,
            expiresAt: req.tenant.expiresAt,
            limits: req.tenant.limits,
          }
        : null,
      csrf: req.session.csrf,
    }),
  );
  app.patch("/api/v1/me", async (req, res) => {
    const language = z.enum(["en", "ur", "roman"]).parse(req.body.language);
    await Identity.updateOne({ _id: req.user._id }, { $set: { language } });
    res.json({ ok: true });
  });
  app.use("/api/v1/platform-admin", admin);
  app.use("/api/v1", tenantAccess);
  app.get("/api/v1/sales/:id/document", permit("sales"), async (req, res) =>
    sendDocument(req, res, await invoiceHTML(req)),
  );
  app.get(
    "/api/v1/customers/:id/statement",
    permit("customers"),
    async (req, res) => sendDocument(req, res, await statementHTML(req)),
  );
  app.get(
    "/api/v1/documents/:kind/:id",
    async (req, res, next) => {
      if (!["orders", "repairs", "old-gold"].includes(req.params.kind))
        throw fail(404, "NOT_FOUND");
      permit(req.params.kind)(req, res, next);
    },
    async (req, res) => sendDocument(req, res, await recordHTML(req)),
  );
  app.use("/api/v1/records", records);
  app.use("/api/v1", transactions);
  app.use("/api/v1", stock);
  app.use("/api/v1", control);
  app.use("/api/v1/attachments", attachments);
  app.use("/api", (req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Endpoint not found" } }),
  );
  const dist = fileURLToPath(new URL("../frontend/dist/", import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (req, res) =>
      res.sendFile(path.join(dist, "index.html")),
    );
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const validation = err.name === "ZodError",
      duplicate = err.code === 11000;
    const status = validation
      ? 400
      : duplicate
        ? 409
        : err.status ||
          (["ValidationError", "CastError", "StrictModeError"].includes(
            err.name,
          )
            ? 400
            : 500);
    if (status === 500)
      console.error(
        JSON.stringify({
          level: "error",
          method: req.method,
          path: req.path,
          error: err.name,
          message: err.message,
        }),
      );
    res
      .status(status)
      .json({
        error: {
          code: validation
            ? "VALIDATION"
            : duplicate
              ? "DUPLICATE"
              : err.code || "REQUEST_FAILED",
          message: validation
            ? err.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")
            : duplicate
              ? "This username or reference already exists"
              : status === 500
                ? "The operation could not be completed. Please try again."
                : err.message,
        },
      });
  });
  return app;
}
