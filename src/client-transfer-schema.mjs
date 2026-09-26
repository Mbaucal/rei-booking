export const CLIENT_TRANSFER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS client_transfer_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO client_transfer_state VALUES(1,0)`,
  ...["INSERT", "UPDATE", "DELETE"].map(
    (
      op,
    ) => `CREATE TRIGGER IF NOT EXISTS clients_transfer_${op.toLowerCase()} AFTER ${op} ON clients BEGIN
 UPDATE client_transfer_state SET revision=revision+1 WHERE id=1;
END`,
  ),
  `CREATE TABLE IF NOT EXISTS client_imports (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL,
 revision INTEGER NOT NULL, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','applied')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, committed_at INTEGER,
 commit_token TEXT, selection_hash TEXT, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
)`,
  `CREATE INDEX IF NOT EXISTS client_import_expiry ON client_imports(status,expires_at)`,
  `CREATE TABLE IF NOT EXISTS client_import_keys (
 source TEXT NOT NULL, source_key TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id),
 import_id TEXT NOT NULL REFERENCES client_imports(id),
 PRIMARY KEY(source,source_key)
)`,
];
const initialized = new WeakMap();
export async function ensureClientTransferSchema(db) {
  let promise = initialized.get(db);
  if (!promise) {
    promise = db
      .batch(CLIENT_TRANSFER_SCHEMA.map((s) => db.prepare(s)))
      .catch((e) => {
        initialized.delete(db);
        throw e;
      });
    initialized.set(db, promise);
  }
  await promise;
}
