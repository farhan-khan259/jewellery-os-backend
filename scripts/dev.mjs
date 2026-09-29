import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
const backendDir = fileURLToPath(new URL("../", import.meta.url));
const frontendDir = fileURLToPath(new URL("../../frontend/", import.meta.url));
process.chdir(backendDir);
dotenv.config({ path: path.join(backendDir, ".env"), quiet: true });
let mongo;
if (!process.env.MONGODB_URI) {
  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const devPath = path.resolve(process.env.DEV_DB_PATH || "var/dev-mongo");
  await fs.mkdir(devPath, { recursive: true });
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: "jeweller-dev", args: ["--nounixsocket"] },
    instanceOpts: [{ dbPath: devPath, port: 27019 }],
  });
  process.env.MONGODB_URI = mongo.getUri("jeweller_dev");
  console.log("Development MongoDB replica set started. Data persists in " + devPath);
}
process.env.APP_ORIGIN ||= "http://localhost:5173";
const children = [];
const run = (args, cwd = backendDir) => {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env, cwd });
  children.push(child);
  return child;
};
if (process.env.DEV_SEED === "1" || process.argv.includes("--demo")) {
  const seed = run(["scripts/seed.mjs"]);
  await new Promise((resolve, reject) => seed.on("exit", code => code ? reject(Error("Seed failed")) : resolve()));
}
run(["index.mjs"]);
if (process.argv.includes("--frontend")) {
  run([path.join(frontendDir, "node_modules/vite/bin/vite.js")], frontendDir);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  children.forEach(child => child.kill());
  await mongo?.stop({ doCleanup: false });
  process.exit(0);
});
