import { randomUUID } from "node:crypto";
import { text, integer, isoDate } from "./domain.mjs";
import { fail, readJSON, requireRole } from "./security.mjs";

const stale = "This block changed. Refresh the calendar before saving again.";
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);

export function calendarBlockRange(params) {
  const from = isoDate(params.get("from")),
    to = isoDate(params.get("to") || from);
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 30)
    fail(400, "Choose a range of up to 31 days.");
  return { from, to };
}

export function projectCalendarBlock(row, role) {
  const metadata = {
    id: row.id,
    date: row.date,
    start: row.start_minute,
    duration: row.duration,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    bed: row.bed,
    blocksAvailability: !!row.blocks_availability,
  };
  if (role === "therapist") return metadata;
  return {
    ...metadata,
    title: row.title,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCalendarBlocks(db, role, from, to) {
  const { results } = await statement(
    db,
    "SELECT * FROM calendar_blocks WHERE deleted_at IS NULL AND date BETWEEN ? AND ? ORDER BY date,start_minute,id",
    from,
    to,
  ).all();
  return results.map((row) => projectCalendarBlock(row, role));
}

function blockInput(body) {
  const date = isoDate(body.date),
    start = integer(body.start, 0, 1435, "start time"),
    duration = integer(body.duration, 5, 1440, "duration");
  if (start % 5 || duration % 5 || start + duration > 1440)
    fail(400, "Use 5-minute steps within a single day, ending by 24:00.");
  if (!["therapist", "room"].includes(body.resourceType))
    fail(400, "Choose a therapist or room.");
  const bed = body.bed === null ? null : integer(body.bed, 0, 1, "table");
  if (body.resourceType === "therapist" && bed !== null)
    fail(400, "A therapist block cannot specify a table.");
  if (typeof body.blocksAvailability !== "boolean")
    fail(400, "Choose whether this entry blocks availability.");
  return {
    date,
    start_minute: start,
    duration,
    resource_type: body.resourceType,
    resource_id: text(body.resourceId, 100, "resource"),
    bed,
    title: text(body.title, 120, "title"),
    note: text(body.note === undefined ? "" : body.note, 2000, "note", true),
    blocks_availability: body.blocksAvailability ? 1 : 0,
  };
}

export async function calendarBlockRoutes(request, db, user) {
  const url = new URL(request.url),
    method = request.method,
    match = url.pathname.match(/^\/api\/calendar-blocks(?:\/([^/]+))?$/);
  if (!match) return null;
  const id = match[1];
  if (!id && method === "GET") {
    const { from, to } = calendarBlockRange(url.searchParams);
    return Response.json({
      blocks: await listCalendarBlocks(db, user.role, from, to),
    });
  }
  requireRole(user, "owner", "reception");
  if ((!id && method !== "POST") || (id && !["PUT", "DELETE"].includes(method)))
    fail(405, "This action is not available for calendar blocks.");
  const body = await readJSON(request, 16384),
    time = new Date().toISOString();
  if (id) {
    integer(body.version, 1, 100000000, "record version");
    const old = await statement(
      db,
      "SELECT version,deleted_at FROM calendar_blocks WHERE id=?",
      id,
    ).first();
    if (!old) fail(404, "Calendar block not found.");
    if (old.deleted_at || old.version !== body.version) fail(409, stale);
  }
  if (method === "DELETE") {
    const row = await statement(
      db,
      "UPDATE calendar_blocks SET deleted_at=?,updated_at=?,updated_by=?,version=version+1 WHERE id=? AND version=? AND deleted_at IS NULL RETURNING id",
      time,
      time,
      user.id,
      id,
      body.version,
    ).first();
    if (!row) fail(409, stale);
    return Response.json({ ok: true });
  }
  const values = blockInput(body),
    keys = Object.keys(values);
  const row = id
    ? await statement(
        db,
        `UPDATE calendar_blocks SET ${keys.map((k) => k + "=?").join(",")},updated_at=?,updated_by=?,version=version+1 WHERE id=? AND version=? AND deleted_at IS NULL RETURNING *`,
        ...Object.values(values),
        time,
        user.id,
        id,
        body.version,
      ).first()
    : await statement(
        db,
        `INSERT INTO calendar_blocks(id,${keys.join(",")},created_at,updated_at,updated_by) VALUES(${Array(
          keys.length + 4,
        )
          .fill("?")
          .join(",")}) RETURNING *`,
        randomUUID(),
        ...Object.values(values),
        time,
        time,
        user.id,
      ).first();
  if (!row) fail(409, stale);
  return Response.json(
    { block: projectCalendarBlock(row, user.role) },
    { status: id ? 200 : 201 },
  );
}
