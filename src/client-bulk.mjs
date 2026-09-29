import { randomUUID } from "node:crypto";
import { fail, digest, readJSON } from "./security.mjs";
import { clientInput } from "./domain.mjs";
import { instagramHandle } from "./client-contacts.mjs";
import { isReiExport, decodeReiCell } from "./client-csv.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";
import { ensureClientBulk } from "./client-bulk-schema.mjs";
const stmt = (db, q, ...args) => db.prepare(q).bind(...args),
  json = (v, status = 200) => Response.json(v, { status });
const fields = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "email",
  "instagram",
  "note",
  "sourceId",
];
const fold = (v) =>
  v.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export const BULK_MAX_ROWS = 50000;
function mappingValid(headers, mapping) {
  if (
    !Array.isArray(headers) ||
    !headers.length ||
    headers.length > 40 ||
    headers.some((v) => typeof v !== "string" || !v.trim() || v.length > 150)
  )
    fail(400, "Include valid CSV column headers.");
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    fail(400, "Map the client columns first.");
  const used = new Set();
  for (const [key, col] of Object.entries(mapping)) {
    if (
      !fields.includes(key) ||
      !Number.isInteger(col) ||
      col < 0 ||
      col >= headers.length ||
      used.has(col)
    )
      fail(400, "Map each column to one valid client field.");
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
async function job(db, user, id) {
  const r = await stmt(
    db,
    "SELECT i.*,u.total,u.uploaded,u.phase,u.file_hash,u.config_json FROM client_imports i JOIN client_bulk_uploads u ON u.import_id=i.id WHERE i.id=? AND i.owner_id=?",
    id,
    user.id,
  ).first();
  if (!r) fail(404, "Import not found. Read the CSV again.");
  if (r.status !== "applied" && r.expires_at <= Date.now())
    fail(409, "This preview expired. Read the CSV again.");
  return r;
}
async function start(db, user, body) {
  mappingValid(body.headers, body.mapping);
  if (
    !["fresha", "rei", "other"].includes(body.source) ||
    !Number.isInteger(body.total) ||
    body.total < 1 ||
    body.total > BULK_MAX_ROWS ||
    !/^[a-f0-9]{64}$/.test(body.fileHash)
  )
    fail(400, "Choose a valid CSV of up to 50,000 clients.");
  const id = randomUUID(),
    time = Date.now(),
    expiry = time + 86400000;
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
      "INSERT INTO client_imports(id,owner_id,source,revision,plan_json,created_at,expires_at) SELECT ?,?,?,revision,'[]',?,? FROM client_transfer_state WHERE id=1",
      id,
      user.id,
      body.source,
      time,
      expiry,
    ),
    stmt(
      db,
      "INSERT INTO client_bulk_uploads(import_id,total,file_hash,config_json) VALUES(?,?,?,?)",
      id,
      body.total,
      body.fileHash,
      JSON.stringify({ headers: body.headers, mapping: body.mapping }),
    ),
  ]);
  return json({ id, total: body.total, uploaded: 0, expiresAt: expiry }, 201);
}
async function upload(db, user, r, body) {
  if (
    !Array.isArray(body.rows) ||
    !body.rows.length ||
    body.rows.length > 250 ||
    !Number.isInteger(body.offset) ||
    body.offset < 0 ||
    body.offset + body.rows.length > r.total
  )
    fail(400, "Invalid CSV upload part.");
  const hash = digest(JSON.stringify(body.rows)),
    prior = await stmt(
      db,
      "SELECT hash FROM client_bulk_chunks WHERE import_id=? AND offset=?",
      r.id,
      body.offset,
    ).first();
  if (prior) {
    if (prior.hash !== hash)
      fail(409, "This CSV part changed. Restart the import.");
    return json({ uploaded: r.uploaded, repeated: true });
  }
  if (
    r.phase !== "upload" ||
    r.status !== "preview" ||
    body.offset !== r.uploaded
  )
    fail(409, "Upload parts in order. Restart if the file changed.");
  const { headers, mapping } = JSON.parse(r.config_json),
    rei = r.source === "rei" && isReiExport(headers);
  const candidates = body.rows.map((cells, index) => {
    if (
      !Array.isArray(cells) ||
      cells.length !== headers.length ||
      cells.some(
        (c) =>
          typeof c !== "string" ||
          c.length > 8000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(c),
      )
    )
      fail(400, "Invalid CSV cells. Save a UTF-8 file and try again.");
    const get = (k) => {
      const v = mapping[k] === undefined ? "" : cells[mapping[k]];
      return rei ? decodeReiCell(v) : v;
    };
    const name =
      mapping.name === undefined
        ? [get("firstName").trim(), get("lastName").trim()]
            .filter(Boolean)
            .join(" ")
        : get("name");
    const row = {
      row: body.offset + index + 2,
      id: randomUUID(),
      status: "new",
      message: "Ready to add.",
      matches: [],
    };
    try {
      row.client = {
        ...clientInput({
          name,
          phone: get("phone"),
          email: get("email"),
          note: get("note"),
        }),
        instagram: instagramHandle(get("instagram")),
      };
      row.external = get("sourceId").trim();
      if (row.external.length > 200)
        fail(400, "Source client IDs must be 200 characters or fewer.");
      row.key = row.external
        ? "id:" + digest(row.external)
        : "row:" + r.file_hash + ":" + (body.offset + index);
    } catch (e) {
      row.client = {
        name: name.slice(0, 100),
        phone: get("phone").slice(0, 30),
        email: get("email").slice(0, 254),
        instagram: get("instagram").slice(0, 30),
        note: "",
      };
      row.status = "invalid";
      row.message = e.message;
      row.key = "invalid:" + row.row;
    }
    row.fingerprint = digest(JSON.stringify([row.client, row.external || ""]));
    return row;
  });
  const valid = candidates.filter((c) => c.status !== "invalid"),
    phones = valid.map((c) => c.client.phone_key).filter(Boolean),
    emails = valid.map((c) => c.client.email_key).filter(Boolean),
    instagrams = valid.map((c) => c.client.instagram).filter(Boolean),
    keys = valid.map((c) => c.key),
    ids = rei ? valid.map((c) => c.external).filter(Boolean) : [],
    names = valid.map((c) => c.client.name.toLowerCase());
  // Contact/source lookups use indexes and are bounded to this upload part.
  const snapshots = await db.batch([
    stmt(
      db,
      `SELECT c.id,c.name,c.phone,c.phone_key,c.email,c.email_key,COALESCE(g.instagram,'') AS instagram FROM clients c LEFT JOIN client_instagram g ON g.client_id=c.id WHERE c.id IN (
   SELECT id FROM clients WHERE phone_key IN(SELECT value FROM json_each(?)) UNION SELECT id FROM clients WHERE email_key IN(SELECT value FROM json_each(?)) UNION SELECT client_id FROM client_instagram WHERE instagram IN(SELECT value FROM json_each(?)) UNION SELECT client_id FROM client_import_keys WHERE source=? AND source_key IN(SELECT value FROM json_each(?)) UNION SELECT id FROM clients WHERE id IN(SELECT value FROM json_each(?)))`,
      JSON.stringify(phones),
      JSON.stringify(emails),
      JSON.stringify(instagrams),
      r.source,
      JSON.stringify(keys),
      JSON.stringify(ids),
    ),
    stmt(
      db,
      "SELECT source_key,client_id FROM client_import_keys WHERE source=? AND source_key IN(SELECT value FROM json_each(?))",
      r.source,
      JSON.stringify(keys),
    ),
    stmt(
      db,
      "SELECT DISTINCT LOWER(name) AS name FROM clients WHERE LOWER(name) IN(SELECT value FROM json_each(?))",
      JSON.stringify(names),
    ),
  ]);
  const clients = snapshots[0].results,
    byId = new Map(clients.map((c) => [c.id, c])),
    byPhone = new Map(
      clients.filter((c) => c.phone_key).map((c) => [c.phone_key, c]),
    ),
    byEmail = new Map(
      clients.filter((c) => c.email_key).map((c) => [c.email_key, c]),
    ),
    byInstagram = new Map(
      clients.filter((c) => c.instagram).map((c) => [c.instagram, c]),
    ),
    byKey = new Map(
      snapshots[1].results.map((c) => [c.source_key, c.client_id]),
    ),
    byName = new Set(snapshots[2].results.map((c) => fold(c.name)));
  for (const row of valid) {
    const c = row.client,
      matches = [
        byId.get(byKey.get(row.key)),
        rei ? byId.get(row.external) : null,
        byPhone.get(c.phone_key),
        byEmail.get(c.email_key),
        byInstagram.get(c.instagram),
      ].filter(Boolean);
    row.matches = [
      ...new Map(
        matches.map((m) => [
          m.id,
          { id: m.id, name: m.name, phone: m.phone, instagram: m.instagram },
        ]),
      ).values(),
    ];
    if (
      row.matches.length > 1 ||
      matches.some(
        (m) =>
          fold(m.name) !== fold(c.name) ||
          ["phone_key", "email_key", "instagram"].some(
            (k) => c[k] && m[k] && c[k] !== m[k],
          ),
      )
    ) {
      row.status = "conflict";
      row.message =
        "Details disagree with an existing client. Review the linked profile; nothing will be overwritten.";
    } else if (row.matches.length) {
      row.status = "existing";
      row.message =
        "Existing client. Skipped; stored details remain unchanged.";
    } else if (
      byName.has(fold(c.name)) ||
      (!c.phone_key && !c.email_key && !c.instagram)
    ) {
      row.status = "review";
      row.message = byName.has(fold(c.name))
        ? "This name already exists. Select only if this is another person."
        : "No phone, email or Instagram. Check identity before selecting.";
    }
  }
  const token = randomUUID(),
    guard = `EXISTS(SELECT 1 FROM client_bulk_chunks WHERE import_id=? AND offset=? AND token=?)`,
    packed = JSON.stringify(candidates);
  await db.batch([
    stmt(
      db,
      `INSERT INTO client_bulk_chunks(import_id,offset,hash,token) SELECT i.id,?,?,? FROM client_imports i JOIN client_bulk_uploads u ON u.import_id=i.id WHERE i.id=? AND i.status='preview' AND i.expires_at>? AND u.phase='upload' AND u.uploaded=? AND NOT EXISTS(SELECT 1 FROM client_bulk_chunks WHERE import_id=i.id AND offset=?)`,
      body.offset,
      hash,
      token,
      r.id,
      Date.now(),
      body.offset,
      body.offset,
    ),
    stmt(
      db,
      `INSERT INTO client_bulk_rows(import_id,row_num,client_id,source_key,data_json,status,message,matches_json,fingerprint) SELECT ?,json_extract(value,'$.row'),json_extract(value,'$.id'),json_extract(value,'$.key'),json_extract(value,'$.client'),json_extract(value,'$.status'),json_extract(value,'$.message'),json_extract(value,'$.matches'),json_extract(value,'$.fingerprint') FROM json_each(?) WHERE ${guard}`,
      r.id,
      packed,
      r.id,
      body.offset,
      token,
    ),
    ...[
      ["phone", "phone_key"],
      ["email", "email_key"],
      ["instagram", "instagram"],
      ["source", "key"],
    ].map(([kind, key]) =>
      stmt(
        db,
        `INSERT INTO client_bulk_contacts(import_id,row_num,kind,value,fingerprint) SELECT import_id,row_num,?,${key === "key" ? "source_key" : "json_extract(data_json,'$." + key + "')"},fingerprint FROM client_bulk_rows WHERE import_id=? AND row_num BETWEEN ? AND ? AND status!='invalid' AND ${key === "key" ? "source_key LIKE 'id:%'" : "COALESCE(json_extract(data_json,'$." + key + "'),'')!=''"} AND ${guard}`,
        kind,
        r.id,
        body.offset + 2,
        body.offset + body.rows.length + 1,
        r.id,
        body.offset,
        token,
      ),
    ),
    stmt(
      db,
      `UPDATE client_bulk_uploads SET uploaded=uploaded+? WHERE import_id=? AND ${guard}`,
      body.rows.length,
      r.id,
      r.id,
      body.offset,
      token,
    ),
  ]);
  const done = await stmt(
    db,
    "SELECT hash FROM client_bulk_chunks WHERE import_id=? AND offset=?",
    r.id,
    body.offset,
  ).first();
  if (!done || done.hash !== hash)
    fail(409, "The CSV upload changed. Restart the import.");
  return json({ uploaded: (await job(db, user, r.id)).uploaded });
}
async function page(db, r, index = 0, initial = false) {
  if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(r.total / 50))
    fail(400, "Choose a valid preview page.");
  if (r.status !== "preview" || r.phase !== "ready")
    fail(409, "Finish uploading the CSV before reviewing it.");
  const rows = (
    await stmt(
      db,
      "SELECT row_num,data_json,status,message,matches_json FROM client_bulk_rows WHERE import_id=? ORDER BY row_num LIMIT 50 OFFSET ?",
      r.id,
      index * 50,
    ).all()
  ).results;
  const counts = Object.fromEntries(
    (
      await stmt(
        db,
        "SELECT status,COUNT(*) AS n FROM client_bulk_rows WHERE import_id=? GROUP BY status",
        r.id,
      ).all()
    ).results.map((c) => [c.status, c.n]),
  );
  return json({
    id: r.id,
    expiresAt: r.expires_at,
    total: r.total,
    page: index,
    counts,
    rows: rows.map((c) => ({
      row: c.row_num,
      client: JSON.parse(c.data_json),
      status: c.status,
      message: c.message,
      matches: JSON.parse(c.matches_json),
    })),
    ...(initial
      ? {
          readyRows: (
            await stmt(
              db,
              "SELECT row_num FROM client_bulk_rows WHERE import_id=? AND status='new' ORDER BY row_num",
              r.id,
            ).all()
          ).results.map((c) => c.row_num),
        }
      : {}),
  });
}
async function finalize(db, user, r) {
  if (r.status !== "preview" || r.uploaded !== r.total)
    fail(409, "Upload the entire CSV before reviewing it.");
  if (r.phase === "ready") return page(db, r, 0, true);
  const guard = `EXISTS(SELECT 1 FROM client_imports i JOIN client_bulk_uploads u ON u.import_id=i.id WHERE i.id=? AND i.status='preview' AND u.phase='upload' AND u.uploaded=u.total)`;
  await db.batch([
    stmt(
      db,
      `UPDATE client_bulk_rows SET status='conflict',message='Rows in this file share contact details or an ID but have different details. Correct the file or use the existing profile.' WHERE import_id=? AND status!='invalid' AND row_num IN(SELECT c.row_num FROM client_bulk_contacts c JOIN (SELECT kind,value FROM client_bulk_contacts WHERE import_id=? GROUP BY kind,value HAVING COUNT(DISTINCT fingerprint)>1) bad ON bad.kind=c.kind AND bad.value=c.value WHERE c.import_id=?) AND ${guard}`,
      r.id,
      r.id,
      r.id,
      r.id,
    ),
    stmt(
      db,
      `UPDATE client_bulk_rows SET status='duplicate',message='Identical ID/contact row appears earlier in this file. Skipped.' WHERE import_id=? AND status NOT IN('invalid','conflict') AND row_num IN(SELECT c.row_num FROM client_bulk_contacts c JOIN (SELECT kind,value,MIN(row_num) AS first_row FROM client_bulk_contacts WHERE import_id=? GROUP BY kind,value HAVING COUNT(*)>1) dup ON dup.kind=c.kind AND dup.value=c.value WHERE c.import_id=? AND c.row_num>dup.first_row) AND ${guard}`,
      r.id,
      r.id,
      r.id,
      r.id,
    ),
    stmt(
      db,
      `UPDATE client_bulk_uploads SET phase='ready' WHERE import_id=? AND ${guard}`,
      r.id,
      r.id,
    ),
  ]);
  return page(db, await job(db, user, r.id), 0, true);
}
async function commit(db, user, r, body) {
  const selected = body.rows;
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > BULK_MAX_ROWS ||
    selected.some((n) => !Number.isInteger(n)) ||
    new Set(selected).size !== selected.length
  )
    fail(400, "Select valid rows without repeats.");
  const selection = JSON.stringify([...selected].sort((a, b) => a - b)),
    hash = digest(selection);
  const receipt = (record) => {
    if (record.selection_hash !== hash)
      fail(
        409,
        "This import was already saved with another selection. Create a new preview.",
      );
    return json({ ...JSON.parse(record.result_json), repeated: true });
  };
  if (r.status === "applied") return receipt(r);
  if (r.phase !== "ready")
    fail(409, "Review the complete file before importing.");
  const eligible = await stmt(
    db,
    "SELECT COUNT(*) AS n FROM client_bulk_rows WHERE import_id=? AND status IN('new','review') AND row_num IN(SELECT value FROM json_each(?))",
    r.id,
    selection,
  ).first();
  if (eligible.n !== selected.length) {
    const latest = await job(db, user, r.id);
    if (latest.status === "applied") return receipt(latest);
    fail(400, "Only new rows or rows marked for review can be imported.");
  }
  const result = {
      id: r.id,
      created: selected.length,
      skipped: r.total - selected.length,
    },
    token = randomUUID(),
    time = new Date().toISOString();
  const guard = `EXISTS(SELECT 1 FROM client_imports WHERE id=? AND commit_token=?)`,
    rows = `FROM client_bulk_rows WHERE import_id=? AND row_num IN(SELECT value FROM json_each(?)) AND ${guard}`;
  await db.batch([
    stmt(
      db,
      "UPDATE client_imports SET status='applied',commit_token=?,selection_hash=?,result_json=?,committed_at=? WHERE id=? AND status='preview' AND expires_at>? AND revision=(SELECT revision FROM client_transfer_state WHERE id=1)",
      token,
      hash,
      JSON.stringify(result),
      Date.now(),
      r.id,
      Date.now(),
    ),
    stmt(
      db,
      `INSERT INTO clients(id,name,phone,phone_key,email,email_key,note,created_at,updated_at) SELECT client_id,json_extract(data_json,'$.name'),json_extract(data_json,'$.phone'),json_extract(data_json,'$.phone_key'),json_extract(data_json,'$.email'),json_extract(data_json,'$.email_key'),json_extract(data_json,'$.note'),?,? ${rows}`,
      time,
      time,
      r.id,
      selection,
      r.id,
      token,
    ),
    stmt(
      db,
      `INSERT INTO client_instagram(client_id,instagram) SELECT client_id,NULLIF(json_extract(data_json,'$.instagram'),'') ${rows}`,
      r.id,
      selection,
      r.id,
      token,
    ),
    stmt(
      db,
      `INSERT INTO client_import_keys(source,source_key,client_id,import_id) SELECT ?,source_key,client_id,import_id ${rows}`,
      r.source,
      r.id,
      selection,
      r.id,
      token,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'client_import','client_import',?,?,? WHERE ${guard}`,
      user.id,
      r.id,
      JSON.stringify({ ...result, source: r.source }),
      time,
      r.id,
      token,
    ),
    stmt(
      db,
      `DELETE FROM client_bulk_rows WHERE import_id=? AND ${guard}`,
      r.id,
      r.id,
      token,
    ),
    stmt(
      db,
      `DELETE FROM client_bulk_chunks WHERE import_id=? AND ${guard}`,
      r.id,
      r.id,
      token,
    ),
    stmt(
      db,
      `UPDATE client_bulk_uploads SET config_json='{}' WHERE import_id=? AND ${guard}`,
      r.id,
      r.id,
      token,
    ),
  ]);
  const saved = await job(db, user, r.id);
  if (saved.status !== "applied")
    fail(
      409,
      "The client list changed after this preview. Read the CSV again before importing.",
    );
  return saved.commit_token === token ? json(result, 201) : receipt(saved);
}
export async function bulkRoutes(request, db, user) {
  await ensureClientTransferSchema(db);
  await ensureClientBulk(db);
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/api/clients/import/bulk/start" && request.method === "POST")
    return start(db, user, await readJSON(request, 16000));
  const m = path.match(
    /^\/api\/clients\/import\/bulk\/([a-f0-9-]{36})\/(upload|finalize|page|commit)$/,
  );
  if (!m) fail(404, "Import action not found.");
  const r = await job(db, user, m[1]);
  if (m[2] === "page" && request.method === "GET")
    return page(
      db,
      r,
      Number(url.searchParams.get("page") || 0),
      url.searchParams.get("selection") === "1",
    );
  if (request.method !== "POST") fail(405, "Use POST for this import action.");
  const body = await readJSON(request, m[2] === "upload" ? 2097152 : 1048576);
  if (m[2] === "upload") return upload(db, user, r, body);
  if (m[2] === "finalize") return finalize(db, user, r);
  if (m[2] === "commit") return commit(db, user, r, body);
  fail(404, "Import action not found.");
}
