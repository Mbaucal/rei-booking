import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export async function prepareOwnerConsole({ email, name, password, repeat }) {
  const mail = String(email || "")
    .trim()
    .toLowerCase();
  const displayName = String(name || "").trim();
  if (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))
    throw new Error("Enter a valid owner email.");
  if (!displayName || displayName.length > 100)
    throw new Error("Enter a name of 1–100 characters.");
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new Error("Use a temporary password of 12–128 characters.");
  if (password !== repeat) throw new Error("The two passwords do not match.");

  // Match src/security.mjs exactly: the salt is a hex STRING, not raw bytes.
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const derived = await scryptAsync(password, salt, {
    N: 32768,
    r: 8,
    p: 3,
    dkLen: 32,
    maxmem: 64 * 1024 * 1024,
  });
  const hash = `scrypt$32768$8$3$${salt}$${bytesToHex(derived)}`;
  derived.fill(0);
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const at = new Date().toISOString();
  const target = `email=${quote(mail)} AND role='owner' AND active=1`;
  const saved = `${target} AND password_hash=${quote(hash)} AND must_change_password=1`;
  const emailLimit =
    "email:" + bytesToHex(sha256(new TextEncoder().encode(mail)));

  // Only a Cloudflare database administrator can execute this SQL. This tool
  // makes no network requests and has no database credentials or reset API.
  const sql = `INSERT INTO users(id,email,name,password_hash,role,must_change_password,created_at)
SELECT ${[id, mail, displayName, hash, "owner"].map(quote).join(",")},1,${quote(at)}
WHERE NOT EXISTS(SELECT 1 FROM users WHERE role='owner')
OR EXISTS(SELECT 1 FROM users WHERE ${target})
ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,must_change_password=1
WHERE users.role='owner' AND users.active=1;
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE ${saved});
DELETE FROM login_limits WHERE key=${quote(emailLimit)} AND EXISTS(SELECT 1 FROM users WHERE ${saved});
INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at)
SELECT NULL,'owner_access_recovery','user',id,'{"source":"cloudflare_console","must_change_password":true}',${quote(at)}
FROM users WHERE ${saved};
SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE ${saved}) THEN 'OWNER_READY' ELSE 'NOT_CHANGED: email is not an active owner' END AS result;`;
  return { email: mail, sql };
}
