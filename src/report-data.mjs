import { fail } from "./security.mjs";
import { ensureReportSchema } from "./report-schema.mjs";
import { loadHistoricalReportRows } from "./history-reports.mjs";
import { buildReport, comparison } from "./reports.mjs";

const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);

// Shared by the signed-in report/CSV and the narrowly scoped integration API.
// Historical and native projections must retain the same revision watermark.
export async function loadPerformanceReport(db, options) {
  await ensureReportSchema(db);
  const historical = await loadHistoricalReportRows(db, {
    from: options.compare ? options.previousFrom : options.from,
    to: options.to,
  });
  const inputs = await db.batch([
    stmt(
      db,
      `SELECT a.*,t.name AS therapist_name,rt.name AS requested_name,b.mode AS bonus_mode,b.regular_rate,b.requested_rate
FROM appointments a JOIN therapists t ON t.id=a.therapist_id LEFT JOIN therapists rt ON rt.id=a.requested_therapist_id LEFT JOIN appointment_bonus_rules b ON b.appointment_id=a.id
WHERE a.date BETWEEN ? AND ? ORDER BY a.date,a.start_minute,a.id LIMIT 20001`,
      options.compare ? options.previousFrom : options.from,
      options.to,
    ),
    stmt(db, "SELECT id,name FROM therapists ORDER BY name"),
    stmt(db, "SELECT id,name,duration FROM services ORDER BY name,duration"),
    stmt(
      db,
      "SELECT (SELECT revision FROM history_archive_state WHERE id=1) AS archiveRevision,(SELECT revision FROM history_salon_state WHERE id=1) AS catalogueRevision,COALESCE(MAX(id),0) AS nativeAuditId,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS generatedAt FROM audit_log",
    ),
  ]);
  const clocks = inputs[3].results[0];
  if (
    ["archiveRevision", "catalogueRevision", "nativeAuditId"].some(
      (key) => clocks[key] !== historical.metadata[key],
    )
  )
    fail(
      409,
      "Report data changed while it was being prepared. Run the report again.",
    );
  if (inputs[0].results.length > 20000)
    fail(
      400,
      "Choose a shorter report period (maximum 20,000 Rei appointments).",
    );
  const rows = [...inputs[0].results, ...historical.rows];
  const mergeById = (items) => [
    ...new Map(items.map((v) => [v.id, v])).values(),
  ];
  const therapists = mergeById([
    ...historical.therapists,
    ...inputs[1].results,
  ]);
  const services = mergeById([...historical.services, ...inputs[2].results]);
  const report = buildReport(rows, options, therapists);
  const {
    archiveRevision,
    catalogueRevision,
    nativeAuditId,
    ...historySummary
  } = historical.metadata;
  report.history = historySummary;
  report.filters = { therapists, services };
  const previous = options.compare
    ? buildReport(
        rows,
        { ...options, from: options.previousFrom, to: options.previousTo },
        therapists,
      ).totals
    : null;
  return {
    report: {
      ...report,
      previous,
      comparison: previous ? comparison(report.totals, previous) : null,
    },
    watermark: clocks,
    loadedNative: inputs[0].results.length,
    loadedHistory: historical.rows.length,
  };
}
