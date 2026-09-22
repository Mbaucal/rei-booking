// Idempotent additive migration. Keep synchronized with 0002_report_bonuses.sql.
// Authenticated app requests may install these empty tables, so a deployment
// never requires the owner to repeat terminal setup. Wrangler may apply the
// same migration later and record it in d1_migrations without changing data.
export const REPORT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS therapist_bonus_rules (
 therapist_id TEXT PRIMARY KEY REFERENCES therapists(id),
 mode TEXT NOT NULL CHECK(mode IN ('hourly','percent')),
 regular_rate INTEGER NOT NULL CHECK(regular_rate>=0 AND regular_rate<=100000000),
 requested_rate INTEGER NOT NULL CHECK(requested_rate>=0 AND requested_rate<=100000000),
 updated_at TEXT NOT NULL,
 CHECK(mode!='percent' OR (regular_rate<=10000 AND requested_rate<=10000))
)`,
  `CREATE TABLE IF NOT EXISTS appointment_bonus_rules (
 appointment_id TEXT PRIMARY KEY REFERENCES appointments(id),
 mode TEXT NOT NULL CHECK(mode IN ('hourly','percent')),
 regular_rate INTEGER NOT NULL CHECK(regular_rate>=0 AND regular_rate<=100000000),
 requested_rate INTEGER NOT NULL CHECK(requested_rate>=0 AND requested_rate<=100000000),
 captured_at TEXT NOT NULL,
 CHECK(mode!='percent' OR (regular_rate<=10000 AND requested_rate<=10000))
)`,
];
const initialized = new WeakMap();
export async function ensureReportSchema(db) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = db
      .batch(REPORT_SCHEMA.map((sql) => db.prepare(sql)))
      .catch((error) => {
        initialized.delete(db);
        throw error;
      });
    initialized.set(db, pending);
  }
  await pending;
}
