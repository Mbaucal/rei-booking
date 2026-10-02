import { randomUUID } from "node:crypto";
import { digest, fail, readJSON, requireRole } from "./security.mjs";
import { email, phoneKey } from "./domain.mjs";
import { ensureClientContacts, instagramHandle } from "./client-contacts.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";
import { ensureHistoryPreviewSchema } from "./history-preview-schema.mjs";
import { HISTORY_LIMITS, normalizeHistoryRows } from "./history-normalize.mjs";
import { planHistoryImport } from "./history-import-plan.mjs";

export const HISTORY_PREVIEW_LIMITS = Object.freeze({
  rows: 50000,
  bytes: 25 * 1048576,
  chunkRows: 100,
  chunkBytes: 2 * 1048576,
  pageSize: 50,
  indexStep: 1000,
  indexedClients: 100000,
  candidates: 1000,
  nativeAppointments: 2000,
  pageBytes: 4 * 1048576,
  retained: 3,
  ttl: 24 * 60 * 60 * 1000,
});
const P = "/api/history/previews";
const stmt = (db, q, ...args) => db.prepare(q).bind(...args);
const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const fold = (value) =>
  (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
const unique = (values) => [...new Set(values.filter(Boolean))];
const bytes = (values) =>
  values.reduce((n, v) => n + new TextEncoder().encode(v).byteLength + 1, 0);
const clientProjection = (c) =>
  c
    ? {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        instagram: c.instagram,
        version: c.version,
      }
    : null;
const clientSelect = `SELECT c.id,c.name,c.phone,c.email,c.version,COALESCE(i.instagram,'') AS instagram FROM clients c LEFT JOIN client_instagram i ON i.client_id=c.id`;
const clock = `(SELECT revision FROM client_transfer_state WHERE id=1)`;

function contact(field, value) {
  try {
    if (!value) return null;
    if (field === "phone") {
      const clean = value.trim(),
        n = clean.replace(/\D/g, "").length;
      if (!/^[+\d\s().-]+$/.test(clean) || n < 7 || n > 15 || clean.length > 30)
        return null;
      return phoneKey(clean);
    }
    return (
      (field === "email" ? email(value.trim()) : instagramHandle(value)) || null
    );
  } catch {
    return null;
  }
}
function meta(r) {
  return {
    id: r.id,
    version: r.version,
    total: r.total,
    uploaded: r.uploaded,
    phase: r.phase,
    expiresAt: r.expires_at,
    source: r.source,
    fileDigest: r.file_digest,
    fileBytes: r.file_bytes,
    receivedBytes: r.received_bytes,
    indexedClients: r.indexed_clients,
    totalPages: Math.ceil(r.total / 50),
    config: JSON.parse(r.config_json),
    provenance: {
      fileDigest: "claimed-original-file",
      contentDigests: "verified-canonical-upload-chunks",
    },
    imported: false,
  };
}
async function job(db, user, id) {
  const r = await stmt(
    db,
    "SELECT * FROM history_previews WHERE id=? AND owner_id=?",
    id,
    user.id,
  ).first();
  if (!r) fail(404, "History preview not found.");
  if (r.expires_at <= Date.now())
    fail(410, "This history preview expired. Read the CSV again.");
  return r;
}
function configInput(body) {
  if (
    !Number.isInteger(body.total) ||
    body.total < 1 ||
    body.total > HISTORY_LIMITS.rows ||
    !Number.isInteger(body.fileBytes) ||
    body.fileBytes < 1 ||
    body.fileBytes > HISTORY_LIMITS.bytes
  )
    fail(400, "Choose one CSV with 1–50,000 rows and at most 25 MiB.");
  const config = {
    headers: body.headers,
    mapping: body.mapping,
    format: body.format ?? {},
    referenceMode: body.referenceMode ?? "unverified",
  };
  if (
    !["unverified", "verified-appointment", "service-line"].includes(
      config.referenceMode,
    )
  )
    fail(400, "Choose a valid reference interpretation.");
  try {
    normalizeHistoryRows({
      ...config,
      rows: [],
      source: body.source,
      fileDigest: body.fileDigest,
    });
  } catch (e) {
    fail(400, e.message);
  }
  return config;
}
async function start(db, user, body) {
  const config = configInput(body),
    source = body.source.trim(),
    fileDigest = body.fileDigest.toLowerCase();
  const revision = (
    await stmt(
      db,
      "SELECT revision FROM client_transfer_state WHERE id=1",
    ).first()
  ).revision;
  const configHash = digest(
    canonical({
      config,
      source,
      fileDigest,
      total: body.total,
      fileBytes: body.fileBytes,
      revision,
    }),
  );
  const repeat = await stmt(
    db,
    `SELECT * FROM history_previews WHERE owner_id=? AND config_hash=? AND expires_at>? AND client_revision=${clock} ORDER BY created_at DESC LIMIT 1`,
    user.id,
    configHash,
    Date.now(),
  ).first();
  if (repeat) return json({ ...meta(repeat), repeated: true });
  const id = randomUUID(),
    now = Date.now();
  await db.batch([
    stmt(db, "DELETE FROM history_previews WHERE expires_at<=?", now),
    stmt(
      db,
      `INSERT OR IGNORE INTO history_previews(id,owner_id,source,file_digest,file_bytes,config_json,config_hash,total,received_bytes,client_revision,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,${clock},?,? WHERE ${clock}=?`,
      id,
      user.id,
      source,
      fileDigest,
      body.fileBytes,
      JSON.stringify(config),
      configHash,
      body.total,
      bytes(config.headers),
      now,
      now + HISTORY_PREVIEW_LIMITS.ttl,
      revision,
    ),
    stmt(
      db,
      `DELETE FROM history_previews WHERE owner_id=? AND id NOT IN(SELECT id FROM history_previews WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 3)`,
      user.id,
      user.id,
    ),
  ]);
  const saved = await stmt(
    db,
    "SELECT * FROM history_previews WHERE owner_id=? AND config_hash=?",
    user.id,
    configHash,
  ).first();
  if (!saved)
    fail(
      409,
      "The client list changed while starting this preview. Try again.",
    );
  return json(
    { ...meta(saved), repeated: saved.id !== id },
    saved.id === id ? 201 : 200,
  );
}
async function upload(db, user, r, body) {
  if (
    !Number.isInteger(body.offset) ||
    body.offset < 0 ||
    !Array.isArray(body.rows) ||
    !body.rows.length ||
    body.rows.length > 100 ||
    body.offset + body.rows.length > r.total
  )
    fail(400, "Upload the next block of at most 100 rows.");
  const hash = digest(canonical(body.rows));
  const repeated = await stmt(
    db,
    "SELECT digest FROM history_preview_chunks WHERE preview_id=? AND offset=?",
    r.id,
    body.offset,
  ).first();
  if (repeated) {
    if (repeated.digest !== hash)
      fail(409, "This uploaded block changed. Start a new preview.");
    return json({ ...meta(await job(db, user, r.id)), repeated: true });
  }
  if (r.phase !== "upload" || body.offset !== r.uploaded)
    fail(409, "Upload rows in order from the saved offset.");
  const config = JSON.parse(r.config_json);
  let records;
  try {
    records = normalizeHistoryRows({
      ...config,
      rows: body.rows,
      source: r.source,
      fileDigest: r.file_digest,
    }).rows;
  } catch (e) {
    fail(400, e.message);
  }
  records.forEach((row) => (row.row += body.offset));
  const received = body.rows.reduce((n, row) => n + bytes(row), 0);
  if (r.received_bytes + received > HISTORY_PREVIEW_LIMITS.bytes)
    fail(413, "Uploaded history exceeds the cumulative 25 MiB limit.");
  const planned = planHistoryImport({
    rows: records,
    referenceMode: config.referenceMode,
  });
  const packed = JSON.stringify(
    planned.rows.map((e) => ({
      row: e.record.row,
      record: e.record,
      key: e.sourceKey,
      hash: e.payloadDigest,
      invalid: e.disposition === "invalid" ? 1 : 0,
    })),
  );
  // Raw evidence and normalized labels can be larger than the HTTP cells.
  // Bound the D1 value too; retrying smaller chunks retains the same row offsets.
  if (new TextEncoder().encode(packed).byteLength > 1900000)
    fail(
      413,
      "The normalized upload block is too large. Retry with fewer rows.",
    );
  const token = randomUUID(),
    guard = `EXISTS(SELECT 1 FROM history_preview_chunks WHERE preview_id=? AND offset=? AND token=?)`;
  await db.batch([
    stmt(
      db,
      `INSERT INTO history_preview_chunks(preview_id,offset,row_count,digest,token) SELECT id,?,?,?,? FROM history_previews WHERE id=? AND owner_id=? AND phase='upload' AND expires_at>? AND uploaded=? AND received_bytes+?<=? AND NOT EXISTS(SELECT 1 FROM history_preview_chunks WHERE preview_id=? AND offset=?)`,
      body.offset,
      records.length,
      hash,
      token,
      r.id,
      user.id,
      Date.now(),
      body.offset,
      received,
      HISTORY_PREVIEW_LIMITS.bytes,
      r.id,
      body.offset,
    ),
    stmt(
      db,
      `INSERT INTO history_preview_rows(preview_id,row_num,record_json,source_key,payload_digest,invalid) SELECT ?,json_extract(value,'$.row'),json_extract(value,'$.record'),json_extract(value,'$.key'),json_extract(value,'$.hash'),json_extract(value,'$.invalid') FROM json_each(?) WHERE ${guard}`,
      r.id,
      packed,
      r.id,
      body.offset,
      token,
    ),
    stmt(
      db,
      `INSERT INTO history_preview_keys(preview_id,source_key,first_row,row_count,min_digest,max_digest) SELECT ?,json_extract(value,'$.key'),MIN(json_extract(value,'$.row')),COUNT(*),MIN(json_extract(value,'$.hash')),MAX(json_extract(value,'$.hash')) FROM json_each(?) WHERE ${guard} GROUP BY json_extract(value,'$.key') ON CONFLICT(preview_id,source_key) DO UPDATE SET first_row=MIN(first_row,excluded.first_row),row_count=row_count+excluded.row_count,min_digest=MIN(min_digest,excluded.min_digest),max_digest=MAX(max_digest,excluded.max_digest)`,
      r.id,
      packed,
      r.id,
      body.offset,
      token,
    ),
    stmt(
      db,
      `UPDATE history_previews SET uploaded=uploaded+?,received_bytes=received_bytes+?,version=version+1 WHERE id=? AND ${guard}`,
      records.length,
      received,
      r.id,
      r.id,
      body.offset,
      token,
    ),
  ]);
  const saved = await stmt(
    db,
    "SELECT digest FROM history_preview_chunks WHERE preview_id=? AND offset=?",
    r.id,
    body.offset,
  ).first();
  if (!saved || saved.digest !== hash)
    fail(409, "The upload changed. Reload its saved offset before retrying.");
  return json({
    ...meta(await job(db, user, r.id)),
    chunk: { offset: body.offset, digest: hash },
  });
}

async function finalize(db, user, r) {
  if (r.uploaded !== r.total)
    fail(409, "Upload the entire CSV before reviewing it.");
  const revision = (
    await stmt(
      db,
      `SELECT revision FROM client_transfer_state WHERE id=1`,
    ).first()
  ).revision;
  if (r.phase === "ready" && r.client_revision === revision)
    return json(meta(r));
  if (r.phase === "upload" || r.client_revision !== revision) {
    const token = randomUUID();
    await db.batch([
      stmt(
        db,
        `UPDATE history_previews SET phase='indexing',client_revision=${clock},index_cursor='',indexed_clients=0,version=version+1,mutation_token=? WHERE id=? AND version=? AND expires_at>?`,
        token,
        r.id,
        r.version,
        Date.now(),
      ),
      stmt(
        db,
        `DELETE FROM history_preview_clients WHERE preview_id=? AND EXISTS(SELECT 1 FROM history_previews WHERE id=? AND mutation_token=?)`,
        r.id,
        r.id,
        token,
      ),
    ]);
    r = await job(db, user, r.id);
  }
  const [clockResult, scan] = await db.batch([
    stmt(db, "SELECT revision FROM client_transfer_state WHERE id=1"),
    stmt(
      db,
      `${clientSelect} WHERE c.id>? ORDER BY c.id LIMIT 1001`,
      r.index_cursor,
    ),
  ]);
  if (clockResult.results[0].revision !== r.client_revision)
    fail(
      409,
      "Client list changed. Rebuild this preview before reviewing matches.",
    );
  const clients = scan.results.slice(0, 1000),
    more = scan.results.length > 1000;
  if (
    r.indexed_clients + clients.length >
    HISTORY_PREVIEW_LIMITS.indexedClients
  )
    fail(
      422,
      "This preview supports up to 100,000 client profiles. No history was imported.",
    );
  const packed = JSON.stringify(
    clients.map((c) => ({
      id: c.id,
      name: fold(c.name),
      phone: contact("phone", c.phone),
      email: contact("email", c.email),
      instagram: contact("instagram", c.instagram),
    })),
  );
  const token = randomUUID(),
    guard = `EXISTS(SELECT 1 FROM history_previews WHERE id=? AND mutation_token=?)`;
  await db.batch([
    stmt(
      db,
      `UPDATE history_previews SET phase=?,index_cursor=?,indexed_clients=indexed_clients+?,version=version+1,mutation_token=? WHERE id=? AND version=? AND phase='indexing' AND client_revision=${clock} AND expires_at>?`,
      more ? "indexing" : "ready",
      clients.at(-1)?.id ?? r.index_cursor,
      clients.length,
      token,
      r.id,
      r.version,
      Date.now(),
    ),
    stmt(
      db,
      `INSERT INTO history_preview_clients(preview_id,client_id,name_key,phone_key,email_key,instagram_key) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.phone'),json_extract(value,'$.email'),json_extract(value,'$.instagram') FROM json_each(?) WHERE ${guard}`,
      r.id,
      packed,
      r.id,
      token,
    ),
  ]);
  const saved = await job(db, user, r.id);
  if (
    saved.client_revision !==
    (
      await stmt(
        db,
        "SELECT revision FROM client_transfer_state WHERE id=1",
      ).first()
    ).revision
  )
    fail(
      409,
      "Client list changed. Rebuild this preview before reviewing matches.",
    );
  return json(meta(saved));
}

async function ready(db, r) {
  if (r.phase !== "ready")
    fail(
      409,
      "Finish uploading and preparing this preview before reviewing it.",
    );
  const revision = (
    await stmt(
      db,
      "SELECT revision FROM client_transfer_state WHERE id=1",
    ).first()
  ).revision;
  if (revision !== r.client_revision)
    fail(
      409,
      "Client list changed. Rebuild this preview before reviewing matches.",
    );
}
function pageIndex(value) {
  if (!/^\d{1,6}$/.test(value)) fail(400, "Choose a valid preview page.");
  return Number(value);
}
async function snapshots(db, r, records, stored) {
  const names = unique(records.map((c) => fold(c.sourceClientLabel))),
    keys = unique(
      records.map(
        (c) => c.sourceClientId && `id:${digest(c.sourceClientId.trim())}`,
      ),
    );
  const conditions = ["name", "phone", "email", "instagram"]
    .map((k) => `${k}_key IN(SELECT value FROM json_each(?))`)
    .join(" OR ");
  const values = [
    names,
    ...["phone", "email", "instagram"].map((k) =>
      unique(records.map((c) => contact(k, c[k]))),
    ),
  ].map(JSON.stringify);
  const [revisionResult, linksResult, indexedResult] = await db.batch([
    stmt(db, "SELECT revision FROM client_transfer_state WHERE id=1"),
    stmt(
      db,
      "SELECT source,source_key,client_id FROM client_import_keys WHERE source=? AND source_key IN(SELECT value FROM json_each(?))",
      r.source,
      JSON.stringify(keys),
    ),
    stmt(
      db,
      `SELECT client_id FROM history_preview_clients WHERE preview_id=? AND (${conditions}) LIMIT 1001`,
      r.id,
      ...values,
    ),
  ]);
  if (revisionResult.results[0].revision !== r.client_revision)
    fail(
      409,
      "Client list changed. Rebuild this preview before reviewing matches.",
    );
  if (indexedResult.results.length > 1000)
    fail(
      422,
      "Too many matching profiles on this page. Narrow or correct the source names before previewing; candidates were not truncated.",
    );
  const ids = unique([
    ...indexedResult.results.map((c) => c.client_id),
    ...linksResult.results.map((c) => c.client_id),
    ...stored.map((c) => c.draft_client_id),
  ]);
  const dates = unique(records.map((c) => c.scheduledLocalDate));
  const [revisionAgain, clientsResult, nativeResult] = await db.batch([
    stmt(db, "SELECT revision FROM client_transfer_state WHERE id=1"),
    stmt(
      db,
      `${clientSelect} WHERE c.id IN(SELECT value FROM json_each(?)) ORDER BY c.id`,
      JSON.stringify(ids),
    ),
    stmt(
      db,
      `SELECT a.id,a.client_id AS clientId,c.name AS clientName,a.date,a.start_minute AS start,a.duration FROM appointments a LEFT JOIN clients c ON c.id=a.client_id WHERE a.client_id IN(SELECT value FROM json_each(?)) AND a.date IN(SELECT value FROM json_each(?)) ORDER BY a.id LIMIT 2001`,
      JSON.stringify(ids),
      JSON.stringify(dates),
    ),
  ]);
  if (revisionAgain.results[0].revision !== r.client_revision)
    fail(
      409,
      "Client list changed. Rebuild this preview before reviewing matches.",
    );
  if (nativeResult.results.length > 2000)
    fail(
      422,
      "Too many existing appointments match this page. Narrow the source before previewing; overlaps were not truncated.",
    );
  return {
    clients: clientsResult.results,
    sourceLinks: linksResult.results,
    nativeAppointments: nativeResult.results,
  };
}
function pageSummary(entries, original) {
  const out = {
    ...original,
    ready: 0,
    unresolved: 0,
    conflict: 0,
    duplicate: 0,
    invalid: 0,
    eligibleVisits: 0,
    eligibleSourceNetSales: 0,
    eligibleBonuses: 0,
  };
  for (const e of entries) {
    out[e.disposition]++;
    if (e.eligibility.visits) out.eligibleVisits++;
    if (e.eligibility.sourceNetSales) out.eligibleSourceNetSales++;
  }
  return out;
}
async function page(db, r, index) {
  await ready(db, r);
  if (index >= Math.ceil(r.total / 50))
    fail(400, "Choose a valid preview page.");
  const size = await stmt(
    db,
    "SELECT COALESCE(SUM(n),0) AS bytes FROM (SELECT length(CAST(record_json AS BLOB)) AS n FROM history_preview_rows WHERE preview_id=? ORDER BY row_num LIMIT 50 OFFSET ?)",
    r.id,
    index * 50,
  ).first();
  if (size.bytes > HISTORY_PREVIEW_LIMITS.pageBytes)
    fail(
      422,
      "This page contains unusually large source fields. Reduce irrelevant mapped text before previewing; source evidence was not truncated.",
    );
  const [items, counts] = await db.batch([
    stmt(
      db,
      `SELECT x.*,k.first_row,k.min_digest,k.max_digest FROM history_preview_rows x JOIN history_preview_keys k USING(preview_id,source_key) WHERE x.preview_id=? ORDER BY x.row_num LIMIT 50 OFFSET ?`,
      r.id,
      index * 50,
    ),
    stmt(
      db,
      `SELECT COUNT(*) AS uploaded,COALESCE(SUM(x.invalid),0) AS invalidRows,COALESCE(SUM(k.min_digest!=k.max_digest),0) AS sourceConflictRows,COALESCE(SUM(k.min_digest=k.max_digest AND x.row_num!=k.first_row),0) AS duplicateRows,COALESCE(SUM(x.draft_client_id IS NOT NULL),0) AS draftChoices FROM history_preview_rows x JOIN history_preview_keys k USING(preview_id,source_key) WHERE x.preview_id=?`,
      r.id,
    ),
  ]);
  const records = items.results.map((c) => JSON.parse(c.record_json)),
    config = JSON.parse(r.config_json);
  const snapshot = await snapshots(db, r, records, items.results);
  let planned;
  try {
    planned = planHistoryImport({
      rows: records,
      ...snapshot,
      referenceMode: config.referenceMode,
    });
  } catch {
    fail(
      422,
      "These source or client records need correction before a safe preview can be prepared. No history was imported.",
    );
  }
  const clients = new Map(
    snapshot.clients.map((c) => [c.id, clientProjection(c)]),
  );
  const rows = planned.rows.map((entry, i) => {
    const stored = items.results[i];
    if (stored.min_digest !== stored.max_digest) {
      if (!entry.issues.some((x) => x.code === "source_payload_conflict"))
        entry.issues.push({
          code: "source_payload_conflict",
          field: "sourceAppointmentRef",
          severity: "review",
          message:
            "This source reference has different content elsewhere in this CSV. Review all occurrences.",
        });
      if (entry.disposition !== "invalid") entry.disposition = "conflict";
      entry.duplicateOf = null;
    } else if (stored.first_row !== stored.row_num) {
      entry.duplicateOf = {
        kind: "preview-row",
        id: `history-row:${digest(JSON.stringify([r.source, r.file_digest, stored.first_row]))}`,
      };
      if (!entry.issues.some((x) => x.code === "duplicate_source_row"))
        entry.issues.push({
          code: "duplicate_source_row",
          field: "sourceAppointmentRef",
          severity: "review",
          message: "Identical source content appears earlier in this CSV.",
        });
      if (!["invalid", "conflict"].includes(entry.disposition))
        entry.disposition = "duplicate";
    }
    if (entry.disposition !== "ready")
      entry.eligibility = {
        visits: false,
        sourceNetSales: false,
        bonuses: false,
      };
    const selected = clients.get(stored.draft_client_id);
    return {
      ...entry,
      row: stored.row_num,
      candidates: entry.identity.candidates
        .map((id) => clients.get(id))
        .filter(Boolean),
      draftChoice: stored.draft_client_id
        ? {
            clientId: stored.draft_client_id,
            clientVersion: stored.draft_client_version,
            name: selected?.name ?? "Unavailable client",
            client: selected ?? null,
            stale:
              !selected || selected.version !== stored.draft_client_version,
            nativeOverlapIds: snapshot.nativeAppointments
              .filter(
                (a) =>
                  a.clientId === stored.draft_client_id &&
                  a.date === entry.record.scheduledLocalDate &&
                  Number.isInteger(entry.record.startMinute) &&
                  Number.isInteger(entry.record.durationMinutes) &&
                  a.start <
                    entry.record.startMinute + entry.record.durationMinutes &&
                  entry.record.startMinute < a.start + a.duration,
              )
              .map((a) => a.id),
          }
        : null,
    };
  });
  return json({
    ...meta(r),
    page: index,
    pageSize: 50,
    summary: { total: r.total, ...counts.results[0] },
    pageSummary: pageSummary(rows, planned.summary),
    rows,
  });
}
async function searchClients(db, r, url) {
  await ready(db, r);
  const q = (url.searchParams.get("q") ?? "").trim(),
    index = pageIndex(url.searchParams.get("page") ?? "0");
  if (q.length > 100 || index > 2000) fail(400, "Use a shorter client search.");
  const escaped = fold(q).replace(/[\\%_]/g, "\\$&"),
    like = `%${escaped}%`;
  const [revision, results] = await db.batch([
    stmt(db, "SELECT revision FROM client_transfer_state WHERE id=1"),
    stmt(
      db,
      `${clientSelect} WHERE c.id IN(SELECT client_id FROM history_preview_clients WHERE preview_id=? AND (name_key LIKE ? ESCAPE '\\' OR phone_key LIKE ? ESCAPE '\\' OR email_key LIKE ? ESCAPE '\\' OR instagram_key LIKE ? ESCAPE '\\')) ORDER BY c.name,c.id LIMIT 51 OFFSET ?`,
      r.id,
      like,
      `%${contact("phone", q) ?? escaped}%`,
      like,
      like,
      index * 50,
    ),
  ]);
  if (revision.results[0].revision !== r.client_revision)
    fail(
      409,
      "Client list changed. Rebuild this preview before reviewing matches.",
    );
  return json({
    clients: results.results.slice(0, 50).map(clientProjection),
    hasMore: results.results.length > 50,
    page: index,
  });
}
async function choices(db, user, r, body) {
  if (
    !Number.isSafeInteger(body.version) ||
    body.version < 1 ||
    typeof body.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(body.requestId) ||
    !Array.isArray(body.choices) ||
    !body.choices.length ||
    body.choices.length > 50
  )
    fail(
      400,
      "Save at most 50 explicit client draft choices with a preview version and request ID.",
    );
  const items = body.choices;
  if (
    new Set(items.map((c) => c?.row)).size !== items.length ||
    items.some(
      (c) =>
        !c ||
        !Number.isInteger(c.row) ||
        c.row < 2 ||
        c.row > r.total + 1 ||
        (!(c.clientId === null && c.clientVersion === null) &&
          !(
            typeof c.clientId === "string" &&
            c.clientId.length > 0 &&
            c.clientId.length <= 100 &&
            Number.isSafeInteger(c.clientVersion) &&
            c.clientVersion > 0
          )),
    )
  )
    fail(
      400,
      "Each draft choice needs a source row and a current client version, or null values to clear it.",
    );
  const hash = digest(
    canonical({
      version: body.version,
      choices: [...items].sort((a, b) => a.row - b.row),
    }),
  );
  const receipt = await stmt(
    db,
    "SELECT digest FROM history_preview_decisions WHERE preview_id=? AND request_id=?",
    r.id,
    body.requestId,
  ).first();
  if (receipt) {
    if (receipt.digest !== hash)
      fail(
        409,
        "This draft request ID was already used for different choices.",
      );
    return json({ ...meta(await job(db, user, r.id)), repeated: true });
  }
  await ready(db, r);
  if (body.version !== r.version)
    fail(
      409,
      "This history preview changed. Reload the page before saving choices.",
    );
  const packed = JSON.stringify(items),
    token = randomUUID(),
    guard = `EXISTS(SELECT 1 FROM history_previews WHERE id=? AND mutation_token=?)`;
  await db.batch([
    stmt(
      db,
      `UPDATE history_previews SET version=version+1,mutation_token=? WHERE id=? AND owner_id=? AND version=? AND phase='ready' AND expires_at>? AND client_revision=${clock} AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN clients c ON c.id=json_extract(j.value,'$.clientId') WHERE json_extract(j.value,'$.clientId') IS NOT NULL AND (c.id IS NULL OR c.version!=json_extract(j.value,'$.clientVersion')))`,
      token,
      r.id,
      user.id,
      body.version,
      Date.now(),
      packed,
    ),
    stmt(
      db,
      `UPDATE history_preview_rows SET draft_client_id=(SELECT json_extract(value,'$.clientId') FROM json_each(?) WHERE json_extract(value,'$.row')=row_num),draft_client_version=(SELECT json_extract(value,'$.clientVersion') FROM json_each(?) WHERE json_extract(value,'$.row')=row_num) WHERE preview_id=? AND row_num IN(SELECT json_extract(value,'$.row') FROM json_each(?)) AND ${guard}`,
      packed,
      packed,
      r.id,
      packed,
      r.id,
      token,
    ),
    stmt(
      db,
      `INSERT INTO history_preview_decisions(preview_id,request_id,digest,result_version) SELECT id,?,?,version FROM history_previews WHERE id=? AND mutation_token=?`,
      body.requestId,
      hash,
      r.id,
      token,
    ),
  ]);
  const saved = await stmt(
    db,
    "SELECT digest FROM history_preview_decisions WHERE preview_id=? AND request_id=?",
    r.id,
    body.requestId,
  ).first();
  if (!saved || saved.digest !== hash)
    fail(
      409,
      "The preview or selected client changed. Reload before saving the draft choice.",
    );
  return json(meta(await job(db, user, r.id)));
}

export async function historyPreviewRoutes(request, db, user) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path !== P && !path.startsWith(P + "/")) return null;
  requireRole(user, "owner");
  await ensureClientContacts(db);
  await ensureClientTransferSchema(db);
  await ensureHistoryPreviewSchema(db);
  if (path === P && request.method === "GET") {
    const rows = (
      await stmt(
        db,
        "SELECT * FROM history_previews WHERE owner_id=? AND expires_at>? ORDER BY created_at DESC,rowid DESC LIMIT 3",
        user.id,
        Date.now(),
      ).all()
    ).results;
    return json({ previews: rows.map(meta) });
  }
  if (path === P + "/start" && request.method === "POST")
    return start(db, user, await readJSON(request, 50000));
  const m = path.match(
    /^\/api\/history\/previews\/([a-f0-9-]{36})(?:\/(upload|finalize|page|clients|choices))?$/,
  );
  if (!m) fail(404, "History preview action not found.");
  const r = await job(db, user, m[1]);
  if (!m[2] && request.method === "GET") return json(meta(r));
  if (!m[2] && request.method === "DELETE") {
    const body = await readJSON(request, 1000);
    if (!Number.isSafeInteger(body.version) || body.version !== r.version)
      fail(409, "This preview changed. Reload before discarding it.");
    const result = await stmt(
      db,
      "DELETE FROM history_previews WHERE id=? AND owner_id=? AND version=? AND expires_at>?",
      r.id,
      user.id,
      body.version,
      Date.now(),
    ).run();
    if (!result.meta.changes)
      fail(409, "This preview changed. Reload before discarding it.");
    return json({ ok: true });
  }
  if (m[2] === "page" && request.method === "GET")
    return page(db, r, pageIndex(url.searchParams.get("page") ?? "0"));
  if (m[2] === "clients" && request.method === "GET")
    return searchClients(db, r, url);
  if (request.method !== "POST") fail(405, "Use POST for this preview action.");
  if (m[2] === "upload")
    return upload(
      db,
      user,
      r,
      await readJSON(request, HISTORY_PREVIEW_LIMITS.chunkBytes),
    );
  if (m[2] === "finalize") {
    await readJSON(request, 1000);
    return finalize(db, user, r);
  }
  if (m[2] === "choices")
    return choices(db, user, r, await readJSON(request, 20000));
  fail(404, "History preview action not found.");
}
