import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/security.mjs";
import { email, text } from "../src/domain.mjs";
import { firstOwnerSQL } from "./owner-sql.mjs";
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
await mkdir("private", { recursive: true, mode: 0o700 });
const sql =
  "-- First owner only. Contains a password hash; never commit.\n" +
  firstOwnerSQL({
    id: randomUUID(),
    mail,
    name,
    hash,
    createdAt: new Date().toISOString(),
  });
await writeFile("private/first-owner.sql", sql, { mode: 0o600, flag: "wx" });
console.log(
  "Prepared private/first-owner.sql. Apply it only to the intended TEST database; then delete both credential files. Password change is required on first sign-in.",
);
