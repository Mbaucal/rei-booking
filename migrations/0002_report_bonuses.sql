CREATE TABLE IF NOT EXISTS therapist_bonus_rules (
 therapist_id TEXT PRIMARY KEY REFERENCES therapists(id),
 mode TEXT NOT NULL CHECK(mode IN ('hourly','percent')),
 regular_rate INTEGER NOT NULL CHECK(regular_rate>=0 AND regular_rate<=100000000),
 requested_rate INTEGER NOT NULL CHECK(requested_rate>=0 AND requested_rate<=100000000),
 updated_at TEXT NOT NULL,
 CHECK(mode!='percent' OR (regular_rate<=10000 AND requested_rate<=10000))
);
CREATE TABLE IF NOT EXISTS appointment_bonus_rules (
 appointment_id TEXT PRIMARY KEY REFERENCES appointments(id),
 mode TEXT NOT NULL CHECK(mode IN ('hourly','percent')),
 regular_rate INTEGER NOT NULL CHECK(regular_rate>=0 AND regular_rate<=100000000),
 requested_rate INTEGER NOT NULL CHECK(requested_rate>=0 AND requested_rate<=100000000),
 captured_at TEXT NOT NULL,
 CHECK(mode!='percent' OR (regular_rate<=10000 AND requested_rate<=10000))
);
