CREATE TABLE IF NOT EXISTS profile_photos (
 kind TEXT NOT NULL CHECK(kind IN ('clients','therapists')), entity_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 jpeg BLOB CHECK(jpeg IS NULL OR length(jpeg) BETWEEN 1 AND 153600),
 width INTEGER, height INTEGER, updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(kind,entity_id), CHECK(version=expected_version+1),
 CHECK((jpeg IS NULL AND width IS NULL AND height IS NULL) OR (jpeg IS NOT NULL AND width BETWEEN 1 AND 512 AND height BETWEEN 1 AND 512))
);

CREATE TRIGGER IF NOT EXISTS photo_insert_guard BEFORE INSERT ON profile_photos BEGIN
 SELECT RAISE(ABORT,'photo_conflict') WHERE COALESCE((SELECT version FROM profile_photos WHERE kind=NEW.kind AND entity_id=NEW.entity_id),0)!=NEW.expected_version;
 SELECT RAISE(ABORT,'photo_missing_profile') WHERE (NEW.kind='clients' AND NOT EXISTS(SELECT 1 FROM clients WHERE id=NEW.entity_id)) OR (NEW.kind='therapists' AND NOT EXISTS(SELECT 1 FROM therapists WHERE id=NEW.entity_id));
END;

CREATE TRIGGER IF NOT EXISTS photo_audit_insert AFTER INSERT ON profile_photos BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(NEW.updated_by,CASE WHEN NEW.jpeg IS NULL THEN 'remove_photo' ELSE 'save_photo' END,NEW.kind,NEW.entity_id,json_object('photoVersion',NEW.version,'width',NEW.width,'height',NEW.height),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS photo_audit_update AFTER UPDATE ON profile_photos BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(NEW.updated_by,CASE WHEN NEW.jpeg IS NULL THEN 'remove_photo' ELSE 'save_photo' END,NEW.kind,NEW.entity_id,json_object('photoVersion',NEW.version,'width',NEW.width,'height',NEW.height),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS photo_delete_clients AFTER DELETE ON clients BEGIN
 DELETE FROM profile_photos WHERE kind='clients' AND entity_id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS photo_delete_therapists AFTER DELETE ON therapists BEGIN
 DELETE FROM profile_photos WHERE kind='therapists' AND entity_id=OLD.id;
END;
