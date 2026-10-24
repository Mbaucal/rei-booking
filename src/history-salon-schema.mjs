// Catalogue setup reads immutable historical evidence without rewriting it.
export const HISTORY_SALON_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS history_salon_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO history_salon_state VALUES(1,0)`,
  `CREATE TABLE IF NOT EXISTS history_salon_settings(id INTEGER PRIMARY KEY CHECK(id=1),currency TEXT,minor_unit_digits INTEGER,time_zone TEXT,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at TEXT)`,
  `INSERT OR IGNORE INTO history_salon_settings(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS history_catalogue_links(kind TEXT NOT NULL CHECK(kind IN('therapist','service')),source TEXT NOT NULL,label_key TEXT NOT NULL,duration INTEGER NOT NULL,entity_id TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(kind,source,label_key,duration))`,
  `CREATE TRIGGER IF NOT EXISTS history_catalogue_link_target BEFORE INSERT ON history_catalogue_links BEGIN SELECT RAISE(ABORT,'history_catalogue_target') WHERE (NEW.kind='therapist' AND NOT EXISTS(SELECT 1 FROM therapists WHERE id=NEW.entity_id)) OR (NEW.kind='service' AND NOT EXISTS(SELECT 1 FROM services WHERE id=NEW.entity_id)); END`,
  ...["UPDATE", "DELETE"].map(
    (op) =>
      `CREATE TRIGGER IF NOT EXISTS history_catalogue_links_immutable_${op.toLowerCase()} BEFORE ${op} ON history_catalogue_links BEGIN SELECT RAISE(ABORT,'history_catalogue_link_immutable'); END`,
  ),
  ...[
    "therapists",
    "services",
    "history_catalogue_links",
    "history_salon_settings",
  ].flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (op) =>
        `CREATE TRIGGER IF NOT EXISTS history_salon_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE history_salon_state SET revision=revision+1 WHERE id=1; END`,
    ),
  ),
  `CREATE TABLE IF NOT EXISTS history_salon_previews(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL,archive_revision INTEGER NOT NULL,catalogue_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS history_salon_preview_owner ON history_salon_previews(owner_id,expires_at)`,
  `CREATE TABLE IF NOT EXISTS history_salon_receipts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,body_hash TEXT NOT NULL,mutation_token TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,UNIQUE(owner_id,request_id))`,
];
const initialized = new WeakMap();
export async function ensureHistorySalonSchema(db) {
  let promise = initialized.get(db);
  if (!promise) {
    promise = db
      .batch(HISTORY_SALON_SCHEMA.map((q) => db.prepare(q)))
      .catch((e) => {
        initialized.delete(db);
        throw e;
      });
    initialized.set(db, promise);
  }
  await promise;
}
