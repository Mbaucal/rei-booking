// Additive records. Keep synchronized with migrations/0005_voucher_changes.sql.
export const VOUCHER_CHANGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS voucher_changes (
 id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL UNIQUE REFERENCES gift_vouchers(id),
 request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('void','refund','replaced')),
 expected_remaining_cents INTEGER NOT NULL CHECK(expected_remaining_cents>0),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 payment_method TEXT NOT NULL DEFAULT '' CHECK(payment_method IN ('','cash','card','bank_transfer','other')),
 payment_reference TEXT NOT NULL DEFAULT '',
 replacement_id TEXT UNIQUE, replacement_code TEXT UNIQUE, replacement_json TEXT,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 CHECK((kind='replaced' AND amount_cents=0 AND replacement_id IS NOT NULL AND replacement_code IS NOT NULL AND json_valid(replacement_json)) OR
 (kind IN ('void','refund') AND amount_cents>0 AND replacement_id IS NULL AND replacement_code IS NULL AND replacement_json IS NULL)),
 CHECK((kind='refund' AND payment_method!='') OR (kind!='refund' AND payment_method=''))
)`,
  `CREATE INDEX IF NOT EXISTS voucher_changes_date ON voucher_changes(created_at,id)`,
  `CREATE VIEW IF NOT EXISTS voucher_register AS
SELECT v.*,c.kind AS closure_kind,c.amount_cents AS closure_amount_cents,c.reason AS closure_reason,
 c.payment_method AS refund_method,c.payment_reference AS refund_reference,c.created_at AS closed_at,
 actor.name AS closed_by,c.replacement_id,parent.voucher_id AS replaces_id,
 CASE WHEN c.kind IN ('void','replaced') THEN 0 WHEN c.kind='refund' THEN v.price_cents-c.amount_cents ELSE v.price_cents END AS net_sale_cents,
 CASE WHEN c.id IS NULL THEN v.remaining_cents ELSE 0 END AS available_cents
FROM voucher_balances v LEFT JOIN voucher_changes c ON c.voucher_id=v.id
LEFT JOIN users actor ON actor.id=c.created_by
LEFT JOIN voucher_changes parent ON parent.replacement_id=v.id`,
  `CREATE TRIGGER IF NOT EXISTS voucher_change_guard BEFORE INSERT ON voucher_changes BEGIN
 SELECT RAISE(ABORT,'voucher_balance_changed') WHERE NOT EXISTS (
  SELECT 1 FROM voucher_balances v WHERE v.id=NEW.voucher_id AND v.remaining_cents=NEW.expected_remaining_cents
  AND v.remaining_cents>0 AND (NEW.kind='refund' OR v.used_cents=0)
  AND ((NEW.kind='replaced' AND NEW.amount_cents=0) OR NEW.amount_cents=v.remaining_cents)
 );
 SELECT RAISE(ABORT,'voucher_already_closed') WHERE EXISTS(SELECT 1 FROM voucher_changes WHERE voucher_id=NEW.voucher_id);
END`,
  `CREATE TRIGGER IF NOT EXISTS voucher_closed_redemption BEFORE INSERT ON voucher_redemptions
WHEN EXISTS(SELECT 1 FROM voucher_changes WHERE voucher_id=NEW.voucher_id) BEGIN
 SELECT RAISE(ABORT,'voucher_already_closed');
END`,
  `CREATE TRIGGER IF NOT EXISTS voucher_closed_reversal BEFORE INSERT ON voucher_redemption_reversals
WHEN EXISTS(SELECT 1 FROM voucher_changes c JOIN voucher_redemptions r ON r.voucher_id=c.voucher_id WHERE r.id=NEW.redemption_id) BEGIN
 SELECT RAISE(ABORT,'voucher_closed_reversal');
END`,
  // A corrected copy may retain an archived or repriced entitlement. Only this
  // linked, same-sale, exact-value snapshot bypasses the current-menu guard.
  `DROP TRIGGER IF EXISTS voucher_catalogue_guard`,
  `CREATE TRIGGER voucher_catalogue_guard BEFORE INSERT ON gift_vouchers
WHEN NEW.kind='treatment' AND NOT EXISTS (
 SELECT 1 FROM services WHERE id=NEW.service_id AND active=1 AND version=NEW.service_version
 AND name=NEW.service_name AND duration=NEW.duration AND price_cents=NEW.price_cents
) AND NOT EXISTS (
 SELECT 1 FROM voucher_changes c JOIN gift_vouchers old ON old.id=c.voucher_id
 WHERE c.kind='replaced' AND c.replacement_id=NEW.id AND c.replacement_code=NEW.code
 AND old.sale_id=NEW.sale_id AND old.kind=NEW.kind AND old.service_id IS NEW.service_id
 AND old.service_version IS NEW.service_version AND old.service_name=NEW.service_name
 AND old.duration IS NEW.duration AND old.price_cents=NEW.price_cents
)
BEGIN
 SELECT RAISE(ABORT,'voucher_treatment_changed');
END`,
  `CREATE TRIGGER IF NOT EXISTS voucher_change_reissue AFTER INSERT ON voucher_changes WHEN NEW.kind='replaced' BEGIN
 INSERT INTO gift_vouchers(id,sale_id,code,kind,service_id,service_version,service_name,duration,price_cents,recipient_name,sender_name,message,expires_on,design_json,issued_at)
 SELECT NEW.replacement_id,v.sale_id,NEW.replacement_code,v.kind,v.service_id,v.service_version,v.service_name,v.duration,v.price_cents,
 json_extract(NEW.replacement_json,'$.recipientName'),json_extract(NEW.replacement_json,'$.senderName'),json_extract(NEW.replacement_json,'$.message'),
 json_extract(NEW.replacement_json,'$.expiresOn'),json_extract(NEW.replacement_json,'$.design'),NEW.created_at
 FROM gift_vouchers v WHERE v.id=NEW.voucher_id;
END`,
  `CREATE TRIGGER IF NOT EXISTS voucher_change_audit AFTER INSERT ON voucher_changes BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at)
 VALUES(NEW.created_by,'voucher_'||NEW.kind,'gift_voucher',NEW.voucher_id,
 json_object('changeId',NEW.id,'amountCents',NEW.amount_cents,'reason',NEW.reason,'replacementId',NEW.replacement_id,'paymentMethod',NEW.payment_method,'paymentReference',NEW.payment_reference),NEW.created_at);
END`,
  ...["UPDATE", "DELETE"].map(
    (
      action,
    ) => `CREATE TRIGGER IF NOT EXISTS voucher_change_no_${action.toLowerCase()} BEFORE ${action} ON voucher_changes BEGIN
 SELECT RAISE(ABORT,'voucher_change_immutable');
END`,
  ),
];
const initialized = new WeakMap();
export async function ensureVoucherChangeSchema(db) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = db
      .batch(VOUCHER_CHANGE_SCHEMA.map((s) => db.prepare(s)))
      .catch((error) => {
        initialized.delete(db);
        throw error;
      });
    initialized.set(db, pending);
  }
  await pending;
}
