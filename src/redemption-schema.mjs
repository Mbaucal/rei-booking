// Additive only. Keep synchronized with migrations/0004_voucher_redemptions.sql.
export const REDEMPTION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS voucher_redemptions (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 voucher_id TEXT NOT NULL REFERENCES gift_vouchers(id), appointment_id TEXT NOT NULL REFERENCES appointments(id),
 appointment_version INTEGER NOT NULL, applied_cents INTEGER NOT NULL CHECK(applied_cents>0),
 debited_cents INTEGER NOT NULL CHECK(debited_cents>0), redeemed_on TEXT NOT NULL,
 appointment_json TEXT NOT NULL CHECK(json_valid(appointment_json)),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS redemptions_voucher ON voucher_redemptions(voucher_id)`,
  `CREATE INDEX IF NOT EXISTS redemptions_appointment ON voucher_redemptions(appointment_id)`,
  `CREATE TABLE IF NOT EXISTS voucher_redemption_reversals (
 id TEXT PRIMARY KEY, redemption_id TEXT NOT NULL UNIQUE REFERENCES voucher_redemptions(id),
 request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
)`,
  `CREATE VIEW IF NOT EXISTS active_voucher_redemptions AS
SELECT r.* FROM voucher_redemptions r WHERE NOT EXISTS (
 SELECT 1 FROM voucher_redemption_reversals x WHERE x.redemption_id=r.id
)`,
  `CREATE VIEW IF NOT EXISTS voucher_balances AS
SELECT v.*,COALESCE(u.used_cents,0) AS used_cents,
 v.price_cents-COALESCE(u.used_cents,0) AS remaining_cents
FROM gift_vouchers v LEFT JOIN (
 SELECT voucher_id,SUM(debited_cents) AS used_cents FROM active_voucher_redemptions GROUP BY voucher_id
) u ON u.voucher_id=v.id`,
  `CREATE TRIGGER IF NOT EXISTS redemption_validate BEFORE INSERT ON voucher_redemptions BEGIN
 SELECT RAISE(ABORT,'redemption_appointment_changed') WHERE NOT EXISTS (
  SELECT 1 FROM appointments a WHERE a.id=NEW.appointment_id AND a.version=NEW.appointment_version
  AND a.status='done' AND a.date<=NEW.redeemed_on AND a.net_cents>0
 );
 SELECT RAISE(ABORT,'redemption_voucher_unavailable') WHERE NOT EXISTS (
  SELECT 1 FROM voucher_balances v WHERE v.id=NEW.voucher_id
  AND (v.expires_on IS NULL OR v.expires_on>=NEW.redeemed_on)
  AND v.remaining_cents>=NEW.debited_cents
 );
 SELECT RAISE(ABORT,'redemption_amount_exceeded') WHERE NEW.applied_cents+COALESCE((
  SELECT SUM(applied_cents) FROM active_voucher_redemptions WHERE appointment_id=NEW.appointment_id
 ),0)>(SELECT net_cents FROM appointments WHERE id=NEW.appointment_id);
 SELECT RAISE(ABORT,'redemption_entitlement_mismatch') WHERE EXISTS (
  SELECT 1 FROM gift_vouchers v JOIN appointments a ON a.id=NEW.appointment_id WHERE v.id=NEW.voucher_id AND (
   (v.kind='amount' AND NEW.debited_cents!=NEW.applied_cents) OR
   (v.kind='treatment' AND (v.service_id!=a.service_id OR v.duration!=a.duration
    OR NEW.debited_cents!=v.price_cents OR NEW.applied_cents!=a.net_cents))
  )
 );
END`,
  `CREATE TRIGGER IF NOT EXISTS redemption_audit AFTER INSERT ON voucher_redemptions BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at)
 VALUES(NEW.created_by,'redeem_voucher','voucher_redemption',NEW.id,
 json_object('voucherId',NEW.voucher_id,'appointmentId',NEW.appointment_id,'appliedCents',NEW.applied_cents,'debitedCents',NEW.debited_cents),NEW.created_at);
END`,
  `CREATE TRIGGER IF NOT EXISTS reversal_audit AFTER INSERT ON voucher_redemption_reversals BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at)
 VALUES(NEW.created_by,'reverse_redemption','voucher_redemption',NEW.redemption_id,
 json_object('reversalId',NEW.id,'reason',NEW.reason),NEW.created_at);
END`,
  ...["voucher_redemptions", "voucher_redemption_reversals"].flatMap((table) =>
    ["UPDATE", "DELETE"].map(
      (action) =>
        `CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN
 SELECT RAISE(ABORT,'redemption_immutable');
END`,
    ),
  ),
  `CREATE TRIGGER IF NOT EXISTS redeemed_appointment_guard BEFORE UPDATE ON appointments
WHEN EXISTS(SELECT 1 FROM active_voucher_redemptions WHERE appointment_id=OLD.id) AND (
 NEW.status IS NOT OLD.status OR NEW.service_id IS NOT OLD.service_id OR NEW.duration IS NOT OLD.duration
 OR NEW.gross_cents IS NOT OLD.gross_cents OR NEW.net_cents IS NOT OLD.net_cents
 OR NEW.client_id IS NOT OLD.client_id OR NEW.date IS NOT OLD.date OR NEW.start_minute IS NOT OLD.start_minute
 OR NEW.therapist_id IS NOT OLD.therapist_id OR NEW.requested_therapist_id IS NOT OLD.requested_therapist_id
 OR NEW.room_id IS NOT OLD.room_id OR NEW.bed IS NOT OLD.bed
) BEGIN
 SELECT RAISE(ABORT,'redeemed_appointment_locked');
END`,
];
const initialized = new WeakMap();
export async function ensureRedemptionSchema(db) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = db
      .batch(REDEMPTION_SCHEMA.map((sql) => db.prepare(sql)))
      .catch((error) => {
        initialized.delete(db);
        throw error;
      });
    initialized.set(db, pending);
  }
  await pending;
}
