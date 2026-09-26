import { randomUUID } from "node:crypto";
import { fail, readJSON, requireRole, digest } from "./security.mjs";
import { clientInput } from "./domain.mjs";
import {
  parseCSV,
  csvCell,
  decodeReiCell,
  isReiExport,
} from "./client-csv.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";

const stmt = (db, q, ...args) => db.prepare(q).bind(...args);
const json = (v, status = 200) => Response.json(v, { status });
const fold = (v) =>
  v.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const fields = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "email",
  "note",
  "sourceId",
];
const BODY_LIMIT = 7 * 1048576; // JSON may escape a 1 MiB CSV to six times its size.
function validateMapping(mapping, headers) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    fail(400, "Map the client columns first.");
  const used = new Set();
  for (const [field, col] of Object.entries(mapping)) {
    if (
      !fields.includes(field) ||
      !Number.isInteger(col) ||
      col < 0 ||
      col >= headers.length ||
      used.has(col)
    )
      fail(400, "Map each column to only one valid client field.");
    used.add(col);
  }
  if (mapping.name === undefined && mapping.firstName === undefined)
    fail(400, "Map Full name or First name.");
  if (
    mapping.name !== undefined &&
    (mapping.firstName !== undefined || mapping.lastName !== undefined)
  )
    fail(400, "Use Full name or First / Last name, not both.");
}
function consistent(candidate, existing) {
  return (
    fold(candidate.name) === fold(existing.name) &&
    (!candidate.phone_key ||
      !existing.phone_key ||
      candidate.phone_key === existing.phone_key) &&
    (!candidate.email_key ||
      !existing.email_key ||
      candidate.email_key === existing.email_key)
  );
}
async function preview(db, user, body) {
  if (!["fresha", "rei", "other"].includes(body.source))
    fail(400, "Choose the source of this file.");
  const parsed = parseCSV(body.csv, body.delimiter),
    { headers, rows } = parsed;
  validateMapping(body.mapping, headers);
  const rei = body.source === "rei" && isReiExport(headers);
  const fileHash = digest(JSON.stringify({ headers, rows }));
  const candidates = rows.map((cells, index) => {
    const get = (field) => {
      const value =
        body.mapping[field] === undefined ? "" : cells[body.mapping[field]];
      return rei ? decodeReiCell(value) : value;
    };
    let name =
      body.mapping.name === undefined
        ? [get("firstName").trim(), get("lastName").trim()]
            .filter(Boolean)
            .join(" ")
        : get("name");
    const row = {
      row: index + 2,
      id: randomUUID(),
      status: "new",
      message: "Ready to add.",
      selected: true,
    };
    try {
      row.client = clientInput({
        name,
        phone: get("phone"),
        email: get("email"),
        note: get("note"),
      });
      const external = get("sourceId").trim();
      if (external.length > 200)
        fail(400, "Source client IDs must be 200 characters or fewer.");
      row.externalId = external;
      row.key = external
        ? "id:" + digest(external)
        : "row:" + fileHash + ":" + index;
    } catch (e) {
      row.client = {
        name: name.slice(0, 100),
        phone: get("phone").slice(0, 30),
        email: get("email").slice(0, 254),
        note: "",
      };
      row.status = "invalid";
      row.message = e.message;
      row.selected = false;
    }
    return row;
  });
  // One consistent database snapshot for identity checks and confirmation revision.
  const snapshot = await db.batch([
    stmt(db, "SELECT revision FROM client_transfer_state WHERE id=1"),
    stmt(
      db,
      "SELECT id,name,phone,phone_key,email,email_key FROM clients LIMIT 10001",
    ),
    stmt(
      db,
      "SELECT source_key,client_id FROM client_import_keys WHERE source=? AND source_key IN (SELECT value FROM json_each(?))",
      body.source,
      JSON.stringify(candidates.filter((r) => r.key).map((r) => r.key)),
    ),
  ]);
  const clients = snapshot[1].results;
  if (clients.length > 10000)
    fail(
      400,
      "This importer supports up to 10,000 existing clients. Contact the owner before continuing.",
    );
  const byId = new Map(clients.map((c) => [c.id, c])),
    byPhone = new Map(
      clients.filter((c) => c.phone_key).map((c) => [c.phone_key, c]),
    ),
    byEmail = new Map(
      clients.filter((c) => c.email_key).map((c) => [c.email_key, c]),
    ),
    names = new Set(clients.map((c) => fold(c.name))),
    keys = new Map(snapshot[2].results.map((k) => [k.source_key, k.client_id]));
  const reject = (r, status, message) => {
    r.status = status;
    r.message = message;
    r.selected = false;
  };
  const groups = new Map();
  for (const r of candidates.filter((r) => r.status !== "invalid")) {
    // A Rei export identifies the original client even if it was created outside import.
    const matches = [
      byId.get(keys.get(r.key)),
      rei ? byId.get(r.externalId) : null,
      byPhone.get(r.client.phone_key),
      byEmail.get(r.client.email_key),
    ].filter(Boolean);
    const ids = new Set(matches.map((c) => c.id));
    if (ids.size > 1 || matches.some((c) => !consistent(r.client, c)))
      reject(
        r,
        "conflict",
        "ID, name or contact details disagree with an existing client. Nothing will be changed.",
      );
    else if (ids.size === 1)
      reject(
        r,
        "existing",
        "Existing client. Skipped; stored details remain unchanged.",
      );
    else if (
      names.has(fold(r.client.name)) ||
      (!r.client.phone_key && !r.client.email_key)
    ) {
      r.status = "review";
      r.selected = false;
      r.message = names.has(fold(r.client.name))
        ? "This name already exists. Select only if this is a different person."
        : "No phone or email. Check identity before selecting this row.";
    }
    for (const value of [
      r.externalId && "id:" + r.externalId,
      r.client.phone_key && "phone:" + r.client.phone_key,
      r.client.email_key && "email:" + r.client.email_key,
    ].filter(Boolean)) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(r);
    }
  }
  // Shared contacts can belong to family members: never pick an arbitrary winner.
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const fingerprints = new Set(
      group.map((r) => JSON.stringify([r.client, r.externalId])),
    );
    if (fingerprints.size > 1)
      group.forEach((r) =>
        reject(
          r,
          "conflict",
          "Rows in this file share an ID, phone or email but have different details. Correct the file first.",
        ),
      );
    else
      for (const r of group.slice(1))
        if (r.status !== "conflict")
          reject(
            r,
            "duplicate",
            "Identical ID/contact row already appears in this file. Skipped.",
          );
  }
  if (
    clients.length +
      candidates.filter((r) => ["new", "review"].includes(r.status)).length >
    10000
  )
    fail(
      400,
      "The combined client list would exceed 10,000. Split or review this import.",
    );
  const time = Date.now(),
    id = randomUUID(),
    expiresAt = time + 3600000;
  await db.batch([
    stmt(
      db,
      "DELETE FROM client_imports WHERE status='preview' AND (expires_at<=? OR (owner_id=? AND id NOT IN (SELECT id FROM client_imports WHERE owner_id=? AND status='preview' ORDER BY created_at DESC LIMIT 9)))",
      time,
      user.id,
      user.id,
    ),
    stmt(
      db,
      "INSERT INTO client_imports(id,owner_id,source,revision,plan_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      id,
      user.id,
      body.source,
      snapshot[0].results[0].revision,
      JSON.stringify(candidates),
      time,
      expiresAt,
    ),
  ]);
  return json(
    {
      id,
      expiresAt,
      rows: candidates.map(({ id, key, externalId, ...r }) => r),
      total: candidates.length,
    },
    201,
  );
}
async function commit(db, user, id, body) {
  const selected = body.rows;
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > 1000 ||
    selected.some((r) => !Number.isInteger(r)) ||
    new Set(selected).size !== selected.length
  )
    fail(400, "Select at least one valid row, without repeats.");
  const selectionHash = digest(
    JSON.stringify([...selected].sort((a, b) => a - b)),
  );
  let record = await stmt(
    db,
    "SELECT * FROM client_imports WHERE id=? AND owner_id=?",
    id,
    user.id,
  ).first();
  if (!record) fail(404, "Import preview not found. Create a new preview.");
  const receipt = () => {
    if (record.selection_hash !== selectionHash)
      fail(
        409,
        "This preview was already imported with a different selection. Create a new preview.",
      );
    return json({ ...JSON.parse(record.result_json), repeated: true });
  };
  if (record.status === "applied") return receipt();
  if (record.expires_at <= Date.now())
    fail(409, "This preview expired. Preview the file again.");
  const plan = JSON.parse(record.plan_json),
    selectedSet = new Set(selected);
  const rows = plan.filter((r) => selectedSet.has(r.row));
  if (
    rows.length !== selected.length ||
    rows.some((r) => !["new", "review"].includes(r.status))
  )
    fail(400, "Only new rows or rows marked for review can be imported.");
  const result = {
      id,
      created: rows.length,
      skipped: plan.length - rows.length,
    },
    commitToken = randomUUID(),
    time = new Date().toISOString(),
    data = JSON.stringify(
      rows.map((r) => ({ ...r.client, id: r.id, key: r.key })),
    );
  // The claim and all writes share a D1 transaction. A changed client revision
  // invalidates the entire preview. Retries can only read their original receipt.
  const guard = `EXISTS(SELECT 1 FROM client_imports WHERE id=? AND commit_token=?)`;
  await db.batch([
    stmt(
      db,
      `UPDATE client_imports SET status='applied',commit_token=?,selection_hash=?,result_json=?,committed_at=?,plan_json='[]' WHERE id=? AND owner_id=? AND status='preview' AND expires_at>? AND revision=(SELECT revision FROM client_transfer_state WHERE id=1)`,
      commitToken,
      selectionHash,
      JSON.stringify(result),
      Date.now(),
      id,
      user.id,
      Date.now(),
    ),
    stmt(
      db,
      `INSERT INTO clients(id,name,phone,phone_key,email,email_key,note,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.phone'),json_extract(value,'$.phone_key'),json_extract(value,'$.email'),json_extract(value,'$.email_key'),json_extract(value,'$.note'),?,? FROM json_each(?) WHERE ${guard}`,
      time,
      time,
      data,
      id,
      commitToken,
    ),
    stmt(
      db,
      `INSERT INTO client_import_keys(source,source_key,client_id,import_id) SELECT ?,json_extract(value,'$.key'),json_extract(value,'$.id'),? FROM json_each(?) WHERE ${guard}`,
      record.source,
      id,
      data,
      id,
      commitToken,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'client_import','client_import',?,?,? WHERE ${guard}`,
      user.id,
      id,
      JSON.stringify({ ...result, source: record.source }),
      time,
      id,
      commitToken,
    ),
  ]);
  record = await stmt(
    db,
    "SELECT * FROM client_imports WHERE id=? AND owner_id=?",
    id,
    user.id,
  ).first();
  if (record.status !== "applied")
    fail(
      409,
      "The client list changed after this preview. Preview the file again before importing.",
    );
  if (record.commit_token !== commitToken) return receipt();
  return json(result, 201);
}
export async function clientTransferRoutes(request, db, user) {
  const url = new URL(request.url),
    path = url.pathname;
  if (
    path !== "/api/clients/export.csv" &&
    !path.startsWith("/api/clients/import/")
  )
    return null;
  requireRole(user, "owner");
  if (path === "/api/clients/export.csv" && request.method === "GET") {
    if (
      url.searchParams.has("notes") &&
      !["true", "false"].includes(url.searchParams.get("notes"))
    )
      fail(400, "Choose whether to include notes.");
    const notes = url.searchParams.get("notes") === "true";
    const records = (
      await db
        .prepare(
          `SELECT id,name,phone,email${notes ? ",note" : ""} FROM clients ORDER BY name,id LIMIT 10001`,
        )
        .all()
    ).results;
    if (records.length > 10000)
      fail(
        400,
        "Export supports up to 10,000 clients. No partial export was produced.",
      );
    const headers = [
      "Rei client ID",
      "Full name",
      "Phone",
      "Email",
      ...(notes ? ["Notes"] : []),
    ];
    const csv =
      "\uFEFF" +
      [
        headers.map(csvCell).join(","),
        ...records.map((r) =>
          [r.id, r.name, r.phone, r.email, ...(notes ? [r.note] : [])]
            .map(csvCell)
            .join(","),
        ),
      ].join("\r\n") +
      "\r\n";
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="rei-clients-' +
          new Date().toISOString().slice(0, 10) +
          '.csv"',
      },
    });
  }
  if (request.method !== "POST") fail(405, "Use POST for client imports.");
  const body = await readJSON(
    request,
    path.endsWith("/commit") ? 20000 : BODY_LIMIT,
  );
  if (path === "/api/clients/import/inspect") {
    const { headers, rows, delimiter } = parseCSV(body.csv, body.delimiter);
    return json({
      headers,
      sample: rows.slice(0, 3).map((r) => r.map((c) => c.slice(0, 150))),
      total: rows.length,
      delimiter,
      reiExport: isReiExport(headers),
    });
  }
  await ensureClientTransferSchema(db);
  if (path === "/api/clients/import/preview") return preview(db, user, body);
  const match = path.match(/^\/api\/clients\/import\/([a-f0-9-]{36})\/commit$/);
  if (match) return commit(db, user, match[1], body);
  fail(404, "Client import action not found.");
}
