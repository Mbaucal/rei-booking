import { randomUUID } from "node:crypto";
import { fail, HttpError, requireRole, readJSON, digest } from "./security.mjs";
import { text, integer } from "./domain.mjs";
import { ensureReportSchema } from "./report-schema.mjs";
import { ensureSalesSchema } from "./sales-schema.mjs";
import { ensureMonthlySchema } from "./monthly-schema.mjs";
import { buildReport, comparison, reportCSV } from "./reports.mjs";
import {
  month,
  currentMonth,
  shiftMonth,
  monthOptions,
  dueAt,
  scheduleFilters,
  csv,
  comparisonCSV,
} from "./monthly-periods.mjs";
import {
  monthlyEmailReady,
  recipientAddress,
  reportMessage,
  requestRecipient,
  confirmRecipient,
  sendMonthlyJob,
  deliverMonthlyJobs,
  jobView,
} from "./monthly-email.mjs";
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const all = async (db, sql, ...args) =>
  (await stmt(db, sql, ...args).all()).results;
const DEFINITION = "appointment-performance-1";
const STALE = "This schedule or report changed. Refresh it before continuing.";
const SCHEDULE = `SELECT s.*,t.name,t.filters_json,t.minute,t.notifications,t.recipient FROM report_schedules s JOIN report_templates t ON t.schedule_id=s.id AND t.revision=s.revision`;
const SNAP_META = `SELECT p.id,p.schedule_id,p.template_revision,p.period,p.version,p.supersedes_id,p.reason,p.generated_at,p.cutoff_at,p.cutoff_audit_id,p.definition_version,p.incomplete,t.name,j.status AS email_status,j.error_code AS email_error,j.id AS job_id FROM report_snapshots p JOIN report_schedules s ON s.id=p.schedule_id JOIN report_templates t ON t.schedule_id=p.schedule_id AND t.revision=p.template_revision LEFT JOIN report_email_jobs j ON j.snapshot_id=p.id AND j.kind='report'`;
// Only report inputs. Never store client names, IDs, contacts, notes, portraits or session data.
const INPUT_SELECT = `SELECT a.id,a.therapist_id,t.name AS therapist_name,a.service_id,a.service_name,a.date,a.start_minute,a.duration,a.gross_cents,a.net_cents,a.created_at,a.cancelled_at,a.status,a.requested_therapist_id,rt.name AS requested_name,a.bonus_regular_cents_hour,a.bonus_requested_cents_hour,a.version,a.updated_at,b.mode AS bonus_mode,b.regular_rate,b.requested_rate FROM appointments a JOIN therapists t ON t.id=a.therapist_id LEFT JOIN therapists rt ON rt.id=a.requested_therapist_id LEFT JOIN appointment_bonus_rules b ON b.appointment_id=a.id WHERE a.date BETWEEN ? AND ? AND (?='' OR a.therapist_id=?) AND (?='' OR a.service_id=?) AND (?='all' OR a.status=?) AND (?='all' OR (a.requested_therapist_id IS NOT NULL)=?) ORDER BY a.date,a.start_minute,a.id LIMIT 5001`;
async function schema(db) {
  await ensureReportSchema(db);
  await ensureSalesSchema(db);
  await ensureMonthlySchema(db);
}
async function schedule(db, id, ownerId) {
  const row = await one(
    db,
    SCHEDULE + " WHERE s.id=? AND s.owner_id=?",
    id,
    ownerId,
  );
  if (!row) fail(404, "Monthly schedule not found.");
  return row;
}
async function template(db, id, period) {
  const row = await one(
    db,
    "SELECT * FROM report_templates WHERE schedule_id=? AND effective_month<=? ORDER BY revision DESC LIMIT 1",
    id,
    period,
  );
  if (!row)
    fail(400, "This month predates the schedule. Choose a later month.");
  return row;
}
async function scheduleView(db, row) {
  const next = await template(db, row.id, row.next_month);
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    paused: !!row.paused,
    filters: JSON.parse(row.filters_json),
    minute: row.minute,
    notifications: !!row.notifications,
    recipient: row.recipient,
    nextMonth: row.next_month,
    nextRunAt: new Date(dueAt(row.next_month, next.minute)).toISOString(),
    lastRunAt: row.last_run_at,
    error: row.last_error,
    createdAt: row.created_at,
  };
}
async function settingsInput(db, user, body, env) {
  const name = text(body.name, 80, "report name");
  if (/[\r\n\x00-\x1f]/.test(name))
    fail(400, "Enter a single-line report name.");
  const filters = scheduleFilters(body.filters),
    minute = integer(body.minute, 0, 1439, "notification time");
  if (minute % 15) fail(400, "Choose a time in 15-minute steps.");
  for (const [key, table] of [
    ["therapist", "therapists"],
    ["service", "services"],
  ])
    if (
      filters[key] &&
      !(await one(db, `SELECT id FROM ${table} WHERE id=?`, filters[key]))
    )
      fail(400, "A selected report filter no longer exists.");
  const notifications = body.notifications === true;
  const recipient = notifications ? recipientAddress(body.recipient) : null;
  if (notifications) {
    if (!body.paused && !monthlyEmailReady(env))
      fail(
        503,
        "Email is not configured yet. You can save the schedule without email notifications.",
      );
    if (
      !(await one(
        db,
        "SELECT email FROM report_recipients WHERE owner_id=? AND email=? AND verified_at IS NOT NULL",
        user.id,
        recipient,
      ))
    )
      fail(400, "Verify the notification email before enabling it.");
    if (
      await one(
        db,
        "SELECT recipient FROM email_suppressions WHERE recipient=?",
        recipient,
      )
    )
      fail(409, "This email address is suppressed.");
  }
  return {
    name,
    filters: JSON.stringify(filters),
    minute,
    notifications: notifications ? 1 : 0,
    recipient,
    paused: body.paused === true ? 1 : 0,
  };
}
async function saveSchedule(db, env, user, body, id, time = Date.now()) {
  const input = await settingsInput(db, user, body, env),
    stamp = new Date(time).toISOString();
  const old = id ? await schedule(db, id, user.id) : null;
  const rev = old ? integer(body.revision, 1, 1000000, "schedule version") : 0;
  if (old && old.revision !== rev) fail(409, STALE);
  if (
    !old &&
    (
      await one(
        db,
        "SELECT COUNT(*) n FROM report_schedules WHERE owner_id=?",
        user.id,
      )
    ).n >= 20
  )
    fail(
      400,
      "At most 20 monthly schedules can be saved. Edit an existing schedule.",
    );
  id ||= randomUUID();
  const effective = old
    ? currentMonth(time)
    : shiftMonth(currentMonth(time), -1);
  const writes = old
    ? [
        stmt(
          db,
          `INSERT INTO report_templates(schedule_id,revision,effective_month,name,filters_json,minute,notifications,recipient,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM report_schedules WHERE id=? AND owner_id=? AND revision=?)`,
          id,
          rev + 1,
          effective,
          input.name,
          input.filters,
          input.minute,
          input.notifications,
          input.recipient,
          stamp,
          id,
          user.id,
          rev,
        ),
        stmt(
          db,
          "UPDATE report_schedules SET revision=revision+1,paused=?,updated_at=?,next_attempt_at=0,last_error=NULL WHERE id=? AND owner_id=? AND revision=? AND changes()=1",
          input.paused,
          stamp,
          id,
          user.id,
          rev,
        ),
      ]
    : [
        stmt(
          db,
          "INSERT INTO report_schedules(id,owner_id,paused,next_month,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          id,
          user.id,
          input.paused,
          currentMonth(time),
          stamp,
          stamp,
        ),
        stmt(
          db,
          "INSERT INTO report_templates(schedule_id,revision,effective_month,name,filters_json,minute,notifications,recipient,created_at) VALUES(?,1,?,?,?,?,?,?,?)",
          id,
          effective,
          input.name,
          input.filters,
          input.minute,
          input.notifications,
          input.recipient,
          stamp,
        ),
      ];
  writes.push(
    stmt(
      db,
      "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,?,'report_schedule',?,?,? WHERE changes()=1",
      user.id,
      old ? "update" : "create",
      id,
      JSON.stringify({ revision: rev + 1, ...input }),
      stamp,
    ),
  );
  const result = await db.batch(writes);
  if (!result[0].meta.changes) fail(409, STALE);
  return scheduleView(db, await schedule(db, id, user.id));
}
export async function generateSnapshot(
  db,
  env,
  s,
  period,
  {
    time = Date.now(),
    automatic = false,
    previous = null,
    key = null,
    reason = "",
  } = {},
) {
  month(period);
  if (period >= currentMonth(time))
    fail(400, "Choose a completed calendar month.");
  const requestKey = previous
    ? `${s.id}/revision/${key}`
    : `${s.id}/month/${period}`;
  let old = await one(
    db,
    "SELECT id,supersedes_id,reason FROM report_snapshots WHERE request_key=?",
    requestKey,
  );
  if (old) {
    if (
      previous &&
      (old.supersedes_id !== previous.id || old.reason !== reason)
    )
      fail(
        409,
        "This revision request was already used with different details.",
      );
    if (automatic) await advance(db, s, period, time);
    return { id: old.id, existing: true };
  }
  const current = await one(
    db,
    "SELECT id,version FROM report_snapshots WHERE schedule_id=? AND period=? ORDER BY version DESC LIMIT 1",
    s.id,
    period,
  );
  if (previous && current?.id !== previous.id) fail(409, STALE);
  if (!previous && current) {
    if (automatic) await advance(db, s, period, time);
    return { id: current.id, existing: true };
  }
  const t = previous
    ? await one(
        db,
        "SELECT * FROM report_templates WHERE schedule_id=? AND revision=?",
        s.id,
        previous.template_revision,
      )
    : await template(db, s.id, period);
  const filters = JSON.parse(t.filters_json),
    options = monthOptions(period, filters);
  // One D1 batch is a consistent read transaction for both periods, labels and the audit watermark.
  const inputs = await db.batch([
    stmt(
      db,
      INPUT_SELECT,
      options.previousFrom,
      options.to,
      options.therapist,
      options.therapist,
      options.service,
      options.service,
      options.status,
      options.status,
      options.requested,
      options.requested === "yes" ? 1 : 0,
    ),
    stmt(db, "SELECT id,name FROM therapists ORDER BY name"),
    stmt(
      db,
      "SELECT COALESCE(MAX(id),0) AS audit_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS cutoff FROM audit_log",
    ),
  ]);
  const rows = inputs[0].results,
    therapists = inputs[1].results,
    watermark = inputs[2].results[0];
  if (rows.length > 5000)
    fail(
      422,
      "This saved report is too large. Narrow the report scope before generating it.",
    );
  let report,
    incomplete = 0;
  try {
    report = buildReport(rows, options, therapists);
    const prior = buildReport(
      rows,
      { ...options, from: options.previousFrom, to: options.previousTo },
      therapists,
    );
    report = {
      ...report,
      includeBonuses: filters.bonuses,
      previous: prior.totals,
      comparison: comparison(report.totals, prior.totals),
      warnings: [],
    };
    if (report.totals.pending || prior.totals.pending) {
      incomplete = 1;
      report.warnings.push(
        "Uncompleted appointments remain in the current or comparison period. Hours, revenue and bonuses include completed massages only.",
      );
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 422) throw error;
    incomplete = 1;
    report = {
      options,
      error: error.message,
      totals: null,
      details: [],
      groups: [],
      previous: null,
      comparison: null,
      warnings: [
        "Incomplete source data. No financial totals have been calculated.",
      ],
    };
  }
  const statusCSV = csv([
    ["Status", "From", "To", "Reason"],
    ["Incomplete", options.from, options.to, report.error],
  ]);
  const summary = report.error
    ? statusCSV
    : reportCSV(report, "summary", filters.bonuses);
  const details = report.error
    ? statusCSV
    : reportCSV(report, "details", filters.bonuses);
  const compared = report.error
    ? statusCSV
    : comparisonCSV(report, filters.bonuses);
  const data = JSON.stringify(report),
    source = JSON.stringify({ rows, therapists });
  if (
    new TextEncoder().encode(data + source + summary + details + compared)
      .length > 1700000
  )
    fail(
      422,
      "The saved report exceeds the archive size limit. Narrow its filters.",
    );
  const id = digest(requestKey),
    version = previous ? previous.version + 1 : 1,
    stamp = new Date(time).toISOString();
  const insert = stmt(
    db,
    `INSERT INTO report_snapshots(id,schedule_id,template_revision,period,version,supersedes_id,request_key,reason,generated_at,cutoff_at,cutoff_audit_id,definition_version,inputs_json,report_json,summary_csv,details_csv,comparison_csv,incomplete)
SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM report_schedules s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND s.revision=? AND u.role='owner' AND u.active=1 AND (?=0 OR s.paused=0))
AND COALESCE((SELECT id FROM report_snapshots WHERE schedule_id=? AND period=? ORDER BY version DESC LIMIT 1),'')=?
ON CONFLICT DO NOTHING`,
    id,
    s.id,
    t.revision,
    period,
    version,
    previous?.id || null,
    requestKey,
    reason,
    stamp,
    watermark.cutoff,
    watermark.audit_id,
    DEFINITION,
    source,
    data,
    summary,
    details,
    compared,
    incomplete,
    s.id,
    s.revision,
    automatic ? 1 : 0,
    s.id,
    period,
    previous?.id || "",
  );
  const writes = [
    insert,
    stmt(
      db,
      "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'save_monthly_report','report_snapshot',?,?,? WHERE changes()=1",
      s.owner_id,
      id,
      JSON.stringify({
        period,
        version,
        templateRevision: t.revision,
        incomplete: !!incomplete,
      }),
      stamp,
    ),
  ];
  // Queue a notification in the same transaction as the saved report; no financial data in the payload.
  if (t.notifications && !s.paused)
    writes.push(
      stmt(
        db,
        `INSERT INTO report_email_jobs(id,owner_id,snapshot_id,kind,recipient,payload_json,created_at,updated_at)
SELECT ?,?,?,'report',?,?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM report_snapshots WHERE id=?) ON CONFLICT(id) DO NOTHING`,
        digest(`${s.id}/${t.revision}/${period}/${version}/${t.recipient}`),
        s.owner_id,
        id,
        t.recipient,
        reportMessage(env, t.recipient, t.name, period, id),
        stamp,
        stamp,
        id,
      ),
    );
  await db.batch(writes);
  old = await one(
    db,
    "SELECT id FROM report_snapshots WHERE request_key=?",
    requestKey,
  );
  if (!old) fail(409, STALE);
  await stmt(
    db,
    "UPDATE report_schedules SET last_run_at=?,last_error=?,next_attempt_at=0 WHERE id=? AND revision=?",
    stamp,
    incomplete ? "incomplete_data" : null,
    s.id,
    s.revision,
  ).run();
  if (automatic) await advance(db, s, period, time);
  return { id: old.id, existing: false };
}
async function advance(db, s, period, time) {
  await stmt(
    db,
    "UPDATE report_schedules SET next_month=?,last_run_at=?,next_attempt_at=0 WHERE id=? AND revision=? AND next_month=? AND paused=0",
    shiftMonth(period, 1),
    new Date(time).toISOString(),
    s.id,
    s.revision,
    period,
  ).run();
}
export async function runMonthly(env, time = Date.now(), transport = fetch) {
  const db = env.DB;
  await schema(db);
  const schedules = await all(
    db,
    SCHEDULE +
      " JOIN users u ON u.id=s.owner_id WHERE s.paused=0 AND s.next_attempt_at<=? AND u.active=1 AND u.role='owner' ORDER BY s.next_month,s.id LIMIT 20",
    time,
  );
  let remaining = 6;
  for (let s of schedules) {
    while (remaining > 0) {
      const t = await template(db, s.id, s.next_month);
      if (dueAt(s.next_month, t.minute) > time) break;
      remaining--;
      try {
        await generateSnapshot(db, env, s, s.next_month, {
          time,
          automatic: true,
        });
        s = await schedule(db, s.id, s.owner_id);
        if (s.paused) break;
      } catch (error) {
        await stmt(
          db,
          "UPDATE report_schedules SET last_error=?,next_attempt_at=? WHERE id=? AND revision=?",
          error instanceof HttpError
            ? error.message
            : "Report generation failed. Retry from Monthly reports.",
          time + 3600000,
          s.id,
          s.revision,
        ).run();
        break;
      }
    }
  }
  await deliverMonthlyJobs(db, env, time, transport);
}
async function snapshot(db, id, user) {
  const row = await one(
    db,
    "SELECT p.* FROM report_snapshots p JOIN report_schedules s ON s.id=p.schedule_id WHERE p.id=? AND s.owner_id=?",
    id,
    user.id,
  );
  if (!row) fail(404, "Saved report not found.");
  return row;
}
export async function monthlyRoutes(request, env, user) {
  requireRole(user, "owner");
  const db = env.DB,
    url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  await schema(db);
  if (path === "/api/reports/monthly" && method === "GET") {
    const rows = await all(
      db,
      SCHEDULE + " WHERE s.owner_id=? ORDER BY s.created_at,s.id",
      user.id,
    );
    const recipients = await all(
      db,
      "SELECT email,verified_at FROM report_recipients WHERE owner_id=? AND verified_at IS NOT NULL ORDER BY email",
      user.id,
    );
    const jobs = await all(
      db,
      "SELECT * FROM report_email_jobs WHERE owner_id=? AND kind='verification' ORDER BY created_at DESC LIMIT 3",
      user.id,
    );
    return Response.json({
      schedules: await Promise.all(rows.map((r) => scheduleView(db, r))),
      recipients,
      emailReady: monthlyEmailReady(env),
      accountEmail: user.email,
      verificationJobs: jobs.map(jobView),
    });
  }
  if (path === "/api/reports/monthly" && method === "POST")
    return Response.json(
      await saveSchedule(db, env, user, await readJSON(request), null),
      { status: 201 },
    );
  let match = path.match(/^\/api\/reports\/monthly\/([\w-]+)$/);
  if (match && method === "PUT")
    return Response.json(
      await saveSchedule(db, env, user, await readJSON(request), match[1]),
    );
  match = path.match(/^\/api\/reports\/monthly\/([\w-]+)\/generate$/);
  if (match && method === "POST") {
    const body = await readJSON(request),
      s = await schedule(db, match[1], user.id);
    return Response.json(
      await generateSnapshot(db, env, s, month(body.period)),
    );
  }
  if (path === "/api/reports/recipients/request" && method === "POST") {
    const body = await readJSON(request, 4096),
      result = await requestRecipient(db, env, user, body.email);
    return Response.json({
      ...result,
      job: await sendMonthlyJob(db, env, result.job.id),
    });
  }
  if (path === "/api/reports/recipients/confirm" && method === "POST") {
    const body = await readJSON(request, 4096);
    return Response.json(
      await confirmRecipient(db, user, body.email, body.code),
    );
  }
  if (path === "/api/reports/archive" && method === "GET") {
    const offset = integer(
      Number(url.searchParams.get("offset") || 0),
      0,
      100000,
      "archive page",
    );
    const rows = await all(
      db,
      SNAP_META +
        " WHERE s.owner_id=? ORDER BY p.generated_at DESC,p.id LIMIT 51 OFFSET ?",
      user.id,
      offset,
    );
    return Response.json({
      snapshots: rows.slice(0, 50),
      nextOffset: rows.length > 50 ? offset + 50 : null,
    });
  }
  match = path.match(/^\/api\/reports\/archive\/([\w-]+)(\.csv)?$/);
  if (match && method === "GET") {
    const row = await snapshot(db, match[1], user);
    if (match[2]) {
      const view = url.searchParams.get("view") || "summary";
      if (!["summary", "details", "comparison"].includes(view))
        fail(400, "Choose a report export.");
      return new Response(row[view + "_csv"], {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="rei-${row.period}-v${row.version}-${view}.csv"`,
        },
      });
    }
    const meta = await one(db, SNAP_META + " WHERE p.id=?", row.id);
    return Response.json({ ...meta, report: JSON.parse(row.report_json) });
  }
  match = path.match(/^\/api\/reports\/archive\/([\w-]+)\/revise$/);
  if (match && method === "POST") {
    const previous = await snapshot(db, match[1], user),
      body = await readJSON(request, 4096);
    const key = text(body.key, 80, "request key"),
      reason = text(body.reason, 300, "correction reason");
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(key))
      fail(400, "Reopen the report and try again.");
    return Response.json(
      await generateSnapshot(
        db,
        env,
        await schedule(db, previous.schedule_id, user.id),
        previous.period,
        { previous, key, reason },
      ),
    );
  }
  match = path.match(/^\/api\/reports\/notifications\/([\w-]+)\/retry$/);
  if (match && method === "POST") {
    if (
      !(await one(
        db,
        "SELECT id FROM report_email_jobs WHERE id=? AND owner_id=?",
        match[1],
        user.id,
      ))
    )
      fail(404, "Notification not found.");
    return Response.json(await sendMonthlyJob(db, env, match[1]));
  }
  fail(404, "Monthly report action not found.");
}
