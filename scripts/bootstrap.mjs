import "dotenv/config";
import readline from "node:readline/promises";
import bcrypt from "bcryptjs";
import { connect, Identity } from "../db.mjs";
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const username =
  process.env.ADMIN_USERNAME ||
  (await rl.question("Platform admin username: "));
const password =
  process.env.ADMIN_PASSWORD ||
  (await rl.question(
    "Temporary password (12+ characters; terminal input is visible): ",
  ));
rl.close();
if (password.length < 12) throw Error("Use at least 12 characters");
await connect();
if (await Identity.exists({ type: "platformAdmin" }))
  throw Error(
    "An administrator already exists; use the secure recovery procedure",
  );
await Identity.create({
  username: username.toLowerCase(),
  name: "Ahmed Solutions",
  password: await bcrypt.hash(password, 12),
  type: "platformAdmin",
  role: "platformAdmin",
  firstLoginChangeRequired: true,
});
console.log("Platform administrator created. Open /admin.");
process.exit(0);
