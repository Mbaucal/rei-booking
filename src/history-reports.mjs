import { fail } from "./security.mjs";
import { isoDate } from "./domain.mjs";
import {
  readHistorySalonContext,
  historySalonLabelKey,
  resolveHistoryNetSales,
} from "./history-salon.mjs";

const MAX_ROWS = 50000;
const foldedStatus = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
export function historicalVisitEligibility(status) {
  const key = foldedStatus(status);
  return String(status ?? "")
    .normalize("NFKC")
    .trim()
    ? !["noshow", "canceled", "cancelled"].includes(key)
    : null;
}
export function historicalReportStatus(status, completion) {
  const key = foldedStatus(status);
  if (["canceled", "cancelled"].includes(key)) return "cancelled";
  if (key === "noshow") return "no_show";
  if (completion === "completed") return "done";
  if (key === "new" || key === "booked") return "booked";
  if (key === "confirmed") return "confirmed";
  return "unknown";
}
async function syntheticId(kind, source, label, duration) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([kind, source, label, duration]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return (
    `history:${kind}:` +
    [...new Uint8Array(digest)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
  );
}
const keyOf = (kind, source, label, duration) =>
  JSON.stringify([kind, source, historySalonLabelKey(label || ""), duration]);
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);

// Reads a bounded report projection, never full raw source rows or client identity.
// The shared salon context initializes the archive schema on a fresh database.
export async function loadHistoricalReportRows(db, { from, to }) {
  from = isoDate(from);
  to = isoDate(to);
  if (from > to) fail(400, "Choose a valid historical report period.");
  const context = await readHistorySalonContext(db);
  const [range, selected, labels, revisions] = await db.batch([
    stmt(
      db,
      "SELECT COUNT(*) AS totalRows, MIN(date) AS minDate, MAX(date) AS maxDate FROM history_archive",
    ),
    stmt(
      db,
      `SELECT h.id,h.source,h.ref_hash,h.client_id,h.source_status,h.completion_state,h.date,h.start_minute,h.duration,
      json_extract(h.record_json,'$.sourceTherapistLabel') AS therapist_label,
      json_extract(h.record_json,'$.sourceServiceLabel') AS service_label,
      json_extract(h.record_json,'$.sourceRoomLabel') AS room_label,
      json_extract(h.record_json,'$.requestState') AS request_state,
      json_extract(h.record_json,'$.sourceNetSalesMinor') AS amount_minor,
      json_extract(h.record_json,'$.currency') AS currency,
      json_extract(h.record_json,'$.raw.netSales') AS raw_net_sales,
      json_extract(h.record_json,'$.interpretation.money') AS money_json,
      json_extract(h.record_json,'$.sourceTimeZone') AS source_time_zone,
      json_extract(h.record_json,'$.sourceCreatedAt') AS source_created_at,
      json_extract(h.record_json,'$.sourceCancelledAt') AS source_cancelled_at,
      (SELECT COUNT(*) FROM history_archive x WHERE x.source=h.source AND x.ref_hash=h.ref_hash) AS reference_lines,
      EXISTS(SELECT 1 FROM appointments a WHERE a.client_id=h.client_id AND a.date=h.date AND a.start_minute<h.start_minute+h.duration AND h.start_minute<a.start_minute+a.duration) AS native_overlap
      FROM history_archive h WHERE h.date>=? AND h.date<=? ORDER BY h.date,h.start_minute,h.id LIMIT 50001`,
      from,
      to,
    ),
    stmt(
      db,
      `SELECT source,json_extract(record_json,'$.sourceTherapistLabel') AS therapist_label,json_extract(record_json,'$.sourceServiceLabel') AS service_label,duration FROM history_archive GROUP BY source,therapist_label,service_label,duration LIMIT 50001`,
    ),
    stmt(
      db,
      "SELECT (SELECT revision FROM history_archive_state WHERE id=1) AS archiveRevision,(SELECT revision FROM history_salon_state WHERE id=1) AS catalogueRevision,(SELECT COALESCE(MAX(id),0) FROM audit_log) AS nativeAuditId",
    ),
  ]);
  const revision = revisions.results[0];
  if (
    context.archiveRevision !== revision.archiveRevision ||
    context.catalogueRevision !== revision.catalogueRevision
  )
    fail(
      409,
      "Historical report settings or records changed. Run the report again.",
    );
  if (selected.results.length > MAX_ROWS || labels.results.length > MAX_ROWS)
    fail(
      422,
      "This report contains too many historical records. Choose a shorter period or a more specific report.",
    );
  const links = new Map(
    context.links.map((l) => [
      JSON.stringify([l.kind, l.source, l.labelKey, l.duration]),
      l.entityId,
    ]),
  );
  const ids = new Map(),
    therapists = new Map(),
    services = new Map();
  for (const r of labels.results) {
    for (const [kind, label, duration, collection] of [
      ["therapist", r.therapist_label, 0, therapists],
      ["service", r.service_label, r.duration, services],
    ]) {
      const key = keyOf(kind, r.source, label, duration);
      if (!ids.has(key))
        ids.set(
          key,
          links.get(key) ||
            (await syntheticId(
              kind,
              r.source,
              historySalonLabelKey(label || ""),
              duration,
            )),
        );
      const id = ids.get(key);
      if (!collection.has(id))
        collection.set(id, {
          id,
          name:
            label ||
            (kind === "therapist"
              ? "Unknown source therapist"
              : "Unknown source treatment"),
          ...(kind === "service" ? { duration } : {}),
        });
    }
  }
  const metadata = {
    ...range.results[0],
    ...revision,
    loadedRows: selected.results.length,
    nativeOverlapRows: 0,
    ambiguousMoneyRows: 0,
  };
  const rows = selected.results.map((r) => {
    const record = {
      sourceNetSalesMinor: r.amount_minor,
      currency: r.currency,
      raw: { netSales: r.raw_net_sales },
      interpretation: { money: r.money_json ? JSON.parse(r.money_json) : null },
    };
    const resolved = resolveHistoryNetSales(record, context.settings);
    const minorUnitDigits = resolved.minorUnitDigits;
    const ambiguous = r.reference_lines > 1;
    const known =
      !ambiguous &&
      Number.isSafeInteger(resolved.amountMinor) &&
      resolved.currency &&
      Number.isInteger(minorUnitDigits) &&
      minorUnitDigits >= 0 &&
      minorUnitDigits <= 4;
    if (r.native_overlap) metadata.nativeOverlapRows++;
    if (ambiguous) metadata.ambiguousMoneyRows++;
    return {
      id: `history:${r.id}`,
      report_source: "history",
      source: r.source,
      visit_key: JSON.stringify([r.source, r.ref_hash]),
      therapist_id: ids.get(keyOf("therapist", r.source, r.therapist_label, 0)),
      therapist_name: r.therapist_label || "Unknown source therapist",
      service_id: ids.get(
        keyOf("service", r.source, r.service_label, r.duration),
      ),
      service_name: r.service_label || "Unknown source treatment",
      room_name: r.room_label,
      date: r.date,
      start_minute: r.start_minute,
      duration: r.duration,
      status: historicalReportStatus(r.source_status, r.completion_state),
      source_status: r.source_status,
      completion_state: r.completion_state,
      counts_as_visit: historicalVisitEligibility(r.source_status),
      request_state: ["yes", "no"].includes(r.request_state)
        ? r.request_state
        : "unknown",
      source_net_sales_minor: known ? resolved.amountMinor : null,
      currency: known ? resolved.currency : null,
      minor_unit_digits: known ? minorUnitDigits : null,
      money_basis: known ? resolved.basis : "unknown",
      money_issue: ambiguous
        ? "The source repeats this appointment across service lines; the net-sales allocation is unconfirmed."
        : known
          ? null
          : {
              currency_unconfirmed: "Source currency is unconfirmed.",
              missing_net_sales: "Source net sales are unavailable.",
              invalid_money_format: "The source amount format is unconfirmed.",
            }[resolved.issue] || "Source net sales or currency is unavailable.",
      source_time_zone: r.source_time_zone || context.settings.timeZone || null,
      source_created_at: r.source_created_at
        ? JSON.parse(r.source_created_at)
        : null,
      source_cancelled_at: r.source_cancelled_at
        ? JSON.parse(r.source_cancelled_at)
        : null,
      native_overlap: !!r.native_overlap,
    };
  });
  return {
    rows,
    metadata,
    therapists: [...therapists.values()],
    services: [...services.values()],
  };
}
