CREATE TABLE IF NOT EXISTS account_access_versions (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), mutation_token TEXT
);

INSERT OR IGNORE INTO account_access_versions(user_id) SELECT id FROM users;

CREATE TRIGGER IF NOT EXISTS account_access_user_insert AFTER INSERT ON users BEGIN
 INSERT OR IGNORE INTO account_access_versions(user_id) VALUES(NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS account_access_user_update AFTER UPDATE ON users BEGIN
 INSERT INTO account_access_versions(user_id,version) VALUES(NEW.id,2)
 ON CONFLICT(user_id) DO UPDATE SET version=version+1;
END;

CREATE TABLE IF NOT EXISTS account_previews (
 session_token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 target_user_id TEXT NOT NULL, target_version INTEGER NOT NULL,
 target_name TEXT NOT NULL, target_role TEXT NOT NULL CHECK(target_role IN ('reception','therapist')),
 target_therapist_id TEXT, mutation_token TEXT NOT NULL, created_at TEXT NOT NULL
);
