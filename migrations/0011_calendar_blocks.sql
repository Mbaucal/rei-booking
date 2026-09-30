CREATE TABLE IF NOT EXISTS calendar_blocks (
 id TEXT PRIMARY KEY,
 date TEXT NOT NULL,
 start_minute INTEGER NOT NULL CHECK(typeof(start_minute)='integer' AND start_minute>=0 AND start_minute<1440 AND start_minute%5=0),
 duration INTEGER NOT NULL CHECK(typeof(duration)='integer' AND duration>=5 AND duration%5=0 AND start_minute+duration<=1440),
 resource_type TEXT NOT NULL CHECK(resource_type IN ('therapist','room')),
 resource_id TEXT NOT NULL,
 bed INTEGER CHECK(bed IS NULL OR (typeof(bed)='integer' AND bed BETWEEN 0 AND 1)),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=2000),
 blocks_availability INTEGER NOT NULL CHECK(blocks_availability IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version>0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id),
 deleted_at TEXT,
 CHECK(resource_type!='therapist' OR bed IS NULL)
);

CREATE INDEX IF NOT EXISTS calendar_blocks_active_resource ON calendar_blocks(date,resource_type,resource_id,start_minute) WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS calendar_block_validate_insert BEFORE INSERT ON calendar_blocks WHEN NEW.deleted_at IS NULL BEGIN
 SELECT RAISE(ABORT,'calendar_block_resource') WHERE (NEW.resource_type='therapist' AND NOT EXISTS(SELECT 1 FROM therapists WHERE id=NEW.resource_id)) OR (NEW.resource_type='room' AND NOT EXISTS(SELECT 1 FROM rooms WHERE id=NEW.resource_id));
 SELECT RAISE(ABORT,'room_capacity') WHERE NEW.resource_type='room' AND NEW.bed IS NOT NULL AND NEW.bed>=(SELECT capacity FROM rooms WHERE id=NEW.resource_id);
 SELECT RAISE(ABORT,'calendar_block_conflict') WHERE NEW.blocks_availability=1 AND EXISTS(SELECT 1 FROM appointments a WHERE a.date=NEW.date AND a.status NOT IN ('cancelled','no_show') AND a.start_minute<NEW.start_minute+NEW.duration AND a.start_minute+a.duration>NEW.start_minute AND ((NEW.resource_type='therapist' AND NEW.resource_id=a.therapist_id) OR (NEW.resource_type='room' AND NEW.resource_id=a.room_id AND (NEW.bed IS NULL OR NEW.bed=a.bed))));
 SELECT RAISE(ABORT,'calendar_block_conflict') WHERE NEW.blocks_availability=1 AND EXISTS(SELECT 1 FROM calendar_blocks b WHERE b.id!=NEW.id AND b.deleted_at IS NULL AND b.blocks_availability=1 AND b.date=NEW.date AND b.start_minute<NEW.start_minute+NEW.duration AND b.start_minute+b.duration>NEW.start_minute AND b.resource_type=NEW.resource_type AND b.resource_id=NEW.resource_id AND (NEW.resource_type='therapist' OR b.bed IS NULL OR NEW.bed IS NULL OR b.bed=NEW.bed));
END;

CREATE TRIGGER IF NOT EXISTS calendar_block_validate_update BEFORE UPDATE ON calendar_blocks WHEN NEW.deleted_at IS NULL BEGIN
 SELECT RAISE(ABORT,'calendar_block_resource') WHERE (NEW.resource_type='therapist' AND NOT EXISTS(SELECT 1 FROM therapists WHERE id=NEW.resource_id)) OR (NEW.resource_type='room' AND NOT EXISTS(SELECT 1 FROM rooms WHERE id=NEW.resource_id));
 SELECT RAISE(ABORT,'room_capacity') WHERE NEW.resource_type='room' AND NEW.bed IS NOT NULL AND NEW.bed>=(SELECT capacity FROM rooms WHERE id=NEW.resource_id);
 SELECT RAISE(ABORT,'calendar_block_conflict') WHERE NEW.blocks_availability=1 AND EXISTS(SELECT 1 FROM appointments a WHERE a.date=NEW.date AND a.status NOT IN ('cancelled','no_show') AND a.start_minute<NEW.start_minute+NEW.duration AND a.start_minute+a.duration>NEW.start_minute AND ((NEW.resource_type='therapist' AND NEW.resource_id=a.therapist_id) OR (NEW.resource_type='room' AND NEW.resource_id=a.room_id AND (NEW.bed IS NULL OR NEW.bed=a.bed))));
 SELECT RAISE(ABORT,'calendar_block_conflict') WHERE NEW.blocks_availability=1 AND EXISTS(SELECT 1 FROM calendar_blocks b WHERE b.id!=NEW.id AND b.deleted_at IS NULL AND b.blocks_availability=1 AND b.date=NEW.date AND b.start_minute<NEW.start_minute+NEW.duration AND b.start_minute+b.duration>NEW.start_minute AND b.resource_type=NEW.resource_type AND b.resource_id=NEW.resource_id AND (NEW.resource_type='therapist' OR b.bed IS NULL OR NEW.bed IS NULL OR b.bed=NEW.bed));
END;

CREATE TRIGGER IF NOT EXISTS calendar_block_immutable BEFORE UPDATE ON calendar_blocks BEGIN
 SELECT RAISE(ABORT,'calendar_block_deleted') WHERE OLD.deleted_at IS NOT NULL;
 SELECT RAISE(ABORT,'calendar_block_immutable') WHERE NEW.id!=OLD.id OR NEW.created_at!=OLD.created_at;
END;

CREATE TRIGGER IF NOT EXISTS appointment_calendar_block_insert BEFORE INSERT ON appointments WHEN NEW.status NOT IN ('cancelled','no_show') BEGIN
 SELECT RAISE(ABORT,'calendar_block_conflict') WHERE EXISTS(SELECT 1 FROM calendar_blocks b WHERE b.deleted_at IS NULL AND b.blocks_availability=1 AND b.date=NEW.date AND b.start_minute<NEW.start_minute+NEW.duration AND b.start_minute+b.duration>NEW.start_minute AND ((b.resource_type='therapist' AND b.resource_id=NEW.therapist_id) OR (b.resource_type='room' AND b.resource_id=NEW.room_id AND (b.bed IS NULL OR b.bed=NEW.bed))));
END;

CREATE TRIGGER IF NOT EXISTS appointment_calendar_block_update BEFORE UPDATE ON appointments WHEN NEW.status NOT IN ('cancelled','no_show') BEGIN
 SELECT RAISE(ABORT,'calendar_block_conflict') WHERE EXISTS(SELECT 1 FROM calendar_blocks b WHERE b.deleted_at IS NULL AND b.blocks_availability=1 AND b.date=NEW.date AND b.start_minute<NEW.start_minute+NEW.duration AND b.start_minute+b.duration>NEW.start_minute AND ((b.resource_type='therapist' AND b.resource_id=NEW.therapist_id) OR (b.resource_type='room' AND b.resource_id=NEW.room_id AND (b.bed IS NULL OR b.bed=NEW.bed))));
END;

CREATE TRIGGER IF NOT EXISTS calendar_block_audit_insert AFTER INSERT ON calendar_blocks BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(NEW.updated_by,'create','calendar_blocks',NEW.id,json_object('date',NEW.date,'start',NEW.start_minute,'duration',NEW.duration,'resourceType',NEW.resource_type,'resourceId',NEW.resource_id,'bed',NEW.bed,'title',NEW.title,'note',NEW.note,'blocksAvailability',NEW.blocks_availability,'version',NEW.version,'deletedAt',NEW.deleted_at),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS calendar_block_audit_update AFTER UPDATE ON calendar_blocks BEGIN
 INSERT INTO audit_log(actor_id,action,entity,entity_id,before_json,after_json,created_at) VALUES(NEW.updated_by,CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'update' END,'calendar_blocks',NEW.id,json_object('date',OLD.date,'start',OLD.start_minute,'duration',OLD.duration,'resourceType',OLD.resource_type,'resourceId',OLD.resource_id,'bed',OLD.bed,'title',OLD.title,'note',OLD.note,'blocksAvailability',OLD.blocks_availability,'version',OLD.version,'deletedAt',OLD.deleted_at),json_object('date',NEW.date,'start',NEW.start_minute,'duration',NEW.duration,'resourceType',NEW.resource_type,'resourceId',NEW.resource_id,'bed',NEW.bed,'title',NEW.title,'note',NEW.note,'blocksAvailability',NEW.blocks_availability,'version',NEW.version,'deletedAt',NEW.deleted_at),NEW.updated_at);
END;
