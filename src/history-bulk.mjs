import { randomUUID } from "node:crypto";
import { digest, fail, readJSON, requireRole, token } from "./security.mjs";
import { ensureClientContacts } from "./client-contacts.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";
import { ensureHistoryPreviewSchema } from "./history-preview-schema.mjs";
import { ensureHistoryArchiveSchema } from "./history-archive-schema.mjs";
import { ensureHistoryBulkSchema } from "./history-bulk-schema.mjs";
import { historyArchiveReview } from "./history-archive.mjs";

export const HISTORY_BULK_LIMITS = Object.freeze({
  stepRows: 50,
  stepEvidenceBytes: 1500000,
  pageBytes: 1900000,
  activeJobs: 3,
  statuses: 200,
});
const stmt = (db, q, ...args) => db.prepare(q).bind(...args);
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
const clientClock = "(SELECT revision FROM client_transfer_state WHERE id=1)";
const archiveClock = "(SELECT revision FROM history_archive_state WHERE id=1)";
const nativeClock = "(SELECT revision FROM history_native_state WHERE id=1)";
const clocksMatch = `client_revision=${clientClock} AND archive_revision=${archiveClock} AND native_revision=${nativeClock}`;
const previewMatch = `EXISTS(SELECT 1 FROM history_previews p WHERE p.id=history_import_jobs.preview_id AND p.version=history_import_jobs.preview_version AND p.owner_id=history_import_jobs.owner_id AND p.phase='ready' AND p.expires_at>?)`;
const guard = `EXISTS(SELECT 1 FROM history_import_jobs WHERE id=? AND mutation_token=?)`;
const zeroCounts = () => ({
  selected: 0,
  importable: 0,
  duplicates: 0,
  blocked: 0,
  unmatched: 0,
  conflicts: 0,
  invalid: 0,
});
function validate(body, allowed) {
  if (
    !body ||
    Object.keys(body).some((k) => !allowed.includes(k)) ||
    typeof body.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId)
  )
    fail(400, "Use a request ID and only the documented job fields.");
  if (!Number.isSafeInteger(body.version) || body.version < 1)
    fail(400, "Use the current import job version.");
}
async function find(db, user, id) {
  const j = await stmt(
    db,
    "SELECT * FROM history_import_jobs WHERE id=? AND owner_id=?",
    id,
    user.id,
  ).first();
  if (!j) fail(404, "Historical import job not found.");
  return j;
}
async function project(db, j, lightweight = false) {
  const statuses = lightweight
    ? undefined
    : (
        await stmt(
          db,
          "SELECT status,count FROM history_import_job_statuses WHERE job_id=? ORDER BY status_key",
          j.id,
        ).all()
      ).results;
  const expired = j.expires_at !== null && j.expires_at <= Date.now();
  return {
    id: j.id,
    previewId: j.preview_id,
    previewVersion: j.preview_version,
    source: j.source,
    phase: j.phase,
    version: j.version,
    total: j.total,
    reviewed: j.reviewed,
    processed: j.processed,
    created: j.created,
    duplicates: j.duplicates,
    counts: JSON.parse(j.counts_json),
    ...(lightweight ? {} : { statusCounts: statuses }),
    canConfirm:
      j.phase === "ready" &&
      !expired &&
      JSON.parse(j.counts_json).blocked === 0,
    confirmationToken:
      !lightweight && j.phase === "ready" && !expired
        ? j.confirmation_token
        : null,
    expiresAt: j.expires_at,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    reason: expired
      ? "The source preview expired. Prepare a new complete review."
      : j.reason,
    requiresNewReview: j.phase === "paused" || expired,
    warnings: [
      "Original source statuses and unknown facts are retained as historical evidence. No live booking, payment, financial report or bonus is created. Unverified source references are conservatively reserved as single appointments; later different evidence or reference modes will conflict.",
    ],
  };
}
async function output(db, user, id, extra = {}, status = 200) {
  return json(
    { job: await project(db, await find(db, user, id)), ...extra },
    status,
  );
}
async function replay(db, user, j, body, op) {
  const r = await stmt(
    db,
    "SELECT body_hash FROM history_import_job_requests WHERE job_id=? AND request_id=?",
    j.id,
    body.requestId,
  ).first();
  if (!r) return null;
  if (r.body_hash !== digest(canonical({ op, body })))
    fail(
      409,
      "This job request ID was already used with different details. Nothing was repeated.",
    );
  return output(db, user, j.id, { repeated: true });
}
function receipt(db, j, body, op, mutation) {
  return stmt(
    db,
    `INSERT INTO history_import_job_requests(job_id,request_id,body_hash,result_version) SELECT id,?,?,version FROM history_import_jobs WHERE id=? AND mutation_token=?`,
    body.requestId,
    digest(canonical({ op, body })),
    j.id,
    mutation,
  );
}
async function pause(db, user, j, reason) {
  await stmt(
    db,
    `UPDATE history_import_jobs SET phase='paused',reason=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=? AND phase IN('reviewing','ready','importing')`,
    reason,
    Date.now(),
    j.id,
    user.id,
    j.version,
  ).run();
  return output(db, user, j.id);
}
async function current(db, user, j, body) {
  if (body.version !== j.version)
    fail(
      409,
      "This import job changed. Reload its saved progress before continuing.",
    );
  if (!["reviewing", "ready", "importing"].includes(j.phase)) return false;
  const valid = await stmt(
    db,
    `SELECT id FROM history_import_jobs WHERE id=? AND ${clocksMatch} AND (confirmed_at IS NOT NULL OR (expires_at>? AND ${previewMatch}))`,
    j.id,
    Date.now(),
    Date.now(),
  ).first();
  return Boolean(valid);
}
async function start(db, user, body) {
  validate(body, ["previewId", "version", "requestId"]);
  if (
    typeof body.previewId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(body.previewId)
  )
    fail(400, "Choose a ready history preview.");
  const inputHash = digest(canonical(body));
  const previous = await stmt(
    db,
    "SELECT * FROM history_import_jobs WHERE owner_id=? AND request_id=?",
    user.id,
    body.requestId,
  ).first();
  if (previous) {
    if (previous.input_hash !== inputHash)
      fail(
        409,
        "This request ID was already used for another whole-report review.",
      );
    return output(db, user, previous.id, { repeated: true });
  }
  const p = await stmt(
    db,
    `SELECT * FROM history_previews WHERE id=? AND owner_id=? AND version=? AND phase='ready' AND expires_at>? AND client_revision=${clientClock}`,
    body.previewId,
    user.id,
    body.version,
    Date.now(),
  ).first();
  if (!p)
    fail(
      409,
      "The source preview expired or changed. Reopen a current ready preview.",
    );
  const id = randomUUID(),
    now = Date.now();
  await stmt(
    db,
    `INSERT OR IGNORE INTO history_import_jobs(id,owner_id,request_id,input_hash,preview_id,preview_version,source,phase,total,counts_json,client_revision,archive_revision,native_revision,confirmation_token,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'reviewing',?,?,${clientClock},${archiveClock},${nativeClock},?,?,?,? WHERE EXISTS(SELECT 1 FROM history_previews WHERE id=? AND owner_id=? AND version=? AND phase='ready' AND expires_at>? AND client_revision=${clientClock}) AND (SELECT COUNT(*) FROM history_import_jobs WHERE owner_id=? AND phase IN('reviewing','ready','importing') AND (expires_at IS NULL OR expires_at>?))<3`,
    id,
    user.id,
    body.requestId,
    inputHash,
    p.id,
    p.version,
    p.source,
    p.total,
    JSON.stringify(zeroCounts()),
    token(),
    p.expires_at,
    now,
    now,
    p.id,
    user.id,
    p.version,
    now,
    user.id,
    now,
  ).run();
  const saved = await stmt(
    db,
    "SELECT id,input_hash FROM history_import_jobs WHERE owner_id=? AND request_id=?",
    user.id,
    body.requestId,
  ).first();
  if (!saved)
    fail(
      409,
      "The preview changed or three import jobs are already active. Cancel an unused job before starting another.",
    );
  if (saved.input_hash !== inputHash)
    fail(
      409,
      "This request ID was already used for another whole-report review.",
    );
  return output(
    db,
    user,
    saved.id,
    { repeated: saved.id !== id },
    saved.id === id ? 201 : 200,
  );
}
function rowCounts(rows) {
  const c = zeroCounts();
  c.selected = rows.length;
  for (const r of rows) {
    if (r.disposition === "import") c.importable++;
    else if (r.disposition === "duplicate") c.duplicates++;
    else {
      c.blocked++;
      c[
        r.blockReason === "unmatched"
          ? "unmatched"
          : r.blockReason === "conflict"
            ? "conflicts"
            : "invalid"
      ]++;
    }
  }
  return c;
}
async function prepareStep(db, user, j, body) {
  const candidates = (
    await stmt(
      db,
      "SELECT row_num,length(CAST(record_json AS BLOB)) AS bytes FROM history_preview_rows WHERE preview_id=? AND row_num>? ORDER BY row_num LIMIT 50",
      j.preview_id,
      j.reviewed + 1,
    ).all()
  ).results;
  let bytes = 0;
  const selected = [];
  for (const r of candidates) {
    if (
      selected.length &&
      bytes + r.bytes > HISTORY_BULK_LIMITS.stepEvidenceBytes
    )
      break;
    bytes += r.bytes;
    selected.push(r.row_num);
  }
  if (!selected.length)
    return pause(
      db,
      user,
      j,
      "The source rows no longer match this review. Prepare a new complete review.",
    );
  let result;
  try {
    result = await historyArchiveReview(db, user, {
      previewId: j.preview_id,
      version: j.preview_version,
      rows: selected,
      requestId: `job_${j.id}_${j.version}`,
    });
  } catch (e) {
    if ([404, 409, 410, 422].includes(e.status))
      return pause(db, user, j, e.message + " Prepare a new complete review.");
    throw e;
  }
  const review = await result.json(),
    stored = await stmt(
      db,
      "SELECT plan_json FROM history_import_reviews WHERE id=?",
      review.reviewId,
    ).first();
  const plan = JSON.parse(stored.plan_json),
    keyRows = (
      await stmt(
        db,
        `SELECT k.* FROM json_each(?) p CROSS JOIN history_import_job_keys k ON k.job_id=? AND k.ref_hash=json_extract(p.value,'$.refHash') AND k.line_key=json_extract(p.value,'$.lineKey')`,
        stored.plan_json,
        j.id,
      ).all()
    ).results;
  const seen = new Map(
    keyRows.map((k) => [JSON.stringify([k.ref_hash, k.line_key]), k]),
  );
  for (let i = 0; i < plan.length; i++) {
    const e = plan[i],
      r = review.rows[i],
      key = JSON.stringify([e.refHash, e.lineKey]),
      prior = seen.get(key);
    if (e.disposition !== "blocked") {
      if (prior) {
        if (
          prior.evidence_hash !== e.evidenceHash ||
          prior.client_id !== e.clientId
        ) {
          e.disposition = r.disposition = "blocked";
          r.blockReason = "conflict";
          r.issues.push({
            code: "job_identity_conflict",
            field: "clientId",
            severity: "error",
            message:
              "The same source reference has different evidence or clients in this report.",
          });
        } else {
          e.disposition = r.disposition = "duplicate";
          e.id = prior.archive_id;
        }
      } else
        seen.set(key, {
          evidence_hash: e.evidenceHash,
          client_id: e.clientId,
          archive_id: e.id,
        });
    }
  }
  const oldCounts = JSON.parse(j.counts_json),
    added = rowCounts(review.rows),
    counts = Object.fromEntries(
      Object.keys(oldCounts).map((k) => [k, oldCounts[k] + added[k]]),
    );
  const statuses = new Map(
    (
      await stmt(
        db,
        "SELECT status_key,status,count FROM history_import_job_statuses WHERE job_id=?",
        j.id,
      ).all()
    ).results.map((s) => [s.status_key, s]),
  );
  for (const r of review.rows) {
    const key = JSON.stringify(r.sourceStatus ?? null);
    const s = statuses.get(key) ?? {
      status_key: key,
      status: r.sourceStatus ?? null,
      count: 0,
    };
    s.count++;
    statuses.set(key, s);
  }
  if (
    statuses.size > HISTORY_BULK_LIMITS.statuses ||
    Buffer.byteLength(JSON.stringify([...statuses.values()])) > 500000
  )
    return pause(
      db,
      user,
      j,
      "This report has too many or unusually large status labels (maximum 200 labels and 500 KB). Review the source labels before continuing; none were truncated.",
    );
  const packed = JSON.stringify(
      plan.map((e, i) => ({ ...e, review: review.rows[i] })),
    ),
    mutation = randomUUID(),
    now = Date.now(),
    next = j.reviewed + selected.length;
  if (Buffer.byteLength(packed) > 1900000)
    fail(
      422,
      "A source row contains too much review evidence to store safely. Correct that unusually large source value.",
    );
  await db.batch([
    stmt(
      db,
      `UPDATE history_import_jobs SET reviewed=?,counts_json=?,phase=?,version=version+1,updated_at=?,mutation_token=? WHERE id=? AND owner_id=? AND version=? AND phase='reviewing' AND ${clocksMatch} AND expires_at>? AND ${previewMatch}`,
      next,
      JSON.stringify(counts),
      next === j.total ? "ready" : "reviewing",
      now,
      mutation,
      j.id,
      user.id,
      j.version,
      now,
      now,
    ),
    stmt(
      db,
      `INSERT INTO history_import_job_rows(job_id,row_num,ref_hash,line_key,client_id,client_version,evidence_hash,archive_id,disposition,plan_json,review_json,record_json) SELECT ?,json_extract(p.value,'$.row'),json_extract(p.value,'$.refHash'),json_extract(p.value,'$.lineKey'),json_extract(p.value,'$.clientId'),json_extract(p.value,'$.clientVersion'),json_extract(p.value,'$.evidenceHash'),json_extract(p.value,'$.id'),json_extract(p.value,'$.disposition'),json_remove(p.value,'$.review'),json_extract(p.value,'$.review'),x.record_json FROM json_each(?) p CROSS JOIN history_preview_rows x ON x.preview_id=? AND x.row_num=json_extract(p.value,'$.row') WHERE ${guard}`,
      j.id,
      packed,
      j.preview_id,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `INSERT OR IGNORE INTO history_import_job_keys(job_id,ref_hash,line_key,evidence_hash,client_id,archive_id) SELECT ?,json_extract(value,'$.refHash'),json_extract(value,'$.lineKey'),json_extract(value,'$.evidenceHash'),json_extract(value,'$.clientId'),json_extract(value,'$.id') FROM json_each(?) WHERE json_extract(value,'$.disposition')!='blocked' AND ${guard}`,
      j.id,
      packed,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `INSERT INTO history_import_job_statuses(job_id,status_key,status,count) SELECT ?,json_extract(value,'$.status_key'),json_extract(value,'$.status'),json_extract(value,'$.count') FROM json_each(?) WHERE ${guard} ON CONFLICT(job_id,status_key) DO UPDATE SET count=excluded.count`,
      j.id,
      JSON.stringify([...statuses.values()]),
      j.id,
      mutation,
    ),
    receipt(db, j, body, "step", mutation),
  ]);
  return afterMutation(db, user, j, body, "step");
}
async function afterMutation(db, user, j, body, op) {
  const saved = await replay(db, user, j, body, op);
  if (saved) return saved;
  const latest = await find(db, user, j.id);
  if (latest.version !== j.version)
    fail(409, "Another request advanced this job. Reload its saved progress.");
  return pause(
    db,
    user,
    j,
    "Clients, source choices, archived history or native appointments changed. Prepare a new complete review. Already imported rows remain saved.",
  );
}
async function confirmJob(db, user, j, body) {
  if (
    j.phase !== "ready" ||
    j.reviewed !== j.total ||
    JSON.parse(j.counts_json).blocked
  )
    fail(
      409,
      "Review the entire report and resolve every blocked row before confirming.",
    );
  if (
    body.acknowledgeReview !== true ||
    body.confirmationToken !== j.confirmation_token
  )
    fail(
      409,
      "Explicitly acknowledge this exact complete review before importing.",
    );
  const mutation = randomUUID(),
    now = Date.now();
  await db.batch([
    stmt(
      db,
      `UPDATE history_import_jobs SET phase='importing',confirmed_at=?,expires_at=NULL,version=version+1,updated_at=?,mutation_token=? WHERE id=? AND owner_id=? AND version=? AND phase='ready' AND ${clocksMatch} AND expires_at>? AND ${previewMatch} AND NOT EXISTS(SELECT 1 FROM history_import_job_rows x LEFT JOIN clients c ON c.id=x.client_id WHERE x.job_id=? AND (c.id IS NULL OR c.version!=x.client_version))`,
      now,
      now,
      mutation,
      j.id,
      user.id,
      j.version,
      now,
      now,
      j.id,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'history_job_confirm','history_import_job',?,?,? WHERE ${guard}`,
      user.id,
      j.id,
      JSON.stringify({ total: j.total, counts: JSON.parse(j.counts_json) }),
      new Date(now).toISOString(),
      j.id,
      mutation,
    ),
    receipt(db, j, body, "confirm", mutation),
  ]);
  return afterMutation(db, user, j, body, "confirm");
}
async function importStep(db, user, j, body) {
  const rows = (
    await stmt(
      db,
      "SELECT row_num,plan_json FROM history_import_job_rows WHERE job_id=? AND processed=0 ORDER BY row_num LIMIT 50",
      j.id,
    ).all()
  ).results;
  if (!rows.length)
    fail(409, "The saved job progress is inconsistent. Nothing was imported.");
  const plan = rows.map((r) => JSON.parse(r.plan_json)),
    packed = JSON.stringify(plan),
    numbers = JSON.stringify(rows.map((r) => r.row_num));
  const created = plan.filter((r) => r.disposition === "import").length,
    duplicates = plan.length - created;
  const importId = randomUUID(),
    mutation = randomUUID(),
    now = Date.now(),
    importedAt = new Date(now).toISOString();
  const receiptValue = {
    importId,
    jobId: j.id,
    created,
    duplicates,
    rows: plan.map((e) => ({
      row: e.row,
      id: e.id,
      disposition: e.disposition === "import" ? "imported" : "duplicate",
    })),
  };
  await db.batch([
    stmt(
      db,
      `UPDATE history_import_jobs SET processed=processed+?,created=created+?,duplicates=duplicates+?,phase=CASE WHEN processed+?=total THEN 'completed' ELSE 'importing' END,version=version+1,updated_at=?,mutation_token=? WHERE id=? AND owner_id=? AND version=? AND phase='importing' AND ${clocksMatch} AND NOT EXISTS(SELECT 1 FROM history_import_job_rows x LEFT JOIN clients c ON c.id=x.client_id WHERE x.job_id=? AND x.row_num IN(SELECT value FROM json_each(?)) AND (c.id IS NULL OR c.version!=x.client_version)) AND NOT EXISTS(SELECT 1 FROM history_import_job_rows x JOIN appointments a ON a.client_id=x.client_id AND a.date=json_extract(x.record_json,'$.scheduledLocalDate') AND a.start_minute<json_extract(x.record_json,'$.startMinute')+json_extract(x.record_json,'$.durationMinutes') AND json_extract(x.record_json,'$.startMinute')<a.start_minute+a.duration WHERE x.job_id=? AND x.row_num IN(SELECT value FROM json_each(?)))`,
      plan.length,
      created,
      duplicates,
      plan.length,
      now,
      mutation,
      j.id,
      user.id,
      j.version,
      j.id,
      numbers,
      j.id,
      numbers,
    ),
    stmt(
      db,
      `INSERT INTO history_imports(id,owner_id,request_id,confirm_hash,commit_token,source,preview_id,preview_version,receipt_json,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
      importId,
      user.id,
      `job_${j.id}_${j.version}`,
      digest(canonical({ jobId: j.id, version: j.version, rows: plan })),
      mutation,
      plan[0].source,
      j.preview_id,
      j.preview_version,
      JSON.stringify(receiptValue),
      importedAt,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `INSERT OR IGNORE INTO history_archive_refs(source,ref_hash,reference,mode) SELECT json_extract(value,'$.source'),json_extract(value,'$.refHash'),json_extract(value,'$.ref'),json_extract(value,'$.mode') FROM json_each(?) WHERE json_extract(value,'$.disposition')='import' AND ${guard}`,
      packed,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `INSERT INTO history_archive(id,import_id,source,ref_hash,line_key,client_id,evidence_hash,source_status,completion_state,date,start_minute,duration,record_json,imported_at) SELECT x.archive_id,?,json_extract(x.plan_json,'$.source'),x.ref_hash,x.line_key,x.client_id,x.evidence_hash,json_extract(x.record_json,'$.sourceStatus'),json_extract(x.plan_json,'$.completionState'),json_extract(x.record_json,'$.scheduledLocalDate'),json_extract(x.record_json,'$.startMinute'),json_extract(x.record_json,'$.durationMinutes'),x.record_json,? FROM history_import_job_rows x WHERE x.job_id=? AND x.row_num IN(SELECT value FROM json_each(?)) AND x.disposition='import' AND ${guard}`,
      importId,
      importedAt,
      j.id,
      numbers,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `UPDATE history_import_job_rows SET processed=1 WHERE job_id=? AND row_num IN(SELECT value FROM json_each(?)) AND ${guard}`,
      j.id,
      numbers,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `UPDATE history_import_jobs SET archive_revision=${archiveClock} WHERE id=? AND mutation_token=?`,
      j.id,
      mutation,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'history_job_step','history_import_job',?,?,? WHERE ${guard}`,
      user.id,
      j.id,
      JSON.stringify({
        created,
        duplicates,
        processed: j.processed + plan.length,
        total: j.total,
        importId,
      }),
      importedAt,
      j.id,
      mutation,
    ),
    receipt(db, j, body, "step", mutation),
  ]);
  return afterMutation(db, user, j, body, "step");
}
async function cancel(db, user, j, body) {
  if (body.version !== j.version)
    fail(409, "This import job changed. Reload its saved progress.");
  if (["completed", "cancelled"].includes(j.phase))
    fail(409, "This job has already finished.");
  const mutation = randomUUID();
  await db.batch([
    stmt(
      db,
      `UPDATE history_import_jobs SET phase='cancelled',reason='Cancelled by owner. Previously imported rows remain saved.',expires_at=NULL,version=version+1,updated_at=?,mutation_token=? WHERE id=? AND owner_id=? AND version=?`,
      Date.now(),
      mutation,
      j.id,
      user.id,
      j.version,
    ),
    receipt(db, j, body, "cancel", mutation),
  ]);
  return afterMutation(db, user, j, body, "cancel");
}
async function detail(db, j, url) {
  const text = url.searchParams.get("page") ?? "0";
  if (!/^\d{1,5}$/.test(text)) fail(400, "Choose a valid review page.");
  const filter = url.searchParams.get("filter") ?? "all";
  if (!["all", "blocked"].includes(filter))
    fail(400, "Choose all rows or rows needing attention.");
  const clause = filter === "blocked" ? " AND disposition='blocked'" : "";
  const filteredTotal =
    filter === "blocked" ? JSON.parse(j.counts_json).blocked : j.total;
  const page = Number(text),
    size = await stmt(
      db,
      `SELECT COALESCE(SUM(n),0) AS bytes FROM(SELECT length(CAST(review_json AS BLOB)) AS n FROM history_import_job_rows WHERE job_id=?${clause} ORDER BY row_num LIMIT 50 OFFSET ?)`,
      j.id,
      page * 50,
    ).first();
  if (size.bytes > HISTORY_BULK_LIMITS.pageBytes)
    fail(
      422,
      "This review page contains unusually large source labels. No rows were truncated.",
    );
  const rows = (
    await stmt(
      db,
      `SELECT review_json,archive_id,disposition,processed FROM history_import_job_rows WHERE job_id=?${clause} ORDER BY row_num LIMIT 50 OFFSET ?`,
      j.id,
      page * 50,
    ).all()
  ).results.map((r) => ({
    ...JSON.parse(r.review_json),
    result: r.processed
      ? {
          id: r.archive_id,
          disposition: r.disposition === "import" ? "imported" : "duplicate",
        }
      : null,
  }));
  return json({
    job: await project(db, j),
    rows,
    page,
    pageSize: 50,
    totalPages: Math.ceil(filteredTotal / 50),
    filter,
    filteredTotal,
  });
}
export async function historyBulkRoutes(request, db, user) {
  const url = new URL(request.url),
    match = url.pathname.match(
      /^\/api\/history\/jobs(?:\/([a-f0-9-]{36})(?:\/(step|confirm|cancel))?)?$/,
    );
  if (!url.pathname.startsWith("/api/history/jobs")) return null;
  requireRole(user, "owner");
  if (!match) fail(404, "History import job action not found.");
  await ensureClientContacts(db);
  await ensureClientTransferSchema(db);
  await ensureHistoryPreviewSchema(db);
  await ensureHistoryArchiveSchema(db);
  await ensureHistoryBulkSchema(db);
  const [, id, op] = match;
  if (!id && request.method === "POST")
    return start(db, user, await readJSON(request, 4000));
  if (!id && request.method === "GET") {
    const jobs = (
      await stmt(
        db,
        "SELECT * FROM history_import_jobs WHERE owner_id=? ORDER BY CASE WHEN phase IN('reviewing','ready','importing') AND (expires_at IS NULL OR expires_at>?) THEN 0 ELSE 1 END,created_at DESC,id LIMIT 20",
        user.id,
        Date.now(),
      ).all()
    ).results;
    return json({
      jobs: await Promise.all(jobs.map((j) => project(db, j, true))),
    });
  }
  if (!id) fail(405, "Use GET or POST for import jobs.");
  const j = await find(db, user, id);
  if (!op && request.method === "GET") return detail(db, j, url);
  if (!op || request.method !== "POST")
    fail(405, "Use POST for this import job action.");
  const body = await readJSON(request, 4000);
  validate(body, [
    "version",
    "requestId",
    ...(op === "confirm" ? ["confirmationToken", "acknowledgeReview"] : []),
  ]);
  const repeated = await replay(db, user, j, body, op);
  if (repeated) return repeated;
  if (op === "cancel") return cancel(db, user, j, body);
  if (!(await current(db, user, j, body))) {
    if (["reviewing", "ready", "importing"].includes(j.phase))
      return pause(
        db,
        user,
        j,
        "Clients, source choices, archived history or native appointments changed or expired. Prepare a new complete review. Already imported rows remain saved.",
      );
    fail(
      409,
      "This job cannot continue. Reload its saved outcome or start a new complete review.",
    );
  }
  if (op === "confirm") return confirmJob(db, user, j, body);
  if (j.phase === "reviewing") return prepareStep(db, user, j, body);
  if (j.phase === "importing") return importStep(db, user, j, body);
  fail(409, "Review the complete result and confirm once before importing.");
}
