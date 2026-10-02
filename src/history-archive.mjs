import { randomUUID } from "node:crypto";
import { digest, fail, readJSON, requireRole, token } from "./security.mjs";
import { ensureClientContacts } from "./client-contacts.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";
import { ensureHistoryPreviewSchema } from "./history-preview-schema.mjs";
import { ensureHistoryArchiveSchema } from "./history-archive-schema.mjs";
import {
  historyPreviewSnapshots,
  historyPreviewContactKey,
} from "./history-preview.mjs";
import { planHistoryImport } from "./history-import-plan.mjs";

export const HISTORY_ARCHIVE_LIMITS = Object.freeze({
  selection: 50,
  pageSize: 25,
  reviewTtl: 15 * 60 * 1000,
  selectionBytes: 4 * 1048576,
  reviewBytes: 1900000,
});
const stmt = (db, q, ...args) => db.prepare(q).bind(...args);
const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
const fold = (value) =>
  (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const sourceKey = (value) => fold(value);
const clientClock = "(SELECT revision FROM client_transfer_state WHERE id=1)";
const archiveClock = "(SELECT revision FROM history_archive_state WHERE id=1)";
const severe = new Set([
  "time_ambiguous",
  "time_nonexistent",
  "cancelled_before_created",
  "cancellation_status_mismatch",
  "completion_conflict",
]);
const privateWarning =
  "Historical source evidence only. Unknown timezone, currency, request and completion stay unknown. No live booking, payment, report or bonus is created.";
const statusCounts = (rows) => {
  const counts = new Map();
  for (const r of rows)
    counts.set(
      r.sourceStatus ?? null,
      (counts.get(r.sourceStatus ?? null) ?? 0) + 1,
    );
  return [...counts]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => (a.status ?? "").localeCompare(b.status ?? ""));
};
function input(body, confirm = false) {
  const allowed = [
    "previewId",
    "version",
    "rows",
    "requestId",
    ...(confirm ? ["confirmationToken", "acknowledgeReview"] : []),
  ];
  if (
    Object.keys(body).some((k) => !allowed.includes(k)) ||
    typeof body.previewId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(body.previewId) ||
    !Number.isSafeInteger(body.version) ||
    body.version < 1 ||
    typeof body.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(body.requestId) ||
    !Array.isArray(body.rows) ||
    !body.rows.length ||
    body.rows.length > 50 ||
    new Set(body.rows).size !== body.rows.length ||
    body.rows.some((n) => !Number.isInteger(n) || n < 2 || n > 50001)
  )
    fail(
      400,
      "Select 1–50 distinct source rows with a preview version and request ID.",
    );
  if (
    confirm &&
    (body.acknowledgeReview !== true ||
      typeof body.confirmationToken !== "string" ||
      body.confirmationToken.length > 100)
  )
    fail(
      400,
      "Review and explicitly acknowledge the selected historical evidence before importing.",
    );
  return {
    previewId: body.previewId,
    version: body.version,
    rows: body.rows,
    requestId: body.requestId,
  };
}
function evidence(record) {
  return digest(
    canonical(
      Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => !["row", "fileDigest", "issues"].includes(key),
        ),
      ),
    ),
  );
}
function add(entry, code, field, message, severity = "error") {
  if (!entry.issues.some((i) => i.code === code))
    entry.issues.push({ code, field, severity, message });
  if (severity === "error") entry.disposition = "blocked";
}
function completion(record) {
  return ["new", "confirmed", "started"].includes(fold(record.sourceStatus))
    ? "unknown"
    : record.completionState;
}
async function preview(db, user, body) {
  const r = await stmt(
    db,
    "SELECT * FROM history_previews WHERE id=? AND owner_id=?",
    body.previewId,
    user.id,
  ).first();
  if (!r) fail(404, "History preview not found.");
  if (r.expires_at <= Date.now())
    fail(410, "This history preview expired. Read the CSV again.");
  if (r.phase !== "ready" || r.version !== body.version)
    fail(
      409,
      "This history preview changed. Reload it before reviewing the import.",
    );
  const clock = await stmt(
    db,
    "SELECT revision FROM client_transfer_state WHERE id=1",
  ).first();
  if (r.client_revision !== clock.revision)
    fail(
      409,
      "Client list changed. Rebuild the preview before importing history.",
    );
  return r;
}
async function review(db, user, body) {
  const base = input(body),
    inputHash = digest(canonical(base));
  const previous = await stmt(
    db,
    "SELECT * FROM history_import_reviews WHERE owner_id=? AND request_id=?",
    user.id,
    base.requestId,
  ).first();
  if (previous) {
    if (previous.input_hash !== inputHash)
      fail(
        409,
        "This import request ID was already used for another selection.",
      );
    if (previous.expires_at <= Date.now())
      fail(410, "This import review expired. Prepare a new review.");
    await preview(db, user, body);
    return json({ ...JSON.parse(previous.response_json), repeated: true });
  }
  if (
    await stmt(
      db,
      "SELECT id FROM history_imports WHERE owner_id=? AND request_id=?",
      user.id,
      base.requestId,
    ).first()
  )
    fail(
      409,
      "This request already has an import receipt. Retry its original confirmation to retrieve it.",
    );
  const p = await preview(db, user, base),
    selection = JSON.stringify(base.rows);
  const size = await stmt(
    db,
    "SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(record_json AS BLOB))),0) AS bytes FROM history_preview_rows WHERE preview_id=? AND row_num IN(SELECT value FROM json_each(?))",
    p.id,
    selection,
  ).first();
  if (size.n !== base.rows.length)
    fail(400, "Select source rows present in this preview.");
  if (size.bytes > HISTORY_ARCHIVE_LIMITS.selectionBytes)
    fail(
      422,
      "The selected source evidence is unusually large. Review fewer rows at once.",
    );
  const selected = (
    await stmt(
      db,
      `SELECT x.*,c.id AS selected_client_id,c.name AS client_name,c.version AS client_version FROM history_preview_rows x LEFT JOIN clients c ON c.id=x.draft_client_id WHERE x.preview_id=? AND x.row_num IN(SELECT value FROM json_each(?))`,
      p.id,
      selection,
    ).all()
  ).results;
  const byRow = new Map(selected.map((r) => [r.row_num, r])),
    config = JSON.parse(p.config_json),
    mode =
      config.referenceMode === "service-line" ? "service-line" : "appointment",
    source = sourceKey(p.source);
  const refs = [
    ...new Set(
      selected
        .map((r) => JSON.parse(r.record_json).sourceAppointmentRef?.trim())
        .filter(Boolean),
    ),
  ];
  // These aggregates cover every matching row in the complete preview, including
  // unselected pages. Never infer a service line from treatment name or position.
  const grouped = (
    await stmt(
      db,
      `SELECT trim(json_extract(record_json,'$.sourceAppointmentRef')) AS ref,${mode === "service-line" ? "COALESCE(trim(json_extract(record_json,'$.sourceServiceLineRef')),'')" : "''"} AS line,MIN(payload_digest) AS min_digest,MAX(payload_digest) AS max_digest,MIN(draft_client_id) AS min_client,MAX(draft_client_id) AS max_client,COUNT(*) AS n FROM history_preview_rows WHERE preview_id=? AND trim(json_extract(record_json,'$.sourceAppointmentRef')) IN(SELECT value FROM json_each(?)) GROUP BY ref,line LIMIT 2001`,
      p.id,
      JSON.stringify(refs),
    ).all()
  ).results;
  if (grouped.length > 2000)
    fail(
      422,
      "Too many service lines share these references. Review a smaller source file; no evidence was truncated.",
    );
  const refHashes = refs.map(digest);
  const prepared = base.rows.map((n) => {
    const stored = byRow.get(n),
      record = JSON.parse(stored.record_json),
      ref = record.sourceAppointmentRef?.trim() ?? "",
      line = record.sourceServiceLineRef?.trim() ?? "";
    const entry = {
      row: n,
      id: randomUUID(),
      source,
      ref,
      refHash: digest(ref),
      lineKey: mode === "service-line" ? "line:" + digest(line) : "",
      mode,
      clientId: stored.draft_client_id,
      clientVersion: stored.draft_client_version,
      evidenceHash: evidence(record),
      completionState: completion(record),
      record,
      client: stored.selected_client_id
        ? {
            id: stored.selected_client_id,
            name: stored.client_name,
            version: stored.client_version,
          }
        : null,
      disposition: "import",
      issues: record.issues.map((i) => ({ ...i })),
      nativeOverlapIds: [],
    };
    if (entry.issues.some((i) => i.severity === "error" || severe.has(i.code)))
      entry.disposition = "blocked";
    if (!ref)
      add(
        entry,
        "reference_missing",
        "sourceAppointmentRef",
        "A source appointment reference is required for duplicate protection.",
      );
    if (mode === "service-line" && !line)
      add(
        entry,
        "service_line_missing",
        "sourceServiceLineRef",
        "Service-line imports require an explicit source service-line ID.",
      );
    if (
      !stored.selected_client_id ||
      stored.client_version !== stored.draft_client_version
    )
      add(
        entry,
        "client_choice_stale",
        "clientId",
        "Save a current, explicit client draft choice for this source row.",
      );
    const groups = grouped.filter((g) => g.ref === ref);
    if (
      groups.some(
        (g) =>
          (mode === "appointment" || g.line === line) &&
          (g.min_digest !== g.max_digest ||
            (g.min_client && g.max_client && g.min_client !== g.max_client)),
      ) ||
      (mode === "service-line" && groups.some((g) => !g.line))
    )
      add(
        entry,
        "ambiguous_reference",
        "sourceAppointmentRef",
        "This reference has ambiguous or changed content/client choices elsewhere in the complete CSV. Correct the source or provide unambiguous service-line IDs.",
      );
    if (config.referenceMode === "unverified")
      add(
        entry,
        "conservative_reference",
        "sourceAppointmentRef",
        "This reference will be reserved as one appointment. Any different content or later service-line interpretation will require separate correction review.",
        "review",
      );
    if (
      entry.client &&
      fold(entry.client.name) !== fold(record.sourceClientLabel)
    )
      add(
        entry,
        "selected_name_differs",
        "clientId",
        "The chosen client name differs from the original source label. Confirm the selected person.",
        "review",
      );
    if (completion(record) !== record.completionState)
      add(
        entry,
        "completion_not_proven",
        "status",
        "New, Confirmed and Started are retained with unknown completion, regardless of a supplied completion mapping.",
        "review",
      );
    return entry;
  });
  const identitySnapshot = await historyPreviewSnapshots(
    db,
    { ...p, source },
    prepared.map((e) => e.record),
    selected,
  );
  // Archive namespace aliases use the same canonical source when consulting
  // permanent client links, while the original label remains source evidence.
  identitySnapshot.sourceLinks = identitySnapshot.sourceLinks.map((link) => ({
    ...link,
    source: p.source,
  }));
  let identities;
  try {
    identities = planHistoryImport({
      rows: prepared.map((e) => e.record),
      ...identitySnapshot,
      referenceMode: config.referenceMode,
    }).rows;
  } catch {
    fail(
      422,
      "Source or client identity evidence cannot be interpreted safely. Correct it before importing.",
    );
  }
  for (let i = 0; i < prepared.length; i++) {
    const entry = prepared[i],
      resolved = identities[i],
      chosen = identitySnapshot.clients.find((c) => c.id === entry.clientId);
    for (const issue of resolved.issues.filter(
      (i) => i.code === "invalid_contact",
    ))
      add(entry, issue.code, issue.field, issue.message);
    if (
      resolved.identity.state === "conflict" ||
      (resolved.identity.state === "linked" &&
        resolved.identity.clientId !== entry.clientId) ||
      (resolved.identity.method === "contact" &&
        resolved.identity.candidates.length &&
        !resolved.identity.candidates.includes(entry.clientId)) ||
      (chosen &&
        ["phone", "email", "instagram"].some((field) => {
          const source = historyPreviewContactKey(field, entry.record[field]),
            target = historyPreviewContactKey(field, chosen[field]);
          return source && target && source !== target;
        }))
    )
      add(
        entry,
        "identity_evidence_conflict",
        "clientId",
        "The chosen client contradicts a verified source identity or supplied contact evidence. Correct that conflict before importing.",
      );
  }
  const keys = JSON.stringify(
    prepared.map((e) => ({ ref: e.refHash, line: e.lineKey })),
  );
  const [clocks, existing, natives, registry] = await db.batch([
    stmt(
      db,
      `SELECT ${clientClock} AS client_revision,${archiveClock} AS archive_revision`,
    ),
    stmt(
      db,
      `SELECT a.id,a.ref_hash,a.line_key,a.client_id,a.evidence_hash FROM json_each(?) k CROSS JOIN history_archive a ON a.source=? AND a.ref_hash=json_extract(k.value,'$.ref') AND a.line_key=json_extract(k.value,'$.line')`,
      keys,
      source,
    ),
    stmt(
      db,
      `SELECT x.row_num,a.id FROM history_preview_rows x JOIN appointments a ON a.client_id=x.draft_client_id AND a.date=json_extract(x.record_json,'$.scheduledLocalDate') AND a.start_minute<json_extract(x.record_json,'$.startMinute')+json_extract(x.record_json,'$.durationMinutes') AND json_extract(x.record_json,'$.startMinute')<a.start_minute+a.duration WHERE x.preview_id=? AND x.row_num IN(SELECT value FROM json_each(?)) LIMIT 2001`,
      p.id,
      selection,
    ),
    stmt(
      db,
      "SELECT * FROM history_archive_refs WHERE source=? AND ref_hash IN(SELECT value FROM json_each(?))",
      source,
      JSON.stringify(refHashes),
    ),
  ]);
  if (clocks.results[0].client_revision !== p.client_revision)
    fail(
      409,
      "Client list changed. Rebuild the preview before importing history.",
    );
  if (natives.results.length > 2000)
    fail(
      422,
      "Too many native overlaps match the selection; none were truncated.",
    );
  const existingKeys = new Map(
    existing.results.map((e) => [JSON.stringify([e.ref_hash, e.line_key]), e]),
  );
  const registered = new Map(registry.results.map((r) => [r.ref_hash, r]));
  for (const entry of prepared) {
    if (
      registered.has(entry.refHash) &&
      registered.get(entry.refHash).mode !== mode
    )
      add(
        entry,
        "reference_mode_conflict",
        "sourceAppointmentRef",
        "This source reference was archived under a different reference mode. It cannot be imported again under another mode.",
      );
    entry.nativeOverlapIds = natives.results
      .filter((a) => a.row_num === entry.row)
      .map((a) => a.id);
    if (entry.nativeOverlapIds.length)
      add(
        entry,
        "native_overlap",
        "clientId",
        "An existing Rei appointment overlaps this source row for the chosen client. Resolve that overlap before importing.",
      );
    const k = JSON.stringify([entry.refHash, entry.lineKey]),
      previous = existingKeys.get(k);
    if (previous) {
      if (
        previous.evidence_hash !== entry.evidenceHash ||
        previous.client_id !== entry.clientId
      )
        add(
          entry,
          "archive_conflict",
          "sourceAppointmentRef",
          "This source key is already represented with different evidence or a different client. Nothing will be overwritten.",
        );
      else if (entry.disposition !== "blocked") {
        entry.disposition = "duplicate";
        entry.id = previous.id;
      }
    } else if (entry.disposition !== "blocked")
      existingKeys.set(k, {
        id: entry.id,
        evidence_hash: entry.evidenceHash,
        client_id: entry.clientId,
      });
  }
  const rows = prepared.map((e) => ({
    row: e.row,
    client: e.client,
    sourceStatus: e.record.sourceStatus,
    date: e.record.scheduledLocalDate,
    start: e.record.startMinute,
    duration: e.record.durationMinutes,
    serviceName: e.record.sourceServiceLabel,
    therapistName: e.record.sourceTherapistLabel,
    completionState: e.completionState,
    disposition: e.disposition,
    blockReason:
      e.disposition !== "blocked"
        ? null
        : e.issues.some(
              (i) =>
                (i.severity === "error" &&
                  ![
                    "client_choice_stale",
                    "ambiguous_reference",
                    "reference_mode_conflict",
                    "native_overlap",
                    "archive_conflict",
                    "identity_evidence_conflict",
                  ].includes(i.code)) ||
                severe.has(i.code),
            )
          ? "invalid"
          : e.issues.some((i) => i.code === "client_choice_stale")
            ? "unmatched"
            : "conflict",
    issues: e.issues,
    nativeOverlapIds: e.nativeOverlapIds,
  }));
  const counts = {
    selected: rows.length,
    importable: rows.filter((e) => e.disposition === "import").length,
    duplicates: rows.filter((e) => e.disposition === "duplicate").length,
    blocked: rows.filter((e) => e.disposition === "blocked").length,
    unmatched: rows.filter((e) => e.blockReason === "unmatched").length,
    conflicts: rows.filter((e) => e.blockReason === "conflict").length,
    invalid: rows.filter((e) => e.blockReason === "invalid").length,
  };
  const reviewId = randomUUID(),
    confirmationToken = token(),
    now = Date.now(),
    expiresAt = Math.min(now + HISTORY_ARCHIVE_LIMITS.reviewTtl, p.expires_at);
  const response = {
    reviewId,
    confirmationToken,
    expiresAt,
    previewId: p.id,
    version: p.version,
    requestId: base.requestId,
    canConfirm: counts.blocked === 0,
    counts,
    statusCounts: statusCounts(rows),
    rows,
    warnings: [privateWarning],
  };
  const plan = prepared.map(
    ({ record, issues, client, nativeOverlapIds, ...entry }) => entry,
  );
  if (
    Buffer.byteLength(JSON.stringify(response)) >
      HISTORY_ARCHIVE_LIMITS.reviewBytes ||
    Buffer.byteLength(JSON.stringify(plan)) > HISTORY_ARCHIVE_LIMITS.reviewBytes
  )
    fail(
      422,
      "The selected review is unusually large. Review fewer source rows at once.",
    );
  await db.batch([
    stmt(db, "DELETE FROM history_import_reviews WHERE expires_at<=?", now),
    stmt(
      db,
      `INSERT OR IGNORE INTO history_import_reviews(id,owner_id,request_id,input_hash,token_hash,preview_id,preview_version,client_revision,archive_revision,source,plan_json,response_json,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM history_previews WHERE id=? AND owner_id=? AND version=? AND phase='ready' AND expires_at>? AND client_revision=${clientClock}) AND ${archiveClock}=?`,
      reviewId,
      user.id,
      base.requestId,
      inputHash,
      digest(confirmationToken),
      p.id,
      p.version,
      p.client_revision,
      clocks.results[0].archive_revision,
      source,
      JSON.stringify(plan),
      JSON.stringify(response),
      now,
      expiresAt,
      p.id,
      user.id,
      p.version,
      now,
      clocks.results[0].archive_revision,
    ),
  ]);
  const saved = await stmt(
    db,
    "SELECT input_hash,response_json FROM history_import_reviews WHERE owner_id=? AND request_id=?",
    user.id,
    base.requestId,
  ).first();
  if (!saved || saved.input_hash !== inputHash)
    fail(
      409,
      "The selection or archive changed while preparing this review. Prepare a new review.",
    );
  return json(JSON.parse(saved.response_json));
}

async function confirm(db, user, body) {
  const base = input(body, true),
    confirmHash = digest(canonical(body));
  const receipt = async () => {
    const saved = await stmt(
      db,
      "SELECT confirm_hash,receipt_json FROM history_imports WHERE owner_id=? AND request_id=?",
      user.id,
      body.requestId,
    ).first();
    if (!saved) return null;
    if (saved.confirm_hash !== confirmHash)
      fail(
        409,
        "This request already imported another confirmation payload. Nothing was changed.",
      );
    return JSON.parse(saved.receipt_json);
  };
  const repeated = await receipt();
  if (repeated) return json({ ...repeated, repeated: true });
  const r = await stmt(
    db,
    "SELECT * FROM history_import_reviews WHERE owner_id=? AND request_id=?",
    user.id,
    base.requestId,
  ).first();
  if (!r) fail(404, "Import review not found. Prepare the selection again.");
  if (
    r.input_hash !== digest(canonical(base)) ||
    r.token_hash !== digest(body.confirmationToken)
  )
    fail(409, "The confirmation does not match its reviewed selection.");
  if (r.expires_at <= Date.now())
    fail(410, "This import review expired. Prepare a new review.");
  const response = JSON.parse(r.response_json),
    plan = JSON.parse(r.plan_json);
  if (!response.canConfirm)
    fail(409, "Resolve every blocked source row before confirming this batch.");
  await preview(db, user, base);
  const importId = randomUUID(),
    commitToken = randomUUID(),
    importedAt = new Date().toISOString();
  const result = {
    importId,
    created: response.counts.importable,
    duplicates: response.counts.duplicates,
    statusCounts: response.statusCounts,
    rows: plan.map((e) => ({
      row: e.row,
      id: e.id,
      disposition: e.disposition === "import" ? "imported" : "duplicate",
    })),
  };
  const packed = r.plan_json,
    guard = `EXISTS(SELECT 1 FROM history_imports WHERE id=? AND commit_token=?)`;
  await db.batch([
    stmt(
      db,
      `INSERT OR IGNORE INTO history_imports(id,owner_id,request_id,confirm_hash,commit_token,source,preview_id,preview_version,receipt_json,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM history_previews WHERE id=? AND owner_id=? AND version=? AND phase='ready' AND expires_at>? AND client_revision=${clientClock}) AND ${clientClock}=? AND ${archiveClock}=? AND EXISTS(SELECT 1 FROM history_import_reviews WHERE id=? AND owner_id=? AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM json_each(?) p LEFT JOIN clients c ON c.id=json_extract(p.value,'$.clientId') WHERE c.id IS NULL OR c.version!=json_extract(p.value,'$.clientVersion')) AND NOT EXISTS(SELECT 1 FROM history_preview_rows x JOIN appointments a ON a.client_id=x.draft_client_id AND a.date=json_extract(x.record_json,'$.scheduledLocalDate') AND a.start_minute<json_extract(x.record_json,'$.startMinute')+json_extract(x.record_json,'$.durationMinutes') AND json_extract(x.record_json,'$.startMinute')<a.start_minute+a.duration WHERE x.preview_id=? AND x.row_num IN(SELECT value FROM json_each(?)))`,
      importId,
      user.id,
      body.requestId,
      confirmHash,
      commitToken,
      r.source,
      r.preview_id,
      r.preview_version,
      JSON.stringify(result),
      importedAt,
      r.preview_id,
      user.id,
      r.preview_version,
      Date.now(),
      r.client_revision,
      r.archive_revision,
      r.id,
      user.id,
      Date.now(),
      packed,
      r.preview_id,
      JSON.stringify(base.rows),
    ),
    stmt(
      db,
      `INSERT OR IGNORE INTO history_archive_refs(source,ref_hash,reference,mode) SELECT ?,json_extract(value,'$.refHash'),json_extract(value,'$.ref'),json_extract(value,'$.mode') FROM json_each(?) WHERE json_extract(value,'$.disposition')='import' AND ${guard}`,
      r.source,
      packed,
      importId,
      commitToken,
    ),
    stmt(
      db,
      `INSERT INTO history_archive(id,import_id,source,ref_hash,line_key,client_id,evidence_hash,source_status,completion_state,date,start_minute,duration,record_json,imported_at) SELECT json_extract(p.value,'$.id'),?,?,json_extract(p.value,'$.refHash'),json_extract(p.value,'$.lineKey'),json_extract(p.value,'$.clientId'),json_extract(p.value,'$.evidenceHash'),json_extract(x.record_json,'$.sourceStatus'),json_extract(p.value,'$.completionState'),json_extract(x.record_json,'$.scheduledLocalDate'),json_extract(x.record_json,'$.startMinute'),json_extract(x.record_json,'$.durationMinutes'),x.record_json,? FROM json_each(?) p JOIN history_preview_rows x ON x.preview_id=? AND x.row_num=json_extract(p.value,'$.row') WHERE json_extract(p.value,'$.disposition')='import' AND ${guard}`,
      importId,
      r.source,
      importedAt,
      packed,
      r.preview_id,
      importId,
      commitToken,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'history_import','history_import',?,?,? WHERE ${guard}`,
      user.id,
      importId,
      JSON.stringify({
        created: result.created,
        duplicates: result.duplicates,
        source: r.source,
        statusCounts: result.statusCounts,
      }),
      importedAt,
      importId,
      commitToken,
    ),
  ]);
  const saved = await receipt();
  if (!saved)
    fail(
      409,
      "The preview, client, archive or native appointments changed. Prepare a new import review; nothing was imported.",
    );
  return json(
    { ...saved, repeated: saved.importId !== importId },
    saved.importId === importId ? 201 : 200,
  );
}

async function clientHistory(db, user, clientId, url) {
  requireRole(user, "owner", "reception");
  const pageText = url.searchParams.get("page") ?? "0";
  if (!/^\d{1,7}$/.test(pageText)) fail(400, "Choose a valid history page.");
  const page = Number(pageText);
  if (!(await stmt(db, "SELECT id FROM clients WHERE id=?", clientId).first()))
    fail(404, "Client not found.");
  if (user.role === "owner") {
    const size = await stmt(
      db,
      "SELECT COALESCE(SUM(n),0) AS bytes FROM (SELECT length(CAST(record_json AS BLOB)) AS n FROM history_archive WHERE client_id=? ORDER BY date DESC,start_minute DESC,id LIMIT 25 OFFSET ?)",
      clientId,
      page * 25,
    ).first();
    if (size.bytes > HISTORY_ARCHIVE_LIMITS.selectionBytes)
      fail(
        422,
        "This historical page contains unusually large source evidence. It cannot be returned safely; nothing was truncated.",
      );
  }
  const [count, groups, data] = await db.batch([
    stmt(
      db,
      "SELECT COUNT(*) AS total FROM history_archive WHERE client_id=?",
      clientId,
    ),
    stmt(
      db,
      "SELECT source_status AS status,COUNT(*) AS count FROM history_archive WHERE client_id=? GROUP BY source_status ORDER BY source_status LIMIT 201",
      clientId,
    ),
    stmt(
      db,
      `SELECT ${user.role === "owner" ? "*" : "id,date,start_minute,duration,source_status,completion_state,imported_at,json_extract(record_json,'$.sourceServiceLabel') AS service_name,json_extract(record_json,'$.sourceTherapistLabel') AS therapist_name,json_extract(record_json,'$.sourceRoomLabel') AS room_name,json_extract(record_json,'$.requestState') AS request_state"} FROM history_archive WHERE client_id=? ORDER BY date DESC,start_minute DESC,id LIMIT 25 OFFSET ?`,
      clientId,
      page * 25,
    ),
  ]);
  const total = count.results[0].total,
    totalPages = Math.ceil(total / 25);
  if (groups.results.length > 200)
    fail(
      422,
      "This client has unusually many distinct source statuses. No status counts were truncated.",
    );
  if (page > 0 && page >= totalPages) fail(400, "Choose a valid history page.");
  const rows = data.results.map((r) => {
    const record = user.role === "owner" ? JSON.parse(r.record_json) : null;
    const safe = {
      id: r.id,
      date: r.date,
      start: r.start_minute,
      duration: r.duration,
      serviceName: record?.sourceServiceLabel ?? r.service_name ?? null,
      therapistName: record?.sourceTherapistLabel ?? r.therapist_name ?? null,
      roomName: record?.sourceRoomLabel ?? r.room_name ?? null,
      sourceStatus: r.source_status,
      completionState: r.completion_state,
      requestState: record?.requestState ?? r.request_state,
      importedAt: r.imported_at,
    };
    return user.role === "owner"
      ? {
          ...safe,
          record,
          provenance: {
            source: r.source,
            appointmentRef: record.sourceAppointmentRef,
            serviceLineRef: record.sourceServiceLineRef,
            fileDigest: record.fileDigest,
            fileDigestVerification: "claimed-original-file",
            sourceRow: record.row,
            importId: r.import_id,
          },
          sourceNetSalesMinor: record.sourceNetSalesMinor,
          currency: record.currency,
        }
      : safe;
  });
  return json({
    clientId,
    page,
    pageSize: 25,
    total,
    totalPages,
    statusCounts: groups.results,
    rows,
  });
}

export async function historyArchiveRoutes(request, db, user) {
  const url = new URL(request.url),
    path = url.pathname,
    client = path.match(/^\/api\/clients\/([^/]+)\/history$/);
  if (!client && !path.startsWith("/api/history/imports/")) return null;
  requireRole(user, ...(client ? ["owner", "reception"] : ["owner"]));
  await ensureClientContacts(db);
  await ensureClientTransferSchema(db);
  await ensureHistoryPreviewSchema(db);
  await ensureHistoryArchiveSchema(db);
  if (client && request.method === "GET")
    return clientHistory(db, user, decodeURIComponent(client[1]), url);
  if (request.method !== "POST")
    fail(405, "Use POST for this history import action.");
  if (path === "/api/history/imports/review")
    return review(db, user, await readJSON(request, 16000));
  if (path === "/api/history/imports/confirm")
    return confirm(db, user, await readJSON(request, 17000));
  fail(404, "History import action not found.");
}

// The durable whole-file workflow reuses this authoritative bounded review.
export { review as historyArchiveReview };
