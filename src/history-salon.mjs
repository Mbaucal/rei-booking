import { randomUUID } from "node:crypto";
import { digest, fail, readJSON, requireRole, token } from "./security.mjs";
import { ensureClientContacts } from "./client-contacts.mjs";
import { ensureClientTransferSchema } from "./client-transfer-schema.mjs";
import { ensureHistoryPreviewSchema } from "./history-preview-schema.mjs";
import { parseHistoryMoney } from "./history-normalize.mjs";
import { ensureHistoryArchiveSchema } from "./history-archive-schema.mjs";
import { ensureHistorySalonSchema } from "./history-salon-schema.mjs";
import { suggestedTreatmentColour } from "./treatment-colours.mjs";
export const HISTORY_SALON_LIMITS = Object.freeze({
  rows: 50000,
  candidates: 1000,
  catalogue: 2000,
  bytes: 1800000,
  ttl: 15 * 60 * 1000,
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
export const historySalonLabelKey = (value) =>
  typeof value === "string"
    ? value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
    : "";
const keyFor = (kind, source, labelKey, duration) =>
  digest(canonical([kind, source, labelKey, duration]));
const archiveClock = "(SELECT revision FROM history_archive_state WHERE id=1)";
const catalogueClock = "(SELECT revision FROM history_salon_state WHERE id=1)";
export function resolveHistoryNetSales(record, settings = {}) {
  const stored = record?.interpretation?.money ?? {};
  const currency = record?.currency ?? stored.currency ?? null;
  const units = currency ? stored.minorUnitDigits : settings.minorUnitDigits;
  const targetCurrency = currency ?? settings.currency ?? null;
  const unknown = (issue) => ({
    amountMinor: null,
    currency: targetCurrency,
    minorUnitDigits: Number.isInteger(units) ? units : null,
    basis: "unknown",
    issue,
  });
  if (!targetCurrency || !Number.isInteger(units) || units < 0 || units > 4)
    return unknown("currency_unconfirmed");
  if (currency && Number.isSafeInteger(record?.sourceNetSalesMinor))
    return {
      amountMinor: record.sourceNetSalesMinor,
      currency,
      minorUnitDigits: units,
      basis: "source",
      issue: null,
    };
  if (typeof record?.raw?.netSales !== "string" || !record.raw.netSales.trim())
    return unknown("missing_net_sales");
  const format = {
    currency: targetCurrency,
    minorUnitDigits: units,
    decimalSeparator: stored.decimalSeparator ?? ".",
    groupSeparator: stored.groupSeparator ?? null,
  };
  if (
    ![".", ","].includes(format.decimalSeparator) ||
    ![null, ".", ",", " "].includes(format.groupSeparator) ||
    format.decimalSeparator === format.groupSeparator
  )
    return unknown("invalid_money_format");
  const parsed = parseHistoryMoney(record.raw.netSales.trim(), format);
  if (parsed.error || parsed.unknown)
    return unknown(parsed.error ?? "currency_unconfirmed");
  return {
    amountMinor: parsed.minor,
    currency: targetCurrency,
    minorUnitDigits: units,
    basis: currency ? "source" : "owner-confirmed",
    issue: null,
  };
}
export async function readHistorySalonContext(db) {
  await ensureClientContacts(db);
  await ensureClientTransferSchema(db);
  await ensureHistoryPreviewSchema(db);
  await ensureHistoryArchiveSchema(db);
  await ensureHistorySalonSchema(db);
  const [settings, links, clocks] = await db.batch([
    stmt(
      db,
      "SELECT currency,minor_unit_digits,time_zone,version FROM history_salon_settings WHERE id=1",
    ),
    stmt(
      db,
      "SELECT kind,source,label_key,duration,entity_id FROM history_catalogue_links ORDER BY kind,source,label_key,duration LIMIT 10001",
    ),
    stmt(
      db,
      `SELECT ${archiveClock} AS archiveRevision,${catalogueClock} AS catalogueRevision`,
    ),
  ]);
  if (links.results.length > 10000)
    fail(
      422,
      "Historical catalogue mappings exceed the supported limit; none were truncated.",
    );
  const s = settings.results[0];
  return {
    ...clocks.results[0],
    settings: {
      currency: s.currency,
      minorUnitDigits: s.minor_unit_digits,
      timeZone: s.time_zone,
      version: s.version,
    },
    links: links.results.map((r) => ({
      kind: r.kind,
      source: r.source,
      labelKey: r.label_key,
      duration: r.duration,
      entityId: r.entity_id,
    })),
  };
}
const warnings = [
  "Historical Net Sales is source revenue after source adjustments, not an approved current menu price. Enter and approve each new treatment price.",
  "Historical therapists are created inactive with every working day disabled. No login accounts or bonus rules are created.",
  "Existing catalogue records and archived evidence remain unchanged. Confirmed currency and timezone apply only to previously unknown source facts.",
];
async function preview(db, user, url) {
  const hasDraft = ["currency", "minorUnitDigits", "timeZone"].some((k) =>
    url.searchParams.has(k),
  );
  const draftSettings = hasDraft
    ? settingsInput({
        currency: url.searchParams.get("currency"),
        minorUnitDigits: Number(url.searchParams.get("minorUnitDigits")),
        timeZone: url.searchParams.get("timeZone"),
      })
    : null;
  const clocks = await stmt(
    db,
    `SELECT ${archiveClock} AS archive_revision,${catalogueClock} AS catalogue_revision`,
  ).first();
  const summary = await stmt(
    db,
    "SELECT COUNT(*) AS rows,MIN(date) AS from_date,MAX(date) AS to_date FROM history_archive",
  ).first();
  if (summary.rows > HISTORY_SALON_LIMITS.rows)
    fail(
      422,
      "Salon setup supports up to 50,000 archived rows in one review; no rows were omitted.",
    );
  // Project only catalogue labels and the latest nonempty source amount. No
  // client identities or complete source records leave the database here.
  const groups = (
    await stmt(
      db,
      `WITH labels AS (
    SELECT 'therapist' AS kind,source,json_extract(record_json,'$.sourceTherapistLabel') AS label,0 AS duration,COUNT(*) AS count FROM history_archive GROUP BY source,label
    UNION ALL
    SELECT 'service',source,json_extract(record_json,'$.sourceServiceLabel') AS label,duration,COUNT(*) AS count FROM history_archive GROUP BY source,label,duration
  ) SELECT * FROM labels WHERE label IS NOT NULL AND trim(label)!='' ORDER BY kind,source,label,duration LIMIT 1001`,
    ).all()
  ).results;
  if (groups.length > 1000)
    fail(
      422,
      "More than 1,000 source label/duration groups need review. No groups were silently truncated.",
    );
  const labelBytes = Buffer.byteLength(JSON.stringify(groups));
  if (labelBytes > 700000)
    fail(
      422,
      "Historical catalogue labels are too large for one safe review. Correct unusually long source labels.",
    );
  const [therapists, services] = await db.batch([
    stmt(
      db,
      "SELECT id,name,version,active FROM therapists ORDER BY name,id LIMIT 2001",
    ),
    stmt(
      db,
      "SELECT id,name,duration,price_cents AS priceMinor,version,active FROM services ORDER BY name,duration,id LIMIT 2001",
    ),
  ]);
  if (therapists.results.length + services.results.length > 2000)
    fail(
      422,
      "The current catalogue is too large for this review; no records were truncated.",
    );
  const context = await readHistorySalonContext(db),
    proposedSettings = draftSettings
      ? { ...draftSettings, version: context.settings.version }
      : context.settings,
    catalogue = {
      therapists: therapists.results.map((r) => ({
        ...r,
        active: Boolean(r.active),
      })),
      services: services.results.map((r) => ({
        ...r,
        active: Boolean(r.active),
      })),
    };
  const candidates = new Map();
  for (const g of groups) {
    const labelKey = historySalonLabelKey(g.label),
      key = keyFor(g.kind, g.source, labelKey, g.duration);
    if (!labelKey) continue;
    const c = candidates.get(key) ?? {
      key,
      kind: g.kind,
      source: g.source,
      label: g.label,
      labelKey,
      duration: g.kind === "therapist" ? null : g.duration,
      count: 0,
      match: null,
      matchCandidates: [],
      existingLink: null,
      issues: [],
      latestNet: null,
    };
    c.count += g.count;
    candidates.set(key, c);
  }
  // One bounded batched query obtains the latest nonempty raw amount for each
  // original service label; the field is a suggestion, never a menu assignment.
  const priceGroups = groups.filter((g) => g.kind === "service");
  const moneyRows = priceGroups.length
    ? (
        await stmt(
          db,
          `WITH projected AS (
    SELECT source,json_extract(record_json,'$.sourceServiceLabel') AS label,duration,date,start_minute,id,
      json_extract(record_json,'$.raw.netSales') AS raw,
      json_extract(record_json,'$.sourceNetSalesMinor') AS amount,
      json_extract(record_json,'$.currency') AS currency,
      json_extract(record_json,'$.interpretation.money') AS money
    FROM history_archive WHERE json_extract(record_json,'$.raw.netSales') IS NOT NULL AND trim(json_extract(record_json,'$.raw.netSales'))!=''
  ), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY source,label,duration ORDER BY date DESC,start_minute DESC,id DESC) AS rank FROM projected)
  SELECT source,label,duration,date,start_minute,id,raw,amount,currency,money FROM ranked WHERE rank=1 LIMIT 1001`,
        ).all()
      ).results
    : [];
  if (
    moneyRows.length > 1000 ||
    Buffer.byteLength(JSON.stringify(moneyRows)) > 700000
  )
    fail(
      422,
      "Historical price evidence is too large for one safe review; no prices were truncated.",
    );
  for (const g of moneyRows) {
    const c = candidates.get(
      keyFor("service", g.source, historySalonLabelKey(g.label), g.duration),
    );
    if (!c) continue;
    const ordering = `${g.date}|${String(g.start_minute).padStart(4, "0")}|${g.id}`;
    if (c._latest && c._latest >= ordering) continue;
    c._latest = ordering;
    const value = resolveHistoryNetSales(
      {
        raw: { netSales: g.raw },
        sourceNetSalesMinor: g.amount,
        currency: g.currency,
        interpretation: { money: g.money ? JSON.parse(g.money) : {} },
      },
      proposedSettings,
    );
    if (
      draftSettings &&
      value.basis === "owner-confirmed" &&
      !context.settings.currency
    )
      value.basis = "draft-assumption";
    c.latestNet = { raw: g.raw, ...value, date: g.date };
  }
  for (const c of candidates.values()) {
    delete c._latest;
    const available =
      c.kind === "therapist" ? catalogue.therapists : catalogue.services;
    c.matchCandidates = available
      .filter(
        (r) =>
          historySalonLabelKey(r.name) === c.labelKey &&
          (c.kind === "therapist" || r.duration === c.duration),
      )
      .map((r) => ({ id: r.id, name: r.name, version: r.version }));
    c.match = c.matchCandidates.length === 1 ? c.matchCandidates[0] : null;
    c.existingLink =
      context.links.find(
        (l) =>
          l.kind === c.kind &&
          l.source === c.source &&
          l.labelKey === c.labelKey &&
          l.duration === (c.duration ?? 0),
      )?.entityId ?? null;
    if (c.matchCandidates.length > 1)
      c.issues.push({
        code: "ambiguous_name",
        message:
          "Several current records match this source name. Choose the correct one explicitly.",
      });
    if (
      c.kind === "service" &&
      (!Number.isInteger(c.duration) ||
        c.duration < 5 ||
        c.duration > 720 ||
        c.duration % 5)
    )
      c.issues.push({
        code: "duration_correction",
        message:
          "Correct the duration to a current 5-minute menu duration, or skip this source treatment.",
      });
    if (c.label.length > (c.kind === "therapist" ? 70 : 120))
      c.issues.push({
        code: "name_correction",
        message:
          "Shorten the display name when creating this catalogue record.",
      });
  }
  const fingerprint = digest(
    canonical({
      archiveRevision: clocks.archive_revision,
      catalogueRevision: clocks.catalogue_revision,
      candidates: [...candidates.values()],
      settings: proposedSettings,
    }),
  );
  const id = randomUUID(),
    secret = token(),
    now = Date.now(),
    response = {
      previewId: id,
      token: secret,
      expiresAt: now + HISTORY_SALON_LIMITS.ttl,
      fingerprint,
      archiveRevision: clocks.archive_revision,
      catalogueRevision: clocks.catalogue_revision,
      settings: proposedSettings,
      settingsConfirmed: Boolean(
        context.settings.currency &&
        context.settings.timeZone &&
        (!draftSettings ||
          (context.settings.currency === draftSettings.currency &&
            context.settings.minorUnitDigits ===
              draftSettings.minorUnitDigits &&
            context.settings.timeZone === draftSettings.timeZone)),
      ),
      summary: {
        rows: summary.rows,
        from: summary.from_date,
        to: summary.to_date,
      },
      therapists: [...candidates.values()].filter(
        (c) => c.kind === "therapist",
      ),
      services: [...candidates.values()].filter((c) => c.kind === "service"),
      catalogue,
      warnings,
    };
  const snapshot = JSON.stringify(response);
  if (Buffer.byteLength(snapshot) > HISTORY_SALON_LIMITS.bytes)
    fail(
      422,
      "The catalogue review is too large to store safely. No source records were omitted.",
    );
  await db.batch([
    stmt(
      db,
      "DELETE FROM history_salon_previews WHERE expires_at<=? OR owner_id=?",
      now,
      user.id,
    ),
    stmt(
      db,
      `INSERT INTO history_salon_previews(id,owner_id,token_hash,archive_revision,catalogue_revision,fingerprint,snapshot_json,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${archiveClock}=? AND ${catalogueClock}=?`,
      id,
      user.id,
      digest(secret),
      clocks.archive_revision,
      clocks.catalogue_revision,
      fingerprint,
      snapshot,
      now,
      response.expiresAt,
      clocks.archive_revision,
      clocks.catalogue_revision,
    ),
  ]);
  if (
    !(await stmt(
      db,
      "SELECT id FROM history_salon_previews WHERE id=?",
      id,
    ).first())
  )
    fail(
      409,
      "Archived history or the catalogue changed while preparing this review. Load it again.",
    );
  return json(response);
}
function settingsInput(s) {
  if (
    !s ||
    Object.keys(s).some(
      (k) => !["currency", "minorUnitDigits", "timeZone"].includes(k),
    ) ||
    s.currency !== "RSD" ||
    s.minorUnitDigits !== 2 ||
    s.timeZone !== "Europe/Belgrade"
  )
    fail(
      400,
      "Explicitly confirm RSD, two decimal places and the source timezone.",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: s.timeZone }).format(0);
  } catch {
    fail(400, "Choose a valid IANA source timezone.");
  }
  return {
    currency: s.currency,
    minorUnitDigits: s.minorUnitDigits,
    timeZone: s.timeZone,
  };
}
function displayName(value, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `Enter a display name of 1–${max} characters.`);
  return value.trim();
}
async function apply(db, user, body) {
  if (
    Object.keys(body).some(
      (k) =>
        ![
          "previewId",
          "token",
          "fingerprint",
          "requestId",
          "acknowledgeReview",
          "settings",
          "choices",
        ].includes(k),
    ) ||
    typeof body.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId) ||
    typeof body.previewId !== "string" ||
    body.acknowledgeReview !== true
  )
    fail(400, "Review the complete catalogue setup and explicitly confirm it.");
  const hash = digest(canonical(body));
  const replay = async () => {
    const r = await stmt(
      db,
      "SELECT body_hash,result_json FROM history_salon_receipts WHERE owner_id=? AND request_id=?",
      user.id,
      body.requestId,
    ).first();
    if (!r) return null;
    if (r.body_hash !== hash)
      fail(409, "This setup request was already used with different choices.");
    return JSON.parse(r.result_json);
  };
  const repeated = await replay();
  if (repeated) return json({ ...repeated, repeated: true });
  const r = await stmt(
    db,
    "SELECT * FROM history_salon_previews WHERE id=? AND owner_id=?",
    body.previewId,
    user.id,
  ).first();
  if (!r) fail(404, "Salon setup review not found.");
  if (r.expires_at <= Date.now())
    fail(410, "This salon setup review expired. Load it again.");
  if (
    typeof body.token !== "string" ||
    digest(body.token) !== r.token_hash ||
    body.fingerprint !== r.fingerprint
  )
    fail(409, "The setup choices do not match this reviewed catalogue.");
  const settings = settingsInput(body.settings),
    snapshot = JSON.parse(r.snapshot_json),
    candidates = [...snapshot.therapists, ...snapshot.services];
  if (
    !Array.isArray(body.choices) ||
    body.choices.length !== candidates.length ||
    new Set(body.choices.map((c) => c?.key)).size !== candidates.length
  )
    fail(
      400,
      "Choose create, link or skip for every source catalogue entry exactly once.",
    );
  const byKey = new Map(candidates.map((c) => [c.key, c])),
    newEntities = new Map(),
    links = [],
    skipped = [];
  for (const choice of body.choices) {
    if (
      !choice ||
      Object.keys(choice).some(
        (k) =>
          ![
            "key",
            "action",
            "entityId",
            "name",
            "duration",
            "priceMinor",
            "active",
          ].includes(k),
      ) ||
      !["skip", "link", "create"].includes(choice.action)
    )
      fail(400, "Choose a valid setup action.");
    const c = byKey.get(choice.key);
    if (!c) fail(400, "A setup choice is not part of this review.");
    if (choice.action === "skip") {
      skipped.push(c.key);
      continue;
    }
    let entityId;
    if (choice.action === "link") {
      const catalogue =
        c.kind === "therapist"
          ? snapshot.catalogue.therapists
          : snapshot.catalogue.services;
      if (!catalogue.some((e) => e.id === choice.entityId))
        fail(400, "Choose a current catalogue record from this review.");
      entityId = choice.entityId;
    } else {
      if (c.existingLink)
        fail(
          409,
          "This source label is already mapped. Keep its existing link instead of creating another record.",
        );
      const name = displayName(choice.name, c.kind === "therapist" ? 70 : 120),
        duration = c.kind === "service" ? choice.duration : 0;
      if (
        c.kind === "therapist" &&
        (choice.active !== undefined ||
          choice.priceMinor !== undefined ||
          choice.duration !== undefined)
      )
        fail(
          400,
          "Historical therapists are created inactive without scheduling or price fields.",
        );
      if (
        c.kind === "service" &&
        (!Number.isInteger(duration) ||
          duration < 5 ||
          duration > 720 ||
          duration % 5 ||
          !Number.isInteger(choice.priceMinor) ||
          choice.priceMinor <= 0 ||
          choice.priceMinor > 100000000 ||
          typeof choice.active !== "boolean")
      )
        fail(
          400,
          "Approve a positive treatment price, valid 5-minute duration and explicit active status.",
        );
      const catalogue =
        c.kind === "therapist"
          ? snapshot.catalogue.therapists
          : snapshot.catalogue.services;
      if (
        catalogue.some(
          (e) =>
            historySalonLabelKey(e.name) === historySalonLabelKey(name) &&
            (c.kind === "therapist" || e.duration === duration),
        )
      )
        fail(
          409,
          "A current catalogue record already has this name and duration. Link it explicitly instead of creating a duplicate.",
        );
      const dedupe = canonical([c.kind, historySalonLabelKey(name), duration]),
        entry = {
          kind: c.kind,
          name,
          duration,
          priceMinor: c.kind === "service" ? choice.priceMinor : null,
          color: c.kind === "service" ? suggestedTreatmentColour(name) : null,
          active: c.kind === "service" ? choice.active : false,
        };
      if (newEntities.has(dedupe)) {
        const prior = newEntities.get(dedupe);
        if (
          prior.priceMinor !== entry.priceMinor ||
          prior.active !== entry.active
        )
          fail(
            400,
            "Repeated source labels must agree on the reviewed current price and active status.",
          );
        entityId = prior.id;
      } else {
        entityId = randomUUID();
        newEntities.set(dedupe, { ...entry, id: entityId });
      }
    }
    if (c.existingLink && c.existingLink !== entityId)
      fail(
        409,
        "An existing historical catalogue link cannot be silently reassigned.",
      );
    links.push({
      kind: c.kind,
      source: c.source,
      labelKey: c.labelKey,
      duration: c.duration ?? 0,
      entityId,
    });
  }
  const entities = [...newEntities.values()],
    id = randomUUID(),
    mutation = randomUUID(),
    now = new Date().toISOString(),
    result = {
      setupId: id,
      createdTherapists: entities.filter((e) => e.kind === "therapist").length,
      createdServices: entities.filter((e) => e.kind === "service").length,
      linked: links.length,
      skipped: skipped.length,
      settings,
      warnings,
    };
  const guard = `EXISTS(SELECT 1 FROM history_salon_receipts WHERE id=? AND mutation_token=?)`,
    packed = JSON.stringify(entities),
    packedLinks = JSON.stringify(links);
  if (
    Buffer.byteLength(packed) > HISTORY_SALON_LIMITS.bytes ||
    Buffer.byteLength(packedLinks) > HISTORY_SALON_LIMITS.bytes
  )
    fail(422, "The setup choices exceed the safe write size.");
  const disabledWeek = JSON.stringify(
    Array.from({ length: 7 }, () => ({
      enabled: false,
      start: 600,
      end: 1320,
    })),
  );
  await db.batch([
    stmt(
      db,
      `INSERT OR IGNORE INTO history_salon_receipts(id,owner_id,request_id,body_hash,mutation_token,result_json,created_at) SELECT ?,?,?,?,?,?,? WHERE ${archiveClock}=? AND ${catalogueClock}=? AND EXISTS(SELECT 1 FROM history_salon_previews WHERE id=? AND owner_id=? AND expires_at>?)`,
      id,
      user.id,
      body.requestId,
      hash,
      mutation,
      JSON.stringify(result),
      now,
      r.archive_revision,
      r.catalogue_revision,
      r.id,
      user.id,
      Date.now(),
    ),
    stmt(
      db,
      `INSERT INTO therapists(id,name,active,weekly_json,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),0,?,?,? FROM json_each(?) WHERE json_extract(value,'$.kind')='therapist' AND ${guard}`,
      disabledWeek,
      now,
      now,
      packed,
      id,
      mutation,
    ),
    stmt(
      db,
      `INSERT INTO services(id,name,duration,price_cents,color,active,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.duration'),json_extract(value,'$.priceMinor'),json_extract(value,'$.color'),json_extract(value,'$.active'),?,? FROM json_each(?) WHERE json_extract(value,'$.kind')='service' AND ${guard}`,
      now,
      now,
      packed,
      id,
      mutation,
    ),
    stmt(
      db,
      `INSERT OR IGNORE INTO history_catalogue_links(kind,source,label_key,duration,entity_id,created_by,created_at) SELECT json_extract(value,'$.kind'),json_extract(value,'$.source'),json_extract(value,'$.labelKey'),json_extract(value,'$.duration'),json_extract(value,'$.entityId'),?,? FROM json_each(?) WHERE ${guard}`,
      user.id,
      now,
      packedLinks,
      id,
      mutation,
    ),
    stmt(
      db,
      `UPDATE history_salon_settings SET currency=?,minor_unit_digits=?,time_zone=?,version=version+1,updated_by=?,updated_at=? WHERE id=1 AND ${guard}`,
      settings.currency,
      settings.minorUnitDigits,
      settings.timeZone,
      user.id,
      now,
      id,
      mutation,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'history_salon_setup','history_salon',?,?,? WHERE ${guard}`,
      user.id,
      id,
      JSON.stringify(result),
      now,
      id,
      mutation,
    ),
  ]);
  const saved = await replay();
  if (!saved)
    fail(
      409,
      "Archived history or the current catalogue changed. Load and review setup again; nothing was changed.",
    );
  return json(
    { ...saved, repeated: saved.setupId !== id },
    saved.setupId === id ? 201 : 200,
  );
}
export async function historySalonRoutes(request, db, user) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/history/salon/")) return null;
  requireRole(user, "owner");
  await ensureClientContacts(db);
  await ensureClientTransferSchema(db);
  await ensureHistoryPreviewSchema(db);
  await ensureHistoryArchiveSchema(db);
  await ensureHistorySalonSchema(db);
  if (path === "/api/history/salon/preview" && request.method === "GET")
    return preview(db, user, new URL(request.url));
  if (path === "/api/history/salon/apply" && request.method === "POST")
    return apply(db, user, await readJSON(request, HISTORY_SALON_LIMITS.bytes));
  fail(404, "Historical salon setup action not found.");
}
