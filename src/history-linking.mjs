import { randomUUID } from "node:crypto";
import { digest, fail, readJSON, requireRole, token } from "./security.mjs";
import { ensureClientContacts } from "./client-contacts.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";
import { ensureHistoryPreviewSchema } from "./history-preview-schema.mjs";
import { ensureHistoryArchiveSchema } from "./history-archive-schema.mjs";
import { historyPreviewContactKey } from "./history-preview.mjs";

// A label groups rows for review. It never establishes that two rows concern
// the same person, and linking never changes the archived source evidence.
export const HISTORY_LINK_LIMITS = Object.freeze({
  pageSize: 100,
  groups: 50000,
  groupBytes: 8 * 1048576,
  clients: 100000,
  candidateBytes: 24 * 1048576,
  reviewTtl: 15 * 60 * 1000,
});
const P = "/api/history/links";
const stmt = (db, q, ...args) => db.prepare(q).bind(...args);
const json = (value) =>
  Response.json(value, { headers: { "Cache-Control": "no-store" } });
const fold = (value) =>
  (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const archiveClock = "(SELECT revision FROM history_archive_state WHERE id=1)";
const clientClock = "(SELECT revision FROM client_transfer_state WHERE id=1)";
const nativeClock = "(SELECT revision FROM history_native_state WHERE id=1)";
const clockSelect = `SELECT ${archiveClock} AS archiveRevision,${clientClock} AS clientRevision,${nativeClock} AS nativeRevision`;
const labelExpr =
  "COALESCE(json_extract(record_json,'$.sourceClientLabel'),'')";
const publicGroup = ({ key, source, label, count, from, to }) => ({
  key,
  source,
  label,
  count,
  from,
  to,
});

function integerParam(url, key, fallback, min, max) {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    fail(400, `Choose a valid ${key}.`);
  return Number(value);
}

async function unresolvedGroups(db) {
  // Aggregate labels before reading them so many appointments for one label do
  // not require loading all appointments. The byte check prevents huge labels
  // from turning an otherwise bounded aggregate into an unbounded response.
  const size = await stmt(
    db,
    `SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(source AS BLOB))+length(CAST(label AS BLOB))),0) AS bytes FROM (SELECT source,${labelExpr} AS label FROM history_archive_effective WHERE client_id IS NULL GROUP BY source,label)`,
  ).first();
  if (
    size.n > HISTORY_LINK_LIMITS.groups ||
    size.bytes > HISTORY_LINK_LIMITS.groupBytes
  )
    fail(
      422,
      "There are too many unresolved client labels to review safely in one list. No history was changed.",
    );
  const raw = (
    await stmt(
      db,
      `SELECT source,${labelExpr} AS label,COUNT(*) AS n,MIN(date) AS first_date,MAX(date) AS last_date FROM history_archive_effective WHERE client_id IS NULL GROUP BY source,label LIMIT ?`,
      HISTORY_LINK_LIMITS.groups + 1,
    ).all()
  ).results;
  if (raw.length > HISTORY_LINK_LIMITS.groups)
    fail(409, "Imported history changed while loading. Reload the list.");
  const grouped = new Map();
  for (const row of raw) {
    const normalized = fold(row.label),
      key = digest(canonical([row.source, normalized]));
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        source: row.source,
        normalized,
        label: row.label.trim() || "Unknown client",
        count: 0,
        from: row.first_date,
        to: row.last_date,
        labels: [],
      };
      grouped.set(key, group);
    }
    group.labels.push(row.label);
    group.count += row.n;
    if (row.first_date < group.from) group.from = row.first_date;
    if (row.last_date > group.to) group.to = row.last_date;
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.label.localeCompare(b.label) ||
      a.source.localeCompare(b.source) ||
      a.key.localeCompare(b.key),
  );
}

async function listGroups(db, url) {
  const offset = integerParam(url, "offset", 0, 0, 1000000),
    limit = integerParam(url, "limit", 30, 1, 100);
  const before = await stmt(db, clockSelect).first(),
    groups = await unresolvedGroups(db),
    after = await stmt(db, clockSelect).first();
  if (before.archiveRevision !== after.archiveRevision)
    fail(409, "Imported history changed while loading. Reload the list.");
  return json({
    groups: groups.slice(offset, offset + limit).map(publicGroup),
    total: groups.length,
    unlinkedRows: groups.reduce((n, g) => n + g.count, 0),
    offset,
    limit,
  });
}

async function nameCandidates(db, normalized) {
  if (!normalized) return { candidates: [], candidateCount: 0 };
  // SQLite lower() does not perform Unicode NFKC/case folding. Read only the
  // bounded name index here, then load contact details for the matching page.
  const size = await stmt(
    db,
    "SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(id AS BLOB))+length(CAST(name AS BLOB))),0) AS bytes FROM clients",
  ).first();
  if (
    size.n > HISTORY_LINK_LIMITS.clients ||
    size.bytes > HISTORY_LINK_LIMITS.candidateBytes
  )
    return { candidates: [], candidateCount: null, searchRequired: true };
  const names = (
    await stmt(
      db,
      "SELECT id,name FROM clients LIMIT ?",
      HISTORY_LINK_LIMITS.clients + 1,
    ).all()
  ).results;
  if (names.length > HISTORY_LINK_LIMITS.clients)
    return { candidates: [], candidateCount: null, searchRequired: true };
  const matches = names
    .filter((c) => fold(c.name) === normalized)
    .sort((a, b) => a.id.localeCompare(b.id));
  const candidates = matches.length
    ? (
        await stmt(
          db,
          "SELECT c.id,c.name,c.phone,c.email,c.version,i.instagram FROM clients c LEFT JOIN client_instagram i ON i.client_id=c.id WHERE c.id IN(SELECT value FROM json_each(?)) ORDER BY c.name,c.id",
          JSON.stringify(matches.slice(0, 20).map((c) => c.id)),
        ).all()
      ).results
    : [];
  return {
    candidates,
    candidateCount: matches.length,
    searchRequired: matches.length > 20,
  };
}

async function reviewGroup(db, user, url) {
  const groupKey = url.searchParams.get("groupKey"),
    offset = integerParam(url, "offset", 0, 0, 1000000);
  if (!/^[a-f0-9]{64}$/.test(groupKey ?? ""))
    fail(400, "Choose an unresolved client group.");
  const clocks = await stmt(db, clockSelect).first(),
    groups = await unresolvedGroups(db),
    group = groups.find((g) => g.key === groupKey);
  if (!group) fail(404, "This unresolved client group is no longer available.");
  const rows = (
    await stmt(
      db,
      `SELECT id,evidence_hash AS evidenceHash,${labelExpr} AS clientLabel,date,start_minute AS startMinute,duration,source_status AS status,json_extract(record_json,'$.sourceServiceLabel') AS serviceName,json_extract(record_json,'$.sourceTherapistLabel') AS therapistName,json_extract(record_json,'$.sourceClientId') AS sourceClientId,json_extract(record_json,'$.phone') AS phone,json_extract(record_json,'$.email') AS email,json_extract(record_json,'$.instagram') AS instagram FROM history_archive_effective WHERE client_id IS NULL AND source=? AND ${labelExpr} IN(SELECT value FROM json_each(?)) ORDER BY date DESC,start_minute DESC,id LIMIT ? OFFSET ?`,
      group.source,
      JSON.stringify(group.labels),
      HISTORY_LINK_LIMITS.pageSize,
      offset,
    ).all()
  ).results;
  if (!rows.length)
    fail(400, "Choose a page containing unresolved history rows.");
  const candidates = await nameCandidates(db, group.normalized),
    reviewId = randomUUID(),
    rawToken = token(),
    now = Date.now(),
    expiresAt = now + HISTORY_LINK_LIMITS.reviewTtl;
  const plan = {
    group: publicGroup(group),
    rows: rows.map(({ id, evidenceHash }) => ({ id, evidenceHash })),
    offset,
  };
  const fingerprint = digest(canonical({ ...plan, ...clocks }));
  const inserted = await stmt(
    db,
    `INSERT INTO history_client_link_reviews(id,owner_id,token_hash,fingerprint,archive_revision,client_revision,native_revision,plan_json,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${archiveClock}=? AND ${clientClock}=? AND ${nativeClock}=?`,
    reviewId,
    user.id,
    digest(rawToken),
    fingerprint,
    clocks.archiveRevision,
    clocks.clientRevision,
    clocks.nativeRevision,
    JSON.stringify(plan),
    now,
    expiresAt,
    clocks.archiveRevision,
    clocks.clientRevision,
    clocks.nativeRevision,
  ).run();
  if (!inserted.meta.changes)
    fail(
      409,
      "History or clients changed while preparing this review. Reload it.",
    );
  const identities = new Set(
    rows
      .map((r) => canonical([r.sourceClientId, r.phone, r.email, r.instagram]))
      .filter((v) => v !== "[null,null,null,null]"),
  );
  return json({
    reviewId,
    token: rawToken,
    fingerprint,
    expiresAt,
    ...clocks,
    group: publicGroup(group),
    total: group.count,
    offset,
    hasMore: offset + rows.length < group.count,
    rows: rows.map(({ evidenceHash: _, ...row }) => row),
    ...candidates,
    ambiguous: candidates.candidateCount > 1 || identities.size > 1,
    explanation:
      "Matching names are suggestions only. Select only records you have verified belong to the chosen existing client.",
  });
}

function applyInput(body) {
  const keys = [
    "reviewId",
    "token",
    "fingerprint",
    "requestId",
    "clientId",
    "clientVersion",
    "archiveIds",
    "acknowledgeReview",
  ];
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key)) ||
    typeof body.reviewId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(body.reviewId) ||
    typeof body.token !== "string" ||
    body.token.length < 20 ||
    body.token.length > 100 ||
    typeof body.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.fingerprint) ||
    typeof body.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId) ||
    typeof body.clientId !== "string" ||
    !body.clientId ||
    body.clientId.length > 100 ||
    !Number.isSafeInteger(body.clientVersion) ||
    body.clientVersion < 1 ||
    !Array.isArray(body.archiveIds) ||
    !body.archiveIds.length ||
    body.archiveIds.length > HISTORY_LINK_LIMITS.pageSize ||
    new Set(body.archiveIds).size !== body.archiveIds.length ||
    body.archiveIds.some(
      (id) => typeof id !== "string" || !id || id.length > 100,
    ) ||
    body.acknowledgeReview !== true
  )
    fail(
      400,
      "Review and select 1–100 distinct history rows and an existing client before confirming.",
    );
  return { ...body, archiveIds: [...body.archiveIds].sort() };
}

async function receipt(db, user, body, bodyHash) {
  const previous = await stmt(
    db,
    "SELECT body_hash,result_json FROM history_client_link_receipts WHERE owner_id=? AND request_id=?",
    user.id,
    body.requestId,
  ).first();
  if (!previous) return null;
  if (previous.body_hash !== bodyHash)
    fail(
      409,
      "This linking request ID was already used for another selection.",
    );
  return JSON.parse(previous.result_json);
}

async function verifyIdentity(db, rows, client) {
  const contacts = rows.map((r) => {
    const result = {};
    for (const field of ["phone", "email", "instagram"]) {
      result[field] = historyPreviewContactKey(field, r[field]);
      if (r[field]?.trim() && !result[field])
        fail(
          409,
          "A selected source contact is invalid. Resolve its identity evidence before linking.",
        );
      const selected = historyPreviewContactKey(field, client[field]);
      if (result[field] && selected && result[field] !== selected)
        fail(
          409,
          "A selected source contact contradicts the chosen client. Review the selected records.",
        );
    }
    return result;
  });
  const phoneKeys = [...new Set(contacts.map((r) => r.phone).filter(Boolean))],
    emails = [...new Set(contacts.map((r) => r.email).filter(Boolean))],
    handles = [...new Set(contacts.map((r) => r.instagram).filter(Boolean))];
  const matches = (
    await stmt(
      db,
      "SELECT c.id,c.phone_key,c.email_key,i.instagram FROM clients c LEFT JOIN client_instagram i ON i.client_id=c.id WHERE c.phone_key IN(SELECT value FROM json_each(?)) OR c.email_key IN(SELECT value FROM json_each(?)) OR i.instagram IN(SELECT value FROM json_each(?)) LIMIT 1001",
      JSON.stringify(phoneKeys),
      JSON.stringify(emails),
      JSON.stringify(handles),
    ).all()
  ).results;
  if (matches.length > 1000)
    fail(
      409,
      "Too many profiles match the selected source contacts. Resolve those contacts before linking.",
    );
  for (const row of contacts) {
    const matched = matches.filter(
      (c) =>
        (row.phone && c.phone_key === row.phone) ||
        (row.email && c.email_key === row.email) ||
        (row.instagram && c.instagram === row.instagram),
    );
    if (matched.some((c) => c.id !== client.id))
      fail(
        409,
        "A selected source contact belongs to another client profile. Resolve the duplicate profiles before linking.",
      );
  }
  const sourceIds = [
    ...new Map(
      rows
        .filter((r) => r.sourceClientId?.trim())
        .map((r) => [
          canonical([r.source, r.sourceClientId.trim()]),
          {
            source: r.source,
            id: r.sourceClientId.trim(),
            key: `id:${digest(r.sourceClientId.trim())}`,
          },
        ]),
    ).values(),
  ];
  if (sourceIds.length) {
    const [importLinks, archivedLinks] = await db.batch([
      stmt(
        db,
        "SELECT k.client_id FROM json_each(?) x JOIN client_import_keys k ON k.source=json_extract(x.value,'$.source') AND k.source_key=json_extract(x.value,'$.key') WHERE k.client_id<>? LIMIT 1",
        JSON.stringify(sourceIds),
        client.id,
      ),
      stmt(
        db,
        "SELECT a.client_id FROM json_each(?) x JOIN history_archive_effective a ON a.source=json_extract(x.value,'$.source') AND trim(json_extract(a.record_json,'$.sourceClientId'))=json_extract(x.value,'$.id') WHERE a.client_id IS NOT NULL AND a.client_id<>? LIMIT 1",
        JSON.stringify(sourceIds),
        client.id,
      ),
    ]);
    if (importLinks.results.length || archivedLinks.results.length)
      fail(
        409,
        "A selected source client ID is already linked to another client profile. Review its identity before linking.",
      );
  }
}

async function applyLinks(db, user, value) {
  const body = applyInput(value),
    bodyHash = digest(canonical(body)),
    repeated = await receipt(db, user, body, bodyHash);
  if (repeated) return json({ ...repeated, repeated: true });
  const review = await stmt(
    db,
    "SELECT * FROM history_client_link_reviews WHERE id=? AND owner_id=?",
    body.reviewId,
    user.id,
  ).first();
  if (!review) fail(404, "Client linking review not found.");
  if (
    review.token_hash !== digest(body.token) ||
    review.fingerprint !== body.fingerprint
  )
    fail(409, "This client linking confirmation does not match the review.");
  if (review.expires_at <= Date.now())
    fail(410, "This client linking review expired. Open a new review.");
  const plan = JSON.parse(review.plan_json),
    allowed = new Map(plan.rows.map((r) => [r.id, r.evidenceHash]));
  if (body.archiveIds.some((id) => !allowed.has(id)))
    fail(400, "Select only the history rows shown in this review.");
  const clocks = await stmt(db, clockSelect).first();
  if (
    clocks.archiveRevision !== review.archive_revision ||
    clocks.clientRevision !== review.client_revision ||
    clocks.nativeRevision !== review.native_revision
  )
    fail(
      409,
      "History, clients or appointments changed after this review. Reload it before linking.",
    );
  const client = await stmt(
    db,
    "SELECT c.id,c.name,c.phone,c.email,c.version,i.instagram FROM clients c LEFT JOIN client_instagram i ON i.client_id=c.id WHERE c.id=?",
    body.clientId,
  ).first();
  if (!client || client.version !== body.clientVersion)
    fail(
      409,
      "The selected client changed or no longer exists. Search for the client again.",
    );
  const selection = JSON.stringify(body.archiveIds);
  const rows = (
    await stmt(
      db,
      "SELECT id,source,evidence_hash AS evidenceHash,json_extract(record_json,'$.sourceClientId') AS sourceClientId,json_extract(record_json,'$.phone') AS phone,json_extract(record_json,'$.email') AS email,json_extract(record_json,'$.instagram') AS instagram FROM history_archive_effective WHERE client_id IS NULL AND id IN(SELECT value FROM json_each(?))",
      selection,
    ).all()
  ).results;
  if (
    rows.length !== body.archiveIds.length ||
    rows.some((r) => allowed.get(r.id) !== r.evidenceHash)
  )
    fail(
      409,
      "A selected history record changed or was already linked. Reload the review.",
    );
  await verifyIdentity(db, rows, client);
  const overlap = await stmt(
    db,
    "SELECT a.id FROM history_archive_effective h JOIN appointments a ON a.client_id=? AND a.date=h.date AND a.start_minute<h.start_minute+h.duration AND h.start_minute<a.start_minute+a.duration WHERE h.id IN(SELECT value FROM json_each(?)) LIMIT 1",
    client.id,
    selection,
  ).first();
  if (overlap)
    fail(
      409,
      "An existing Rei appointment overlaps a selected history record for this client. Resolve the overlap before linking.",
    );
  const mutation = randomUUID(),
    now = Date.now(),
    timestamp = new Date(now).toISOString(),
    result = {
      linked: rows.length,
      remaining: plan.group.count - rows.length,
      client: { id: client.id, name: client.name },
    };
  const guard =
      "EXISTS(SELECT 1 FROM history_client_link_receipts WHERE owner_id=? AND request_id=? AND mutation_token=?)",
    guardArgs = [user.id, body.requestId, mutation];
  await db.batch([
    stmt(
      db,
      `INSERT OR IGNORE INTO history_client_link_receipts(owner_id,request_id,body_hash,mutation_token,result_json,created_at) SELECT ?,?,?,?,?,? WHERE ${archiveClock}=? AND ${clientClock}=? AND ${nativeClock}=? AND EXISTS(SELECT 1 FROM clients WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM history_client_link_reviews WHERE id=? AND owner_id=? AND token_hash=? AND fingerprint=? AND expires_at>?) AND (SELECT COUNT(*) FROM history_archive_effective WHERE client_id IS NULL AND id IN(SELECT value FROM json_each(?)))=?`,
      user.id,
      body.requestId,
      bodyHash,
      mutation,
      JSON.stringify(result),
      timestamp,
      review.archive_revision,
      review.client_revision,
      review.native_revision,
      client.id,
      body.clientVersion,
      review.id,
      user.id,
      review.token_hash,
      review.fingerprint,
      now,
      selection,
      rows.length,
    ),
    stmt(
      db,
      `INSERT INTO history_archive_client_links(archive_id,client_id,version,created_by,created_at) SELECT value,?,1,?,? FROM json_each(?) WHERE ${guard}`,
      client.id,
      user.id,
      timestamp,
      selection,
      ...guardArgs,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'history_client_link','history_client_link_review',?,?,? WHERE ${guard}`,
      user.id,
      review.id,
      JSON.stringify({
        clientId: client.id,
        archiveIds: body.archiveIds,
        requestId: body.requestId,
      }),
      timestamp,
      ...guardArgs,
    ),
  ]);
  const committed = await stmt(
    db,
    "SELECT body_hash,mutation_token,result_json FROM history_client_link_receipts WHERE owner_id=? AND request_id=?",
    user.id,
    body.requestId,
  ).first();
  if (!committed)
    fail(
      409,
      "History, clients or appointments changed during confirmation. Reload the review.",
    );
  if (committed.body_hash !== bodyHash)
    fail(
      409,
      "This linking request ID was already used for another selection.",
    );
  return json({
    ...JSON.parse(committed.result_json),
    repeated: committed.mutation_token !== mutation,
  });
}

export async function historyLinkingRoutes(request, db, user) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path !== P && !path.startsWith(P + "/")) return null;
  requireRole(user, "owner");
  await ensureClientContacts(db);
  await ensureClientTransferSchema(db);
  await ensureHistoryPreviewSchema(db);
  await ensureHistoryArchiveSchema(db);
  if (request.method === "GET" && path === P + "/groups")
    return listGroups(db, url);
  if (request.method === "GET" && path === P + "/review")
    return reviewGroup(db, user, url);
  if (request.method === "POST" && path === P + "/apply")
    return applyLinks(db, user, await readJSON(request, 20000));
  fail(404, "Client linking action not found.");
}
