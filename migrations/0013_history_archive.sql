CREATE TABLE IF NOT EXISTS history_archive_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);

INSERT OR IGNORE INTO history_archive_state VALUES(1,0);

CREATE TABLE IF NOT EXISTS history_import_reviews (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL, token_hash TEXT NOT NULL, preview_id TEXT NOT NULL, preview_version INTEGER NOT NULL,
    client_revision INTEGER NOT NULL, archive_revision INTEGER NOT NULL,
    source TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    response_json TEXT NOT NULL CHECK(json_valid(response_json)),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    UNIQUE(owner_id,request_id)
  );

CREATE INDEX IF NOT EXISTS history_import_review_expiry ON history_import_reviews(expires_at);

CREATE TABLE IF NOT EXISTS history_imports (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
    confirm_hash TEXT NOT NULL, commit_token TEXT NOT NULL,
    source TEXT NOT NULL, preview_id TEXT NOT NULL, preview_version INTEGER NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at TEXT NOT NULL,
    UNIQUE(owner_id,request_id)
  );

CREATE TABLE IF NOT EXISTS history_archive_refs (
    source TEXT NOT NULL, ref_hash TEXT NOT NULL, reference TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('appointment','service-line')),
    PRIMARY KEY(source,ref_hash)
  );

CREATE TABLE IF NOT EXISTS history_archive (
    id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES history_imports(id),
    source TEXT NOT NULL, ref_hash TEXT NOT NULL, line_key TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES clients(id), evidence_hash TEXT NOT NULL,
    source_status TEXT, completion_state TEXT NOT NULL CHECK(completion_state IN ('completed','not_completed','unknown')),
    date TEXT NOT NULL, start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), duration INTEGER NOT NULL CHECK(duration>0 AND start_minute+duration<=1440),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)), imported_at TEXT NOT NULL,
    FOREIGN KEY(source,ref_hash) REFERENCES history_archive_refs(source,ref_hash),
    UNIQUE(source,ref_hash,line_key)
  );

CREATE INDEX IF NOT EXISTS history_archive_client ON history_archive(client_id,date DESC,start_minute DESC,id);

CREATE INDEX IF NOT EXISTS history_archive_client_status ON history_archive(client_id,source_status);

CREATE INDEX IF NOT EXISTS history_preview_archive_refs ON history_preview_rows(preview_id,trim(json_extract(record_json,'$.sourceAppointmentRef')));

CREATE TRIGGER IF NOT EXISTS history_archive_mode_guard BEFORE INSERT ON history_archive BEGIN SELECT RAISE(ABORT,'history_reference_mode_conflict') WHERE NOT EXISTS(SELECT 1 FROM history_archive_refs WHERE source=NEW.source AND ref_hash=NEW.ref_hash AND ((mode='appointment' AND NEW.line_key='') OR (mode='service-line' AND NEW.line_key LIKE 'line:%'))); END;

CREATE TRIGGER IF NOT EXISTS history_archive_revision AFTER INSERT ON history_archive BEGIN UPDATE history_archive_state SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS history_archive_immutable_update BEFORE UPDATE ON history_archive BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TRIGGER IF NOT EXISTS history_archive_immutable_delete BEFORE DELETE ON history_archive BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TRIGGER IF NOT EXISTS history_archive_refs_immutable_update BEFORE UPDATE ON history_archive_refs BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TRIGGER IF NOT EXISTS history_archive_refs_immutable_delete BEFORE DELETE ON history_archive_refs BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TRIGGER IF NOT EXISTS history_imports_immutable_update BEFORE UPDATE ON history_imports BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;

CREATE TRIGGER IF NOT EXISTS history_imports_immutable_delete BEFORE DELETE ON history_imports BEGIN SELECT RAISE(ABORT,'history_archive_immutable'); END;
