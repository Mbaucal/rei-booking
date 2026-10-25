import { digest, fail } from "./security.mjs";
import { isoDate } from "./domain.mjs";
import {
  historySalonLabelKey,
  readHistorySalonContext,
} from "./history-salon.mjs";
import { historicalReportStatus } from "./history-reports.mjs";

export const CALENDAR_HISTORY_LIMIT = 5000;
const stmt = (db, query, ...args) => db.prepare(query).bind(...args);
const key = (kind, source, label, duration) =>
  JSON.stringify([kind, source, historySalonLabelKey(label), duration]);
const syntheticId = (kind, source, label, duration) =>
  `history:${kind}:${digest(key(kind, source, label, duration))}`;
const sourceLabel = (value, fallback) =>
  typeof value === "string" && value.trim() ? value : fallback;

// Calendar history is a read-only projection of accepted source evidence. It
// never creates live bookings, reserves resources or changes report eligibility.
// Explicit catalogue mappings identify a resource; similar names do not.
export async function loadCalendarHistory(db, { from, to = from }, role) {
  if (!["owner", "reception", "therapist"].includes(role))
    fail(403, "You do not have access to the calendar.");
  from = isoDate(from);
  to = isoDate(to);
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 30)
    fail(400, "Choose a range of up to 31 days.");
  const operator = role === "owner" || role === "reception";
  const context = await readHistorySalonContext(db);
  // Even the SQL projection omits client identity for therapist requests. Raw
  // source rows, contact details, private notes and financial fields stay out of
  // every calendar-history response.
  const [selected, therapists, services, revisionRows] = await db.batch([
    stmt(
      db,
      `SELECT h.id,h.source,h.date,h.start_minute,h.duration,h.source_status,h.completion_state,
        json_extract(h.record_json,'$.sourceTherapistLabel') AS therapist_label,
        json_extract(h.record_json,'$.sourceServiceLabel') AS service_label,
        json_extract(h.record_json,'$.sourceRoomLabel') AS room_label,
        json_extract(h.record_json,'$.requestState') AS request_state
        ${operator ? ",h.client_id,c.name AS client_name,json_extract(h.record_json,'$.sourceClientLabel') AS client_label" : ""}
       FROM history_archive_effective h
       ${operator ? "LEFT JOIN clients c ON c.id=h.client_id" : ""}
       WHERE h.date BETWEEN ? AND ?
       ORDER BY h.date,h.start_minute,h.id LIMIT ${CALENDAR_HISTORY_LIMIT + 1}`,
      from,
      to,
    ),
    stmt(
      db,
      "SELECT id,name FROM therapists WHERE id IN(SELECT entity_id FROM history_catalogue_links WHERE kind='therapist')",
    ),
    stmt(
      db,
      "SELECT id,color FROM services WHERE id IN(SELECT entity_id FROM history_catalogue_links WHERE kind='service')",
    ),
    stmt(
      db,
      "SELECT (SELECT revision FROM history_archive_state WHERE id=1) AS archiveRevision,(SELECT revision FROM history_salon_state WHERE id=1) AS catalogueRevision",
    ),
  ]);
  const revision = revisionRows.results[0];
  if (
    revision.archiveRevision !== context.archiveRevision ||
    revision.catalogueRevision !== context.catalogueRevision
  )
    fail(409, "Imported history changed. Refresh the calendar.");
  if (selected.results.length > CALENDAR_HISTORY_LIMIT)
    fail(
      422,
      "This calendar period contains more than 5,000 imported records. Choose a shorter period; no records were omitted.",
    );
  const links = new Map(
    context.links.map((link) => [
      JSON.stringify([link.kind, link.source, link.labelKey, link.duration]),
      link.entityId,
    ]),
  );
  const mappedTherapists = new Map(therapists.results.map((t) => [t.id, t]));
  const mappedServices = new Map(services.results.map((s) => [s.id, s]));
  const resources = new Map();
  const appointments = selected.results.map((row) => {
    const therapistId =
      links.get(key("therapist", row.source, row.therapist_label, 0)) ||
      syntheticId("therapist", row.source, row.therapist_label, 0);
    const serviceId =
      links.get(key("service", row.source, row.service_label, row.duration)) ||
      syntheticId("service", row.source, row.service_label, row.duration);
    const therapistName = sourceLabel(
      row.therapist_label,
      "Unknown source therapist",
    );
    if (!resources.has(therapistId))
      resources.set(therapistId, {
        id: therapistId,
        name: mappedTherapists.get(therapistId)?.name || therapistName,
        kind: "therapist",
        historyOnly: true,
        active: false,
      });
    const color = mappedServices.get(serviceId)?.color;
    return {
      id: `history:${row.id}`,
      imported: true,
      readOnly: true,
      source: row.source,
      date: row.date,
      start: row.start_minute,
      duration: row.duration,
      status: historicalReportStatus(row.source_status, row.completion_state),
      sourceStatus: row.source_status,
      therapistId,
      therapistName,
      serviceId,
      serviceName: sourceLabel(row.service_label, "Unknown source treatment"),
      // A source room label is evidence, not a reviewed current room/table ID.
      roomId: null,
      bed: null,
      roomName: sourceLabel(row.room_label, null),
      requestState: ["yes", "no"].includes(row.request_state)
        ? row.request_state
        : "unknown",
      color: /^#[a-f\d]{6}$/i.test(color || "") ? color : "#a8863d",
      ...(operator
        ? {
            clientId: row.client_id,
            clientName: sourceLabel(
              row.client_name,
              sourceLabel(row.client_label, "Client name unavailable"),
            ),
          }
        : {}),
    };
  });
  // Preserve different source records even when a live appointment overlaps.
  // A shared client/time alone is not enough evidence to discard a visit.
  return {
    appointments,
    therapists: [...resources.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    metadata: {
      from,
      to,
      loadedRows: appointments.length,
      roomlessRows: appointments.length,
      ...revision,
    },
  };
}
