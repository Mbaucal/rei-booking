import { ensureAccountAccessSchema } from "./account-access-schema.mjs";

export const REPORT_ACCESS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS report_api_tokens (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 owner_version INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope='reports:read'),
 created_at TEXT NOT NULL, expires_at TEXT, expiry_days INTEGER,
 last_used_at TEXT, revoked_at TEXT, revocation_token TEXT,
 CHECK(expiry_days IS NULL OR expiry_days IN (30,90,365))
)`,
  `CREATE INDEX IF NOT EXISTS report_api_tokens_owner ON report_api_tokens(owner_id,created_at)`,
  `CREATE TABLE IF NOT EXISTS report_api_limits (
 key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
)`,
];
const initialized = new WeakMap();
export async function ensureReportAccessSchema(db) {
  await ensureAccountAccessSchema(db);
  let pending = initialized.get(db);
  if (!pending) {
    pending = db
      .batch(REPORT_ACCESS_SCHEMA.map((sql) => db.prepare(sql)))
      .catch((error) => {
        initialized.delete(db);
        throw error;
      });
    initialized.set(db, pending);
  }
  await pending;
}
