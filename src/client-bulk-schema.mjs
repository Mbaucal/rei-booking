export const CLIENT_BULK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS client_bulk_uploads (import_id TEXT PRIMARY KEY REFERENCES client_imports(id) ON DELETE CASCADE, total INTEGER NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'upload', file_hash TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)))`,
  `CREATE TABLE IF NOT EXISTS client_bulk_chunks (import_id TEXT NOT NULL REFERENCES client_imports(id) ON DELETE CASCADE, offset INTEGER NOT NULL, hash TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(import_id,offset))`,
  `CREATE TABLE IF NOT EXISTS client_bulk_rows (import_id TEXT NOT NULL REFERENCES client_imports(id) ON DELETE CASCADE, row_num INTEGER NOT NULL, client_id TEXT NOT NULL, source_key TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), status TEXT NOT NULL, message TEXT NOT NULL, matches_json TEXT NOT NULL DEFAULT '[]', fingerprint TEXT NOT NULL, PRIMARY KEY(import_id,row_num))`,
  `CREATE TABLE IF NOT EXISTS client_bulk_contacts (import_id TEXT NOT NULL, row_num INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, fingerprint TEXT NOT NULL, FOREIGN KEY(import_id,row_num) REFERENCES client_bulk_rows(import_id,row_num) ON DELETE CASCADE, PRIMARY KEY(import_id,kind,value,row_num))`,
  `CREATE INDEX IF NOT EXISTS client_bulk_contact_rows ON client_bulk_contacts(import_id,row_num)`,
];
const initialized = new WeakMap();
export async function ensureClientBulk(db) {
  let p = initialized.get(db);
  if (!p) {
    p = db.batch(CLIENT_BULK_SCHEMA.map((q) => db.prepare(q))).catch((e) => {
      initialized.delete(db);
      throw e;
    });
    initialized.set(db, p);
  }
  await p;
}
