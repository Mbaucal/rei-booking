// Additive only. Keep synchronized with migrations/0003_sales.sql.
export const SALES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS voucher_settings (
 id TEXT PRIMARY KEY CHECK(id='default'), design_json TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS sales (
 id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
 request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 buyer_id TEXT REFERENCES clients(id), buyer_name TEXT NOT NULL, buyer_email TEXT NOT NULL,
 payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','card','bank_transfer','other')),
 payment_reference TEXT NOT NULL, total_cents INTEGER NOT NULL CHECK(total_cents>0 AND total_cents<=100000000),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS gift_vouchers (
 id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), code TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('treatment','amount')), service_id TEXT REFERENCES services(id),
 service_version INTEGER, service_name TEXT NOT NULL, duration INTEGER,
 price_cents INTEGER NOT NULL CHECK(price_cents>0 AND price_cents<=100000000),
 recipient_name TEXT NOT NULL, sender_name TEXT NOT NULL, message TEXT NOT NULL,
 expires_on TEXT, design_json TEXT NOT NULL, issued_at TEXT NOT NULL,
 CHECK((kind='amount' AND service_id IS NULL AND duration IS NULL) OR
 (kind='treatment' AND service_id IS NOT NULL AND duration>0 AND service_version>0))
)`,
  `CREATE INDEX IF NOT EXISTS vouchers_sale ON gift_vouchers(sale_id)`,
  `CREATE INDEX IF NOT EXISTS sales_date ON sales(created_at,id)`,
  `CREATE TRIGGER IF NOT EXISTS voucher_catalogue_guard BEFORE INSERT ON gift_vouchers
WHEN NEW.kind='treatment' AND NOT EXISTS (
 SELECT 1 FROM services WHERE id=NEW.service_id AND active=1 AND version=NEW.service_version
 AND name=NEW.service_name AND duration=NEW.duration AND price_cents=NEW.price_cents
)
BEGIN
 SELECT RAISE(ABORT,'voucher_treatment_changed');
END`,
  `CREATE TRIGGER IF NOT EXISTS voucher_no_edit BEFORE UPDATE ON gift_vouchers BEGIN
 SELECT RAISE(ABORT,'issued_voucher_immutable');
END`,
  `CREATE TRIGGER IF NOT EXISTS voucher_no_delete BEFORE DELETE ON gift_vouchers BEGIN
 SELECT RAISE(ABORT,'issued_voucher_immutable');
END`,
  `CREATE TRIGGER IF NOT EXISTS sale_no_edit BEFORE UPDATE ON sales BEGIN
 SELECT RAISE(ABORT,'completed_sale_immutable');
END`,
  `CREATE TRIGGER IF NOT EXISTS sale_no_delete BEFORE DELETE ON sales BEGIN
 SELECT RAISE(ABORT,'completed_sale_immutable');
END`,
  `CREATE TABLE IF NOT EXISTS voucher_deliveries (
 id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL REFERENCES gift_vouchers(id),
 recipient TEXT NOT NULL COLLATE NOCASE, subject TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','sending','retry','accepted','delayed','delivered','failed','bounced','complained','suppressed','uncertain')),
 status_rank INTEGER NOT NULL DEFAULT 0, provider_id TEXT UNIQUE,
 attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(voucher_id,recipient)
)`,
  `CREATE TABLE IF NOT EXISTS email_events (
 id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, event_type TEXT NOT NULL,
 occurred_at TEXT NOT NULL, received_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS email_events_provider ON email_events(provider_id)`,
  `CREATE TABLE IF NOT EXISTS email_suppressions (
 recipient TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT NOT NULL, created_at TEXT NOT NULL
)`,
];
const initialized = new WeakMap();
export async function ensureSalesSchema(db) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = db
      .batch(SALES_SCHEMA.map((sql) => db.prepare(sql)))
      .catch((error) => {
        initialized.delete(db);
        throw error;
      });
    initialized.set(db, pending);
  }
  await pending;
}
