PRAGMA defer_foreign_keys = ON;

DROP VIEW IF EXISTS history_archive_effective;

DROP TRIGGER IF EXISTS history_archive_link_guard;

CREATE TABLE IF NOT EXISTS history_archive_client_links (
    archive_id TEXT PRIMARY KEY REFERENCES history_archive(id),
    client_id TEXT NOT NULL REFERENCES clients(id), version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );

CREATE TABLE history_archive_links_identity_backup (archive_id TEXT PRIMARY KEY,client_id TEXT NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);

INSERT INTO history_archive_links_identity_backup SELECT archive_id,client_id,version,created_by,created_at FROM history_archive_client_links;

DROP TABLE history_archive_client_links;

CREATE TABLE history_archive_identity_upgrade (
      id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES history_imports(id),
      source TEXT NOT NULL, ref_hash TEXT NOT NULL, line_key TEXT NOT NULL,
      client_id TEXT REFERENCES clients(id), evidence_hash TEXT NOT NULL,
      source_status TEXT, completion_state TEXT NOT NULL CHECK(completion_state IN ('completed','not_completed','unknown')),
      date TEXT NOT NULL, start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), duration INTEGER NOT NULL CHECK(duration>0 AND start_minute+duration<=1440),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)), imported_at TEXT NOT NULL,
      FOREIGN KEY(source,ref_hash) REFERENCES history_archive_refs(source,ref_hash),
      UNIQUE(source,ref_hash,line_key)
    );

INSERT INTO history_archive_identity_upgrade(id,import_id,source,ref_hash,line_key,client_id,evidence_hash,source_status,completion_state,date,start_minute,duration,record_json,imported_at) SELECT id,import_id,source,ref_hash,line_key,client_id,evidence_hash,source_status,completion_state,date,start_minute,duration,record_json,imported_at FROM history_archive;

DROP TABLE history_archive;

ALTER TABLE history_archive_identity_upgrade RENAME TO history_archive;

CREATE INDEX history_archive_client ON history_archive(client_id,date DESC,start_minute DESC,id);

CREATE INDEX history_archive_client_status ON history_archive(client_id,source_status);

CREATE TRIGGER history_archive_mode_guard BEFORE INSERT ON history_archive BEGIN SELECT RAISE(ABORT,'history_reference_mode_conflict') WHERE NOT EXISTS(SELECT 1 FROM history_archive_refs WHERE source=NEW.source AND ref_hash=NEW.ref_hash AND ((mode='appointment' AND NEW.line_key='') OR (mode='service-line' AND NEW.line_key LIKE 'line:%'))); END;

CREATE TRIGGER history_archive_revision AFTER INSERT ON history_archive BEGIN UPDATE history_archive_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER history_archive_immutable_update BEFORE UPDATE ON history_archive BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TRIGGER history_archive_immutable_delete BEFORE DELETE ON history_archive BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TABLE history_import_job_keys_identity_upgrade (
      job_id TEXT NOT NULL REFERENCES history_import_jobs(id),ref_hash TEXT NOT NULL,line_key TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,client_id TEXT,archive_id TEXT NOT NULL,
      PRIMARY KEY(job_id,ref_hash,line_key)
    );

INSERT INTO history_import_job_keys_identity_upgrade(job_id,ref_hash,line_key,evidence_hash,client_id,archive_id) SELECT job_id,ref_hash,line_key,evidence_hash,client_id,archive_id FROM history_import_job_keys;

DROP TABLE history_import_job_keys;

ALTER TABLE history_import_job_keys_identity_upgrade RENAME TO history_import_job_keys;

CREATE TABLE IF NOT EXISTS history_archive_client_links (
    archive_id TEXT PRIMARY KEY REFERENCES history_archive(id),
    client_id TEXT NOT NULL REFERENCES clients(id), version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  );

INSERT INTO history_archive_client_links(archive_id,client_id,version,created_by,created_at) SELECT archive_id,client_id,version,created_by,created_at FROM history_archive_links_identity_backup;

DROP TABLE history_archive_links_identity_backup;

CREATE INDEX IF NOT EXISTS history_archive_link_client ON history_archive_client_links(client_id,archive_id);

CREATE TRIGGER IF NOT EXISTS history_archive_link_guard BEFORE INSERT ON history_archive_client_links BEGIN SELECT RAISE(ABORT,'history_client_link_target') WHERE NOT EXISTS(SELECT 1 FROM history_archive WHERE id=NEW.archive_id AND client_id IS NULL); END;

CREATE TRIGGER IF NOT EXISTS history_archive_link_revision AFTER INSERT ON history_archive_client_links BEGIN UPDATE history_archive_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS history_archive_client_links_immutable_update BEFORE UPDATE ON history_archive_client_links BEGIN SELECT RAISE(ABORT,'history_client_link_immutable'); END;

CREATE TRIGGER IF NOT EXISTS history_archive_client_links_immutable_delete BEFORE DELETE ON history_archive_client_links BEGIN SELECT RAISE(ABORT,'history_client_link_immutable'); END;

CREATE TABLE IF NOT EXISTS history_client_link_reviews (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL,
    fingerprint TEXT NOT NULL,archive_revision INTEGER NOT NULL,client_revision INTEGER NOT NULL,native_revision INTEGER NOT NULL,
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS history_client_link_review_owner ON history_client_link_reviews(owner_id,expires_at);

CREATE TABLE IF NOT EXISTS history_client_link_receipts (
    owner_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,body_hash TEXT NOT NULL,
    mutation_token TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,request_id)
  );

CREATE VIEW IF NOT EXISTS history_archive_effective AS SELECT
    h.id,h.import_id,h.source,h.ref_hash,h.line_key,COALESCE(l.client_id,h.client_id) AS client_id,
    h.evidence_hash,h.source_status,h.completion_state,h.date,h.start_minute,h.duration,h.record_json,h.imported_at
    FROM history_archive h LEFT JOIN history_archive_client_links l ON l.archive_id=h.id;

CREATE TABLE IF NOT EXISTS history_import_job_policies (
    job_id TEXT PRIMARY KEY REFERENCES history_import_jobs(id),
    allow_unlinked_clients INTEGER NOT NULL DEFAULT 0 CHECK(allow_unlinked_clients IN(0,1))
  );
