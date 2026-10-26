CREATE TABLE IF NOT EXISTS report_api_tokens (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 owner_version INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope='reports:read'),
 created_at TEXT NOT NULL, expires_at TEXT, expiry_days INTEGER,
 last_used_at TEXT, revoked_at TEXT, revocation_token TEXT,
 CHECK(expiry_days IS NULL OR expiry_days IN (30,90,365))
);

CREATE INDEX IF NOT EXISTS report_api_tokens_owner ON report_api_tokens(owner_id,created_at);

CREATE TABLE IF NOT EXISTS report_api_limits (
 key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
);
