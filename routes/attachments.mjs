import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Attachment } from "../db.mjs";
import { permit, fail } from "../security.mjs";
export const attachments = Router();
export const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }),
  root = path.resolve("var/uploads");
const s3 = process.env.S3_BUCKET
  ? new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
    })
  : null;
export async function attachmentBytes(a) {
  if (a.backend === "s3") {
    const r = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: a.storageKey,
      }),
    );
    return Buffer.from(await r.Body.transformToByteArray());
  }
  return fs.readFile(path.join(root, a.storageKey));
}
export async function storeAttachment(req, res) {
  const f = req.file;
  if (!f) throw fail(400, "FILE_REQUIRED");
  const png = f.buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg = f.buffer[0] === 255 && f.buffer[1] === 216 && f.buffer[2] === 255;
  if (!png && !jpeg)
    throw fail(400, "IMAGE_ONLY", "Upload a PNG or JPEG image");
  const mime = png ? "image/png" : "image/jpeg",
    key = `${req.tenant._id}/${crypto.randomUUID()}`;
  if (s3)
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: f.buffer,
        ContentType: mime,
      }),
    );
  else {
    await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true });
    await fs.writeFile(path.join(root, key), f.buffer);
  }
  const a = await Attachment.create({
    tenantId: req.tenant._id,
    branch: req.branch,
    mime,
    size: f.size,
    name: f.originalname.slice(0, 200),
    storageKey: key,
    backend: s3 ? "s3" : "local",
  });
  res.json({ id: a._id, url: `/api/v1/attachments/${a._id}` });
}
attachments.post(
  "/",
  permit("attachments"),
  upload.single("file"),
  storeAttachment,
);
attachments.get("/:id", async (req, res) => {
  const a = await Attachment.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (
    !a ||
    (!req.user.branches.includes(a.branch) &&
      String(req.tenant.profile.logoId) !== req.params.id)
  )
    throw fail(404, "NOT_FOUND");
  res
    .set("Cache-Control", "private, max-age=300")
    .type(a.mime)
    .send(await attachmentBytes(a));
});
