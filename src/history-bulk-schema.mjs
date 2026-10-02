// Durable import jobs never depend on the lifetime of a temporary CSV preview.
export const HISTORY_BULK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS history_native_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO history_native_state VALUES(1,0)`,
  ...["INSERT", "UPDATE", "DELETE"].map(
    (op) =>
      `CREATE TRIGGER IF NOT EXISTS history_native_${op.toLowerCase()} AFTER ${op} ON appointments BEGIN UPDATE history_native_state SET revision=revision+1 WHERE id=1; END`,
  ),
  `CREATE TABLE IF NOT EXISTS history_import_jobs (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,input_hash TEXT NOT NULL,
    preview_id TEXT NOT NULL,preview_version INTEGER NOT NULL,source TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN('reviewing','ready','importing','completed','paused','cancelled')),
    version INTEGER NOT NULL DEFAULT 1,total INTEGER NOT NULL CHECK(total BETWEEN 1 AND 50000),
    reviewed INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0,duplicates INTEGER NOT NULL DEFAULT 0,
    counts_json TEXT NOT NULL CHECK(json_valid(counts_json)),
    client_revision INTEGER NOT NULL,archive_revision INTEGER NOT NULL,native_revision INTEGER NOT NULL,
    confirmation_token TEXT NOT NULL,confirmed_at INTEGER,expires_at INTEGER,
    reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,mutation_token TEXT,
    UNIQUE(owner_id,request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS history_jobs_owner ON history_import_jobs(owner_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS history_import_job_rows (
    job_id TEXT NOT NULL REFERENCES history_import_jobs(id),row_num INTEGER NOT NULL,
    ref_hash TEXT NOT NULL,line_key TEXT NOT NULL,client_id TEXT,client_version INTEGER,
    evidence_hash TEXT NOT NULL,archive_id TEXT NOT NULL,disposition TEXT NOT NULL,
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),review_json TEXT NOT NULL CHECK(json_valid(review_json)),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),processed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(job_id,row_num)
  )`,
  `CREATE INDEX IF NOT EXISTS history_job_rows_pending ON history_import_job_rows(job_id,processed,row_num)`,
  `CREATE INDEX IF NOT EXISTS history_job_rows_attention ON history_import_job_rows(job_id,disposition,row_num)`,
  `CREATE TABLE IF NOT EXISTS history_import_job_keys (
    job_id TEXT NOT NULL REFERENCES history_import_jobs(id),ref_hash TEXT NOT NULL,line_key TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,client_id TEXT NOT NULL,archive_id TEXT NOT NULL,
    PRIMARY KEY(job_id,ref_hash,line_key)
  )`,
  `CREATE TABLE IF NOT EXISTS history_import_job_statuses (
    job_id TEXT NOT NULL REFERENCES history_import_jobs(id),status_key TEXT NOT NULL,status TEXT,count INTEGER NOT NULL,
    PRIMARY KEY(job_id,status_key)
  )`,
  `CREATE TABLE IF NOT EXISTS history_import_job_requests (
    job_id TEXT NOT NULL REFERENCES history_import_jobs(id),request_id TEXT NOT NULL,body_hash TEXT NOT NULL,
    result_version INTEGER NOT NULL,PRIMARY KEY(job_id,request_id)
  )`,
];
const initialized = new WeakMap();
export async function ensureHistoryBulkSchema(db) {
  let promise = initialized.get(db);
  if (!promise) {
    promise = db
      .batch(HISTORY_BULK_SCHEMA.map((q) => db.prepare(q)))
      .catch((e) => {
        initialized.delete(db);
        throw e;
      });
    initialized.set(db, promise);
  }
  await promise;
}
