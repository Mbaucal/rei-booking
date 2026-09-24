CREATE TABLE IF NOT EXISTS report_schedules (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1,
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), next_month TEXT NOT NULL,
 last_run_at TEXT, last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_templates (
 schedule_id TEXT NOT NULL REFERENCES report_schedules(id), revision INTEGER NOT NULL,
 effective_month TEXT NOT NULL, name TEXT NOT NULL, filters_json TEXT NOT NULL,
 minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 1439 AND minute%15=0),
 notifications INTEGER NOT NULL CHECK(notifications IN (0,1)), recipient TEXT,
 created_at TEXT NOT NULL, PRIMARY KEY(schedule_id,revision)
);

CREATE TABLE IF NOT EXISTS report_recipients (
 owner_id TEXT NOT NULL REFERENCES users(id), email TEXT NOT NULL, verified_at TEXT,
 active_job_id TEXT, code_hash TEXT, expires_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 last_sent_at INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0,
 sends INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,email)
);

CREATE TABLE IF NOT EXISTS report_snapshots (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES report_schedules(id), template_revision INTEGER NOT NULL,
 period TEXT NOT NULL, version INTEGER NOT NULL, supersedes_id TEXT REFERENCES report_snapshots(id),
 request_key TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, generated_at TEXT NOT NULL,
 cutoff_at TEXT NOT NULL, cutoff_audit_id INTEGER NOT NULL, definition_version TEXT NOT NULL,
 inputs_json TEXT NOT NULL, report_json TEXT NOT NULL,
 summary_csv TEXT NOT NULL, details_csv TEXT NOT NULL, comparison_csv TEXT NOT NULL,
 incomplete INTEGER NOT NULL CHECK(incomplete IN (0,1)),
 FOREIGN KEY(schedule_id,template_revision) REFERENCES report_templates(schedule_id,revision),
 UNIQUE(schedule_id,period,version)
);

CREATE TABLE IF NOT EXISTS report_email_jobs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), snapshot_id TEXT REFERENCES report_snapshots(id),
 kind TEXT NOT NULL CHECK(kind IN ('report','verification')), recipient TEXT NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', status_rank INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, lease_until INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
 provider_id TEXT UNIQUE, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS report_snapshot_listing ON report_snapshots(schedule_id,period,version);

CREATE INDEX IF NOT EXISTS report_job_queue ON report_email_jobs(status,next_attempt_at);

CREATE TRIGGER IF NOT EXISTS report_templates_immutable_update BEFORE UPDATE ON report_templates BEGIN
 SELECT RAISE(ABORT,'report_history_immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_templates_immutable_delete BEFORE DELETE ON report_templates BEGIN
 SELECT RAISE(ABORT,'report_history_immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_snapshots_immutable_update BEFORE UPDATE ON report_snapshots BEGIN
 SELECT RAISE(ABORT,'report_history_immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_snapshots_immutable_delete BEFORE DELETE ON report_snapshots BEGIN
 SELECT RAISE(ABORT,'report_history_immutable');
END;

CREATE TRIGGER IF NOT EXISTS report_job_payload_immutable BEFORE UPDATE ON report_email_jobs
 WHEN NEW.id!=OLD.id OR NEW.owner_id!=OLD.owner_id OR NEW.kind!=OLD.kind OR NEW.recipient!=OLD.recipient
 OR NEW.payload_json!=OLD.payload_json OR NEW.snapshot_id IS NOT OLD.snapshot_id BEGIN
 SELECT RAISE(ABORT,'report_email_immutable');
END;
