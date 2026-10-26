import { randomUUID } from "node:crypto";
import { text } from "./domain.mjs";
import { fail, digest, token, readJSON, requireRole } from "./security.mjs";
import { ensureReportAccessSchema } from "./report-access-schema.mjs";
import { reportOptions } from "./reports.mjs";
import { loadPerformanceReport } from "./report-data.mjs";

const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const at = () => new Date().toISOString();
const TOKEN_SELECT = `SELECT k.*,u.active AS owner_active,u.role AS owner_role,u.must_change_password AS owner_must_change,v.version AS current_owner_version FROM report_api_tokens k JOIN users u ON u.id=k.owner_id JOIN account_access_versions v ON v.user_id=u.id`;
const ACTOR = `EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.role='owner' AND u.active=1 AND u.must_change_password=0 AND s.token_hash=? AND s.expires_at>? AND NOT EXISTS(SELECT 1 FROM account_previews p WHERE p.session_token_hash=s.token_hash))`;
const actorArgs = (user) => [user.id, user.token_hash, Date.now()];
const VALID_OWNER = `EXISTS(SELECT 1 FROM users u JOIN account_access_versions v ON v.user_id=u.id WHERE u.id=report_api_tokens.owner_id AND u.role='owner' AND u.active=1 AND u.must_change_password=0 AND v.version=report_api_tokens.owner_version)`;

function credential(row, now = at()) {
  return {
    id: row.id,
    name: row.name,
    scope: "reports:read",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expiryDays: row.expiry_days,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    active:
      !row.revoked_at &&
      (!row.expires_at || row.expires_at > now) &&
      !!row.owner_active &&
      row.owner_role === "owner" &&
      !row.owner_must_change &&
      row.owner_version === row.current_owner_version,
  };
}
function expiryDays(body, fallback = 90) {
  const days = body.expiresInDays === undefined ? fallback : body.expiresInDays;
  if (days !== null && ![30, 90, 365].includes(days))
    fail(400, "Choose 30, 90 or 365 days, or no expiry.");
  return days;
}
function rejectFields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    fail(400, "Unknown access setting.");
}
async function issue(db, user, body, previous = null) {
  rejectFields(body, previous ? ["expiresInDays"] : ["name", "expiresInDays"]);
  const name = previous ? previous.name : text(body.name, 80, "access name"),
    days = expiryDays(body, previous ? previous.expiry_days : 90),
    id = randomUUID(),
    raw = "rei_rpt_" + token(),
    hash = digest(raw),
    created = at(),
    expiry =
      days === null
        ? null
        : new Date(Date.now() + days * 86400000).toISOString(),
    marker = token();
  const queries = [];
  if (previous)
    queries.push(
      stmt(
        db,
        `UPDATE report_api_tokens SET revoked_at=?,revocation_token=? WHERE id=? AND owner_id=? AND revoked_at IS NULL AND ${VALID_OWNER} AND (expires_at IS NULL OR expires_at>?) AND ${ACTOR}`,
        created,
        marker,
        previous.id,
        user.id,
        created,
        ...actorArgs(user),
      ),
    );
  queries.push(
    stmt(
      db,
      `INSERT INTO report_api_tokens(id,owner_id,owner_version,token_hash,name,scope,created_at,expires_at,expiry_days)
 SELECT ?,u.id,v.version,?,?,'reports:read',?,?,? FROM users u JOIN account_access_versions v ON v.user_id=u.id
 WHERE u.id=? AND ${ACTOR}
 AND (SELECT COUNT(*) FROM report_api_tokens k WHERE k.owner_id=u.id AND k.owner_version=v.version AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?))<20
 ${previous ? "AND EXISTS(SELECT 1 FROM report_api_tokens WHERE id=? AND revocation_token=?)" : ""}`,
      id,
      hash,
      name,
      created,
      expiry,
      days,
      user.id,
      ...actorArgs(user),
      created,
      ...(previous ? [previous.id, marker] : []),
    ),
  );
  queries.push(
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,?,'report_api_token',id,?,? FROM report_api_tokens WHERE id=?`,
      user.id,
      previous ? "rotate_report_access" : "create_report_access",
      JSON.stringify({
        name,
        scope: "reports:read",
        expiresAt: expiry,
        ...(previous ? { replacedId: previous.id } : {}),
      }),
      created,
      id,
    ),
  );
  const results = await db.batch(queries);
  if (!results[previous ? 1 : 0].meta.changes)
    fail(
      409,
      "Access changed or the 20 active credential limit was reached. Reload and try again.",
    );
  return Response.json(
    {
      token: raw,
      credential: credential(await one(db, `${TOKEN_SELECT} WHERE k.id=?`, id)),
    },
    { status: 201 },
  );
}

export async function reportAccessRoutes(request, env, user) {
  const path = new URL(request.url).pathname,
    base = "/api/report-access/tokens",
    item = path.match(/^\/api\/report-access\/tokens\/([^/]+)(\/rotate)?$/);
  if (path !== base && !item) return null;
  requireRole(user, "owner");
  await ensureReportAccessSchema(env.DB);
  const db = env.DB;
  if (path === base && request.method === "GET") {
    const rows = (
      await stmt(
        db,
        `${TOKEN_SELECT} WHERE k.owner_id=? ORDER BY k.created_at DESC,k.id`,
        user.id,
      ).all()
    ).results;
    return Response.json({
      tokens: rows.map((row) => credential(row)),
      apiBase: env.APP_ORIGIN + "/api",
      scriptPath: "/rei-reports-sync.gs",
      schemaVersion: "1",
    });
  }
  if (path === base && request.method === "POST")
    return issue(db, user, await readJSON(request, 4096));
  if (item) {
    const row = await one(
      db,
      `${TOKEN_SELECT} WHERE k.id=? AND k.owner_id=?`,
      item[1],
      user.id,
    );
    if (!row) fail(404, "Report access not found.");
    if (item[2] && request.method === "POST") {
      if (!credential(row).active)
        fail(409, "This access is no longer active. Create a new credential.");
      return issue(db, user, await readJSON(request, 4096), row);
    }
    if (!item[2] && request.method === "DELETE") {
      const stamp = at(),
        marker = token();
      await db.batch([
        stmt(
          db,
          `UPDATE report_api_tokens SET revoked_at=?,revocation_token=? WHERE id=? AND owner_id=? AND revoked_at IS NULL AND ${ACTOR}`,
          stamp,
          marker,
          row.id,
          user.id,
          ...actorArgs(user),
        ),
        stmt(
          db,
          `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'revoke_report_access','report_api_token',id,?,? FROM report_api_tokens WHERE id=? AND revocation_token=?`,
          user.id,
          JSON.stringify({ scope: "reports:read" }),
          stamp,
          row.id,
          marker,
        ),
      ]);
      const fresh = await one(
        db,
        `${TOKEN_SELECT} WHERE k.id=? AND k.owner_id=?`,
        row.id,
        user.id,
      );
      if (!fresh?.revoked_at)
        fail(409, "Account access changed. Sign in again.");
      return Response.json({ ok: true });
    }
  }
  fail(405, "This report access action is not available.");
}

async function limit(db, key, maximum) {
  const time = Date.now(),
    start = time - 60000;
  const row = await one(
    db,
    `INSERT INTO report_api_limits(key,window_start,attempts) VALUES(?,?,1)
 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING attempts`,
    key,
    time,
    start,
    start,
  );
  if (row.attempts > maximum)
    fail(429, "Too many report requests. Try again in a minute.");
}

export function integrationOptions(params) {
  const names = [
    "from",
    "to",
    "group_by",
    "source",
    "therapist",
    "treatment",
    "status",
    "requested",
    "average_day_basis",
    "include_bonuses",
  ];
  for (const key of params.keys()) {
    if (
      !names.includes(key) ||
      params.getAll(key).length !== 1 ||
      !params.get(key)
    )
      fail(400, "Use supported report parameters exactly once.");
  }
  if (!params.get("from") || !params.get("to"))
    fail(400, "From and to dates are required.");
  const bonus = params.get("include_bonuses") || "false";
  if (!["true", "false"].includes(bonus))
    fail(400, "Set include_bonuses to true or false.");
  const translated = new URLSearchParams({
    preset: "custom",
    from: params.get("from"),
    to: params.get("to"),
  });
  for (const [from, to] of [
    ["group_by", "group"],
    ["source", "source"],
    ["therapist", "therapist"],
    ["treatment", "service"],
    ["status", "status"],
    ["requested", "requested"],
    ["average_day_basis", "dayBasis"],
  ])
    if (params.has(from)) translated.set(to, params.get(from));
  return {
    options: reportOptions(translated),
    includeBonuses: bonus === "true",
  };
}
function metrics(r, bonuses) {
  if (!r) return null;
  return {
    from: r.from,
    to: r.to,
    appointments: r.appointments,
    completed_massages: r.completed,
    cancelled: r.cancelled,
    no_show: r.noShow,
    pending: r.pending,
    requested_bookings: r.requestedCount,
    massage_minutes: r.totalMinutes,
    native_minutes: r.nativeMinutes,
    regular_minutes: r.regularMinutes,
    requested_minutes: r.requestedMinutes,
    revenue_cents: r.revenueCents,
    average_revenue_cents: r.averageRevenueCents,
    average_minutes_per_day: r.averageMinutesPerDay,
    day_count: r.dayCount,
    included_treatments: r.includedTreatments,
    historical_rows: r.historicalRows,
    historical_treatments: r.historicalTreatments,
    historical_visits: r.historicalVisits,
    historical_minutes: r.historicalMinutes,
    source_net_sales: r.sourceNetSales.map((s) => ({
      currency: s.currency,
      minor_unit_digits: s.minorUnitDigits,
      amount_minor: s.amountMinor,
      rows: s.rows,
    })),
    missing: {
      requested: r.unknownRequested,
      completion: r.unknownCompletion,
      status: r.unknownStatus,
      source_money: r.unavailableMoneyRows,
      full_price: r.unavailableFullPriceRows,
      bonus: r.unavailableBonusRows,
    },
    excluded_native_overlap: r.nativeOverlapRows,
    ...(bonuses
      ? {
          bonus_cents: r.totalBonusCents,
          regular_bonus_cents: r.regularBonusCents,
          requested_bonus_cents: r.requestedBonusCents,
        }
      : {}),
  };
}
export function integrationProjection(snapshot, options, includeBonuses) {
  const { report, watermark } = snapshot;
  const comparisonNames = {
    revenueCents: "revenue_cents",
    completed: "completed_massages",
    totalMinutes: "massage_minutes",
    totalBonusCents: "bonus_cents",
    includedTreatments: "included_treatments",
    historicalVisits: "historical_visits",
    historicalMinutes: "historical_minutes",
  };
  return {
    schema_version: "1",
    demo: false,
    currency: "RSD",
    timezone: "Europe/Belgrade",
    from: options.from,
    to: options.to,
    filters: {
      group_by: options.group,
      source: options.source,
      therapist: options.therapist,
      treatment: options.service,
      status: options.status,
      requested: options.requested,
      average_day_basis: options.dayBasis,
      include_bonuses: includeBonuses,
    },
    complete: true,
    next_cursor: null,
    generated_at: watermark.generatedAt,
    metric_basis: {
      completed_massages: "completed_rei_bookings",
      revenue_cents: "rei_treatment_revenue_after_discount",
      bonus_cents: "rei_completed_booking_bonus_only",
      massage_minutes: "included_native_and_imported_treatment_minutes",
      imported_money: "source_net_sales_by_currency_separate_from_rei_revenue",
      imported_attendance: "exclude_only_no_show_and_cancelled_known_statuses",
    },
    rows: report.groups.map((row) => ({
      key: row.key,
      dimensions: JSON.parse(row.key),
      label: row.label,
      ...metrics(row, includeBonuses),
    })),
    totals: metrics(report.totals, includeBonuses),
    previous: metrics(report.previous, includeBonuses),
    comparison: report.comparison
      ? Object.fromEntries(
          Object.entries(report.comparison)
            .filter(([key]) => includeBonuses || key !== "totalBonusCents")
            .map(([key, value]) => [comparisonNames[key], value]),
        )
      : null,
    coverage: {
      from: options.from,
      to: options.to,
      comparison_from: options.compare ? options.previousFrom : null,
      comparison_to: options.compare ? options.previousTo : null,
      source: options.source,
      snapshot_consistent: true,
      native_rows_loaded: snapshot.loadedNative,
      history_rows_loaded: snapshot.loadedHistory,
      history_archive_rows: report.history.totalRows,
      history_archive_from: report.history.minDate,
      history_archive_to: report.history.maxDate,
      historical_import_completeness: "not_verified",
      native_row_limit: 20000,
      historical_row_limit: 50000,
      archive_revision: watermark.archiveRevision,
      catalogue_revision: watermark.catalogueRevision,
      native_audit_id: watermark.nativeAuditId,
    },
  };
}

export async function performanceApi(request, env) {
  if (request.method !== "GET")
    fail(405, "Report integrations support GET only.");
  if (request.headers.has("cookie"))
    fail(401, "Use the reporting credential without a browser session.");
  if (
    request.headers.has("origin") &&
    request.headers.get("origin") !== env.APP_ORIGIN
  )
    fail(403, "Request origin is not allowed.");
  const db = env.DB;
  await ensureReportAccessSchema(db);
  await limit(
    db,
    "ip:" + digest(request.headers.get("cf-connecting-ip") || "unknown"),
    120,
  );
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer rei_rpt_[A-Za-z0-9_-]{43}$/.test(authorization))
    fail(401, "A valid reporting credential is required.");
  const hash = digest(authorization.slice(7));
  const row = await one(db, `${TOKEN_SELECT} WHERE k.token_hash=?`, hash);
  if (!row || !credential(row).active)
    fail(401, "A valid reporting credential is required.");
  await limit(db, "token:" + row.id, 30);
  const { options, includeBonuses } = integrationOptions(
    new URL(request.url).searchParams,
  );
  const snapshot = await loadPerformanceReport(db, options);
  // Recheck revocation and the issuing owner's current access after loading data.
  const result = await stmt(
    db,
    `UPDATE report_api_tokens SET last_used_at=? WHERE id=? AND token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND ${VALID_OWNER}`,
    at(),
    row.id,
    hash,
    at(),
  ).run();
  if (!result.meta.changes)
    fail(401, "A valid reporting credential is required.");
  await stmt(
    db,
    "DELETE FROM report_api_limits WHERE window_start<?",
    Date.now() - 3600000,
  ).run();
  return Response.json(
    integrationProjection(snapshot, options, includeBonuses),
  );
}
