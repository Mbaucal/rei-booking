PRAGMA foreign_keys = ON;

CREATE TABLE therapists (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 70),
 full_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 weekly_json TEXT NOT NULL CHECK(json_valid(weekly_json) AND json_array_length(weekly_json)=7),
 time_off_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(time_off_json)),
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','reception','therapist')),
 therapist_id TEXT REFERENCES therapists(id), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, CHECK(role!='therapist' OR therapist_id IS NOT NULL)
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_limits (
 key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
);
CREATE TABLE clients (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 phone TEXT NOT NULL DEFAULT '', phone_key TEXT UNIQUE, email TEXT NOT NULL DEFAULT '', email_key TEXT UNIQUE,
 note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 2));
INSERT INTO rooms VALUES('r1','Room 1',2),('r2','Room 2',2),('r3','Room 3',1);
CREATE TABLE services (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, duration INTEGER NOT NULL CHECK(duration BETWEEN 5 AND 720 AND duration%5=0),
 price_cents INTEGER NOT NULL CHECK(price_cents>=0 AND price_cents<=100000000),
 color TEXT NOT NULL DEFAULT '#2e87a0', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE appointments (
 id TEXT PRIMARY KEY, client_id TEXT REFERENCES clients(id), therapist_id TEXT NOT NULL REFERENCES therapists(id),
 service_id TEXT NOT NULL REFERENCES services(id), service_name TEXT NOT NULL,
 date TEXT NOT NULL, start_minute INTEGER NOT NULL CHECK(start_minute>=600 AND start_minute<1320 AND start_minute%5=0),
 duration INTEGER NOT NULL CHECK(duration BETWEEN 5 AND 720 AND duration%5=0 AND start_minute+duration<=1320),
 room_id TEXT NOT NULL REFERENCES rooms(id), bed INTEGER NOT NULL CHECK(bed BETWEEN 0 AND 1),
 status TEXT NOT NULL CHECK(status IN ('booked','confirmed','done','cancelled','no_show')),
 requested_therapist_id TEXT REFERENCES therapists(id), note TEXT NOT NULL DEFAULT '',
 gross_cents INTEGER NOT NULL CHECK(gross_cents>=0), net_cents INTEGER NOT NULL CHECK(net_cents>=0 AND net_cents<=gross_cents),
 bonus_regular_cents_hour INTEGER NOT NULL DEFAULT 10000, bonus_requested_cents_hour INTEGER NOT NULL DEFAULT 50000,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 cancelled_at TEXT, updated_by TEXT NOT NULL REFERENCES users(id), mutation_id TEXT NOT NULL
);
CREATE INDEX appointments_date ON appointments(date);
CREATE INDEX appointments_client ON appointments(client_id,date);
CREATE TABLE booking_slots (
 appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
 therapist_id TEXT NOT NULL, date TEXT NOT NULL, minute INTEGER NOT NULL,
 room_id TEXT NOT NULL, bed INTEGER NOT NULL,
 PRIMARY KEY(appointment_id,minute), UNIQUE(therapist_id,date,minute), UNIQUE(room_id,bed,date,minute)
);
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL,
 entity TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
);

CREATE TRIGGER appointment_validate_insert BEFORE INSERT ON appointments BEGIN
 SELECT RAISE(ABORT,'room_capacity') WHERE NEW.bed >= (SELECT capacity FROM rooms WHERE id=NEW.room_id);
 SELECT RAISE(ABORT,'therapist_unavailable') WHERE NEW.status NOT IN ('cancelled','no_show') AND EXISTS (
  SELECT 1 FROM therapists t WHERE t.id=NEW.therapist_id AND (
   t.active=0 OR json_extract(t.weekly_json,'$['||strftime('%w',NEW.date)||'].enabled')!=1
   OR NEW.start_minute<json_extract(t.weekly_json,'$['||strftime('%w',NEW.date)||'].start')
   OR NEW.start_minute+NEW.duration>json_extract(t.weekly_json,'$['||strftime('%w',NEW.date)||'].end')
   OR EXISTS(SELECT 1 FROM json_each(t.time_off_json) WHERE value=NEW.date)
  )
 );
END;
CREATE TRIGGER appointment_validate_update BEFORE UPDATE ON appointments BEGIN
 SELECT RAISE(ABORT,'room_capacity') WHERE NEW.bed >= (SELECT capacity FROM rooms WHERE id=NEW.room_id);
 SELECT RAISE(ABORT,'created_at_immutable') WHERE NEW.created_at!=OLD.created_at;
 SELECT RAISE(ABORT,'therapist_unavailable') WHERE NEW.status NOT IN ('cancelled','no_show') AND EXISTS (
  SELECT 1 FROM therapists t WHERE t.id=NEW.therapist_id AND (
   t.active=0 OR json_extract(t.weekly_json,'$['||strftime('%w',NEW.date)||'].enabled')!=1
   OR NEW.start_minute<json_extract(t.weekly_json,'$['||strftime('%w',NEW.date)||'].start')
   OR NEW.start_minute+NEW.duration>json_extract(t.weekly_json,'$['||strftime('%w',NEW.date)||'].end')
   OR EXISTS(SELECT 1 FROM json_each(t.time_off_json) WHERE value=NEW.date)
  )
 );
END;
CREATE TRIGGER appointment_slots_insert AFTER INSERT ON appointments BEGIN
 INSERT INTO booking_slots
 WITH RECURSIVE minutes(m) AS (SELECT NEW.start_minute UNION ALL SELECT m+5 FROM minutes WHERE m+5<NEW.start_minute+NEW.duration)
 SELECT NEW.id,NEW.therapist_id,NEW.date,m,NEW.room_id,NEW.bed FROM minutes WHERE NEW.status NOT IN ('cancelled','no_show');
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at)
 VALUES(NEW.updated_by,'create','appointment',NEW.id,json_object('date',NEW.date,'start',NEW.start_minute,'duration',NEW.duration,'therapist',NEW.therapist_id,'room',NEW.room_id,'bed',NEW.bed,'client',NEW.client_id,'service',NEW.service_name,'status',NEW.status,'requested',NEW.requested_therapist_id,'gross',NEW.gross_cents,'net',NEW.net_cents,'version',NEW.version),NEW.updated_at);
END;
CREATE TRIGGER appointment_slots_update AFTER UPDATE ON appointments BEGIN
 DELETE FROM booking_slots WHERE appointment_id=OLD.id;
 INSERT INTO booking_slots
 WITH RECURSIVE minutes(m) AS (SELECT NEW.start_minute UNION ALL SELECT m+5 FROM minutes WHERE m+5<NEW.start_minute+NEW.duration)
 SELECT NEW.id,NEW.therapist_id,NEW.date,m,NEW.room_id,NEW.bed FROM minutes WHERE NEW.status NOT IN ('cancelled','no_show');
 INSERT INTO audit_log(actor_id,action,entity,entity_id,before_json,after_json,created_at)
 VALUES(NEW.updated_by,'update','appointment',NEW.id,
 json_object('date',OLD.date,'start',OLD.start_minute,'duration',OLD.duration,'therapist',OLD.therapist_id,'room',OLD.room_id,'bed',OLD.bed,'client',OLD.client_id,'service',OLD.service_name,'status',OLD.status,'requested',OLD.requested_therapist_id,'gross',OLD.gross_cents,'net',OLD.net_cents,'version',OLD.version),
 json_object('date',NEW.date,'start',NEW.start_minute,'duration',NEW.duration,'therapist',NEW.therapist_id,'room',NEW.room_id,'bed',NEW.bed,'client',NEW.client_id,'service',NEW.service_name,'status',NEW.status,'requested',NEW.requested_therapist_id,'gross',NEW.gross_cents,'net',NEW.net_cents,'version',NEW.version),NEW.updated_at);
END;
CREATE TRIGGER therapist_availability_update BEFORE UPDATE ON therapists BEGIN
 SELECT RAISE(ABORT,'existing_appointments') WHERE EXISTS (
  SELECT 1 FROM appointments a WHERE a.therapist_id=NEW.id AND a.status IN ('booked','confirmed') AND a.date>=date('now','-1 day') AND (
   NEW.active=0 OR json_extract(NEW.weekly_json,'$['||strftime('%w',a.date)||'].enabled')!=1
   OR a.start_minute<json_extract(NEW.weekly_json,'$['||strftime('%w',a.date)||'].start')
   OR a.start_minute+a.duration>json_extract(NEW.weekly_json,'$['||strftime('%w',a.date)||'].end')
   OR EXISTS(SELECT 1 FROM json_each(NEW.time_off_json) WHERE value=a.date)
  )
 );
END;
