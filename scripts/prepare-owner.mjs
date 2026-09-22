import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/security.mjs";
import { email, text } from "../src/domain.mjs";
// Use an OS-protected JSON file, never command-line password arguments.
const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: npm run owner:prepare -- /absolute/path/to/private/owner.json (email, name, password).",
  );
const input = JSON.parse(await readFile(path, "utf8"));
const mail = email(input.email, false),
  name = text(input.name, 100, "owner name"),
  hash = await hashPassword(input.password);
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
await mkdir("private", { recursive: true, mode: 0o700 });
const sql = `-- First owner only. Contains a password hash; never commit.\nINSERT INTO users(id,email,name,password_hash,role,must_change_password,created_at)\nSELECT ${[randomUUID(), mail, name, hash, "owner"].map(quote).join(",")},1,${quote(new Date().toISOString())}\nWHERE NOT EXISTS(SELECT 1 FROM users WHERE role='owner');\n`;
await writeFile("private/first-owner.sql", sql, { mode: 0o600, flag: "wx" });
console.log(
  "Prepared private/first-owner.sql. Apply it only to the intended TEST database; then delete both credential files. Password change is required on first sign-in.",
);
