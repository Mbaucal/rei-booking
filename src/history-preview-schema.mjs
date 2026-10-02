// Temporary owner-scoped analysis only. These tables never contain accepted history.
export const HISTORY_PREVIEW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS history_previews (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
    source TEXT NOT NULL, file_digest TEXT NOT NULL, file_bytes INTEGER NOT NULL,
    config_json TEXT NOT NULL CHECK(json_valid(config_json)), config_hash TEXT NOT NULL,
    total INTEGER NOT NULL CHECK(total BETWEEN 1 AND 50000), uploaded INTEGER NOT NULL DEFAULT 0,
    received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes BETWEEN 0 AND 26214400),
    phase TEXT NOT NULL DEFAULT 'upload' CHECK(phase IN ('upload','indexing','ready')),
    version INTEGER NOT NULL DEFAULT 1, client_revision INTEGER NOT NULL,
    index_cursor TEXT NOT NULL DEFAULT '', indexed_clients INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, mutation_token TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS history_previews_owner ON history_previews(owner_id,expires_at,created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS history_previews_retry ON history_previews(owner_id,config_hash)`,
  `CREATE TABLE IF NOT EXISTS history_preview_rows (
    preview_id TEXT NOT NULL REFERENCES history_previews(id) ON DELETE CASCADE,
    row_num INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    source_key TEXT NOT NULL, payload_digest TEXT NOT NULL, invalid INTEGER NOT NULL,
    draft_client_id TEXT, draft_client_version INTEGER,
    PRIMARY KEY(preview_id,row_num)
  )`,
  `CREATE INDEX IF NOT EXISTS history_preview_rows_key ON history_preview_rows(preview_id,source_key,row_num)`,
  `CREATE TABLE IF NOT EXISTS history_preview_keys (
    preview_id TEXT NOT NULL REFERENCES history_previews(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL, first_row INTEGER NOT NULL, row_count INTEGER NOT NULL,
    min_digest TEXT NOT NULL, max_digest TEXT NOT NULL,
    PRIMARY KEY(preview_id,source_key)
  )`,
  `CREATE TABLE IF NOT EXISTS history_preview_chunks (
    preview_id TEXT NOT NULL REFERENCES history_previews(id) ON DELETE CASCADE,
    offset INTEGER NOT NULL, row_count INTEGER NOT NULL, digest TEXT NOT NULL, token TEXT NOT NULL,
    PRIMARY KEY(preview_id,offset)
  )`,
  `CREATE TABLE IF NOT EXISTS history_preview_clients (
    preview_id TEXT NOT NULL REFERENCES history_previews(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL, name_key TEXT NOT NULL,
    phone_key TEXT, email_key TEXT, instagram_key TEXT,
    PRIMARY KEY(preview_id,client_id)
  )`,
  ...["name", "phone", "email", "instagram"].map(
    (key) =>
      `CREATE INDEX IF NOT EXISTS history_preview_client_${key} ON history_preview_clients(preview_id,${key}_key)`,
  ),
  `CREATE TABLE IF NOT EXISTS history_preview_decisions (
    preview_id TEXT NOT NULL REFERENCES history_previews(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, digest TEXT NOT NULL, result_version INTEGER NOT NULL,
    PRIMARY KEY(preview_id,request_id)
  )`,
  // Names, contacts and verified source links must share one invalidation clock.
  ...["client_instagram", "client_import_keys"].flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (op) =>
        `CREATE TRIGGER IF NOT EXISTS history_preview_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE client_transfer_state SET revision=revision+1 WHERE id=1; END`,
    ),
  ),
];
const initialized = new WeakMap();
export async function ensureHistoryPreviewSchema(db) {
  let promise = initialized.get(db);
  if (!promise) {
    promise = db
      .batch(HISTORY_PREVIEW_SCHEMA.map((q) => db.prepare(q)))
      .catch((e) => {
        initialized.delete(db);
        throw e;
      });
    initialized.set(db, promise);
  }
  await promise;
}
