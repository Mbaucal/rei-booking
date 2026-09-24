import { randomUUID, randomBytes } from "node:crypto";
import { fail, digest } from "./security.mjs";
import { email } from "./domain.mjs";
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const FROM = "Rei Thailand Massage <info@reithailandmassage.com>";
export const monthlyEmailReady = (env) =>
  env.EMAIL_ENABLED === "true" &&
  !!env.RESEND_API_KEY &&
  !!env.RESEND_WEBHOOK_SECRET;
export function recipientAddress(value) {
  const result = email(value, false);
  if (/[<>"',;\\\x00-\x20\x7f]/.test(result))
    fail(400, "Enter one recipient email address.");
  return result;
}
const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function message(to, subject, text, body) {
  return JSON.stringify({
    from: FROM,
    to: [to],
    subject,
    text,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head><body style="margin:0;background:#faf7f0;color:#203f35;font-family:Arial,sans-serif;font-size:16px;line-height:1.6"><div style="max-width:560px;margin:auto;padding:32px 24px"><p>REI THAILAND MASSAGE</p><h1 style="font-size:24px">${esc(subject)}</h1>${body}<p style="font-size:14px;color:#53655f">Rei Booking</p></div></body></html>`,
  });
}
function origin(env) {
  let value;
  try {
    value = new URL(env.APP_ORIGIN);
  } catch {
    fail(503, "Application address is not configured.");
  }
  if (value.protocol !== "https:" || value.origin !== env.APP_ORIGIN)
    fail(503, "Application address is not configured.");
  return value.origin;
}
export function reportMessage(env, to, name, period, id) {
  const url = origin(env) + "/#report=" + encodeURIComponent(id);
  const subject = "Your monthly report is ready";
  return message(
    to,
    subject,
    `${name}\nPeriod: ${period}\nOpen the saved report and download CSV after signing in:\n${url}\nManage notifications in Reports > Monthly reports.`,
    `<p>${esc(name)}</p><p>Period: ${esc(period)}</p><p>Your saved report is available in Rei Booking. Sign in to view it or download CSV.</p><p><a href="${esc(url)}" style="display:inline-block;background:#203f35;color:#fff;padding:14px 22px;border-radius:6px">Open saved report</a></p><p>Manage notifications in Reports &gt; Monthly reports.</p>`,
  );
}
export const jobView = (row) => ({
  id: row.id,
  kind: row.kind,
  recipient: row.recipient,
  status: row.status,
  attempts: row.attempts,
  errorCode: row.error_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  retryAt: row.next_attempt_at,
});
export async function requestRecipient(
  db,
  env,
  user,
  value,
  time = Date.now(),
) {
  if (!monthlyEmailReady(env))
    fail(
      503,
      "Email is not configured yet. Complete sender verification and email settings first.",
    );
  const to = recipientAddress(value),
    code = randomBytes(5).toString("hex").toUpperCase(),
    id = randomUUID(),
    stamp = new Date(time).toISOString();
  if (
    await one(
      db,
      "SELECT recipient FROM email_suppressions WHERE recipient=?",
      to,
    )
  )
    fail(409, "This address is blocked after a bounce or complaint.");
  const text = `Your Rei Booking email verification code is ${code}.\nEnter it in Reports > Monthly reports. It expires in 20 minutes.\nIf you did not request this, ignore this email.`;
  const payload = message(
    to,
    "Verify your report notification email",
    text,
    `<p>Enter this code in Reports &gt; Monthly reports:</p><p style="font:28px monospace;letter-spacing:3px">${code}</p><p>This code expires in 20 minutes.</p><p>If you did not request this, ignore this email.</p>`,
  );
  const r = await db.batch([
    stmt(
      db,
      `INSERT INTO report_email_jobs(id,owner_id,kind,recipient,payload_json,expires_at,created_at,updated_at)
SELECT ?,?,'verification',?,?,?,?,? WHERE
(SELECT COUNT(*) FROM report_email_jobs WHERE owner_id=? AND kind='verification' AND created_at>?)<3
AND NOT EXISTS(SELECT 1 FROM report_email_jobs WHERE owner_id=? AND kind='verification' AND created_at>?)`,
      id,
      user.id,
      to,
      payload,
      time + 1200000,
      stamp,
      stamp,
      user.id,
      new Date(time - 3600000).toISOString(),
      user.id,
      new Date(time - 60000).toISOString(),
    ),
    stmt(
      db,
      `INSERT INTO report_recipients(owner_id,email,code_hash,expires_at,attempts,last_sent_at,active_job_id) SELECT ?,?,?,?,0,?,? WHERE changes()=1
ON CONFLICT(owner_id,email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at,active_job_id=excluded.active_job_id`,
      user.id,
      to,
      digest(code),
      time + 1200000,
      time,
      id,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'verify_report_recipient','report_recipient',?,'{}',? WHERE changes()=1`,
      user.id,
      to,
      stamp,
    ),
  ]);
  if (!r[0].meta.changes)
    fail(
      429,
      "Wait one minute between verification emails; at most three per hour.",
    );
  return {
    job: jobView(
      await one(db, "SELECT * FROM report_email_jobs WHERE id=?", id),
    ),
  };
}
export async function confirmRecipient(
  db,
  user,
  value,
  code,
  time = Date.now(),
) {
  const to = recipientAddress(value);
  if (typeof code !== "string" || !/^[A-Fa-f0-9]{10}$/.test(code.trim()))
    fail(400, "Enter the 10-character code from the email.");
  const row = await stmt(
    db,
    `UPDATE report_recipients SET attempts=attempts+1 WHERE owner_id=? AND email=? AND code_hash IS NOT NULL AND expires_at>? AND attempts<5 RETURNING code_hash`,
    user.id,
    to,
    time,
  ).first();
  if (!row || row.code_hash !== digest(code.trim().toUpperCase()))
    fail(
      400,
      "The code is incorrect or expired. Request a new code if needed.",
    );
  const result = await db.batch([
    stmt(
      db,
      `UPDATE report_recipients SET verified_at=?,code_hash=NULL,expires_at=0 WHERE owner_id=? AND email=? AND code_hash=?`,
      new Date(time).toISOString(),
      user.id,
      to,
      row.code_hash,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'report_recipient_verified','report_recipient',?,'{}',? WHERE changes()=1`,
      user.id,
      to,
      new Date(time).toISOString(),
    ),
  ]);
  if (!result[0].meta.changes)
    fail(409, "The verification code changed. Use the latest email.");
  return { ok: true };
}
const EVENTS = {
  "email.sent": ["accepted", 1],
  "email.delivery_delayed": ["delayed", 2],
  "email.delivered": ["delivered", 3],
  "email.failed": ["failed", 4],
  "email.bounced": ["bounced", 5],
  "email.complained": ["complained", 6],
  "email.suppressed": ["suppressed", 6],
};
export async function reconcileReportEvents(db, providerId) {
  const events = (
    await stmt(
      db,
      "SELECT * FROM email_events WHERE provider_id=? ORDER BY occurred_at,id",
      providerId,
    ).all()
  ).results;
  for (const event of events) {
    const pair = EVENTS[event.event_type];
    if (!pair) continue;
    const [status, rank] = pair;
    await db.batch([
      stmt(
        db,
        "UPDATE report_email_jobs SET status=?,status_rank=?,error_code=NULL,lease_until=0,updated_at=? WHERE provider_id=? AND status_rank<?",
        status,
        rank,
        event.received_at,
        providerId,
        rank,
      ),
      stmt(
        db,
        `INSERT INTO email_suppressions(recipient,reason,created_at) SELECT recipient,?,? FROM report_email_jobs WHERE provider_id=? AND ? IN ('bounced','complained','suppressed') ON CONFLICT(recipient) DO NOTHING`,
        status,
        event.received_at,
        providerId,
        status,
      ),
    ]);
  }
}
export async function sendMonthlyJob(
  db,
  env,
  id,
  transport = fetch,
  time = Date.now(),
) {
  let job = await one(db, "SELECT * FROM report_email_jobs WHERE id=?", id);
  if (!job) fail(404, "Notification not found.");
  if (!["queued", "retry", "sending"].includes(job.status)) return jobView(job);
  const stamp = new Date(time).toISOString();
  const stop = async (status, error) => {
    await stmt(
      db,
      "UPDATE report_email_jobs SET status=?,error_code=?,lease_until=0,updated_at=? WHERE id=? AND status IN ('queued','retry','sending') AND lease_until<=?",
      status,
      error,
      stamp,
      id,
      time,
    ).run();
    return jobView(
      await one(db, "SELECT * FROM report_email_jobs WHERE id=?", id),
    );
  };
  if (job.expires_at && job.expires_at <= time)
    return stop("expired", "verification_expired");
  if (job.first_attempt_at && time - job.first_attempt_at >= 23 * 3600000)
    return stop("uncertain", "review_provider");
  if (!monthlyEmailReady(env)) {
    await stmt(
      db,
      "UPDATE report_email_jobs SET error_code='email_not_configured' WHERE id=? AND status IN ('queued','retry')",
      id,
    ).run();
    return jobView({ ...job, error_code: "email_not_configured" });
  }
  const eligible = await one(
    db,
    `SELECT id FROM users WHERE id=? AND role='owner' AND active=1`,
    job.owner_id,
  );
  if (!eligible) return stop("cancelled", "owner_inactive");
  if (
    await one(
      db,
      "SELECT recipient FROM email_suppressions WHERE recipient=?",
      job.recipient,
    )
  )
    return stop("suppressed", "recipient_suppressed");
  if (job.kind === "report") {
    const enabled = await one(
      db,
      `SELECT s.id FROM report_snapshots p JOIN report_schedules s ON s.id=p.schedule_id
JOIN report_templates t ON t.schedule_id=s.id AND t.revision=s.revision
JOIN report_recipients r ON r.owner_id=s.owner_id AND r.email=? AND r.verified_at IS NOT NULL
WHERE p.id=? AND s.paused=0 AND t.notifications=1 AND t.recipient=?`,
      job.recipient,
      job.snapshot_id,
      job.recipient,
    );
    if (!enabled) return stop("cancelled", "notifications_disabled");
  }
  if (
    job.kind === "verification" &&
    !(await one(
      db,
      "SELECT email FROM report_recipients WHERE owner_id=? AND email=? AND active_job_id=? AND code_hash IS NOT NULL AND expires_at>?",
      job.owner_id,
      job.recipient,
      job.id,
      time,
    ))
  )
    return stop("cancelled", "verification_replaced");
  const claim = await stmt(
    db,
    `UPDATE report_email_jobs SET status='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),lease_until=?,updated_at=?,error_code=NULL
WHERE id=? AND status IN ('queued','retry','sending') AND lease_until<=? AND next_attempt_at<=?
AND EXISTS(SELECT 1 FROM users u WHERE u.id=report_email_jobs.owner_id AND u.active=1 AND u.role='owner')
AND NOT EXISTS(SELECT 1 FROM email_suppressions e WHERE e.recipient=report_email_jobs.recipient)
AND ((kind='verification' AND EXISTS(SELECT 1 FROM report_recipients r WHERE r.owner_id=report_email_jobs.owner_id AND r.email=report_email_jobs.recipient AND r.active_job_id=report_email_jobs.id AND r.code_hash IS NOT NULL AND r.expires_at>?))
OR (kind='report' AND EXISTS(SELECT 1 FROM report_snapshots p JOIN report_schedules s ON s.id=p.schedule_id JOIN report_templates t ON t.schedule_id=s.id AND t.revision=s.revision JOIN report_recipients r ON r.owner_id=s.owner_id AND r.email=t.recipient AND r.verified_at IS NOT NULL WHERE p.id=report_email_jobs.snapshot_id AND s.paused=0 AND t.notifications=1 AND t.recipient=report_email_jobs.recipient))) RETURNING *`,
    time,
    time + 60000,
    stamp,
    id,
    time,
    time,
    time,
  ).first();
  if (!claim)
    return jobView(
      await one(db, "SELECT * FROM report_email_jobs WHERE id=?", id),
    );
  job = claim;
  let response, result;
  try {
    response = await transport("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "rei-report/" + id,
      },
      body: job.payload_json,
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    result = await response.json();
  } catch {
    response = null;
  }
  if (
    response?.ok &&
    typeof result?.id === "string" &&
    /^[a-zA-Z0-9-]{1,100}$/.test(result.id)
  ) {
    await db.batch([
      stmt(
        db,
        "UPDATE report_email_jobs SET provider_id=?,status='accepted',status_rank=1,lease_until=0,updated_at=? WHERE id=? AND status='sending'",
        result.id,
        stamp,
        id,
      ),
      stmt(
        db,
        "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'report_email_accepted','report_email',?,'{}',? WHERE changes()=1",
        job.owner_id,
        id,
        stamp,
      ),
    ]);
    await reconcileReportEvents(db, result.id);
  } else if (
    !response ||
    response.ok ||
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 409 &&
      result?.name === "concurrent_idempotent_requests")
  ) {
    const delay = Math.min(3600000, 60000 * 2 ** Math.min(job.attempts, 6));
    await stmt(
      db,
      "UPDATE report_email_jobs SET status='retry',lease_until=0,next_attempt_at=?,error_code=?,updated_at=? WHERE id=? AND status='sending'",
      time + delay,
      response?.status === 429 ? "rate_limited" : "delivery_unconfirmed",
      stamp,
      id,
    ).run();
  } else {
    await stmt(
      db,
      "UPDATE report_email_jobs SET status='failed',status_rank=4,lease_until=0,error_code=?,updated_at=? WHERE id=? AND status='sending'",
      "provider_" + response.status,
      stamp,
      id,
    ).run();
  }
  return jobView(
    await one(db, "SELECT * FROM report_email_jobs WHERE id=?", id),
  );
}
export async function deliverMonthlyJobs(
  db,
  env,
  time = Date.now(),
  transport = fetch,
) {
  if (!monthlyEmailReady(env)) return;
  const jobs = (
    await stmt(
      db,
      "SELECT id FROM report_email_jobs WHERE status IN ('queued','retry','sending') AND lease_until<=? AND next_attempt_at<=? ORDER BY created_at LIMIT 6",
      time,
      time,
    ).all()
  ).results;
  for (const job of jobs)
    await sendMonthlyJob(db, env, job.id, transport, time);
}
