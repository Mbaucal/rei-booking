import { digest } from "./security.mjs";
import { email, phoneKey } from "./domain.mjs";
import { instagramHandle } from "./client-contacts.mjs";

const MODES = new Set(["unverified", "verified-appointment", "service-line"]);
const CONTACTS = ["phone", "email", "instagram"];
const DISPOSITIONS = [
  "ready",
  "unresolved",
  "conflict",
  "duplicate",
  "invalid",
];
const fold = (value) =>
  (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const pair = (...values) => JSON.stringify(values);
const text = (value) => typeof value === "string" && value.trim() !== "";
const unique = (values) => [...new Set(values)].sort();

// JSON snapshots only: reject lossy fingerprints rather than silently dropping data.
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  throw new TypeError("History snapshots must contain only JSON values.");
}

function addIssue(entry, code, field, severity, message) {
  if (
    !entry.issues.some((issue) => issue.code === code && issue.field === field)
  )
    entry.issues.push({ code, field, severity, message });
}

function normalizedContact(field, value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("Invalid contact.");
  if (field === "phone") {
    const clean = value.trim();
    const count = clean.replace(/\D/g, "").length;
    if (
      !/^[+\d\s().-]+$/.test(clean) ||
      count < 7 ||
      count > 15 ||
      clean.length > 30
    )
      throw new TypeError("Invalid phone.");
    return phoneKey(clean);
  }
  return (
    (field === "email" ? email(value.trim()) : instagramHandle(value)) || null
  );
}

function indexPush(index, key, value) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

function buildClients(clients) {
  const byId = new Map(),
    byName = new Map();
  const contacts = Object.fromEntries(
    CONTACTS.map((field) => [field, new Map()]),
  );
  for (const client of clients) {
    if (
      !text(client.id) ||
      byId.has(client.id) ||
      typeof client.name !== "string"
    )
      throw new TypeError(
        "Client snapshots require unique IDs and a name string.",
      );
    const keys = {};
    for (const field of CONTACTS) {
      keys[field] = normalizedContact(field, client[field]);
      if (keys[field]) indexPush(contacts[field], keys[field], client.id);
    }
    byId.set(client.id, { client, keys });
    if (fold(client.name)) indexPush(byName, fold(client.name), client.id);
  }
  return { byId, byName, contacts };
}

function sourceLinkIndex(links) {
  const index = new Map();
  for (const link of links) {
    const sourceKey = link.sourceKey ?? link.source_key;
    const clientId = link.clientId ?? link.client_id;
    if (!text(link.source) || !text(sourceKey) || !text(clientId))
      throw new TypeError(
        "Source links require source, source key and client ID.",
      );
    if (
      (link.sourceKey != null &&
        link.source_key != null &&
        link.sourceKey !== link.source_key) ||
      (link.clientId != null &&
        link.client_id != null &&
        link.clientId !== link.client_id)
    )
      throw new TypeError("Source link aliases disagree.");
    // Existing client importer row keys are retry protection, not person identity.
    if (/^id:[a-f0-9]{64}$/.test(sourceKey))
      indexPush(index, pair(link.source, sourceKey), clientId);
  }
  return index;
}

function resolveIdentity(entry, clients, links, consume) {
  const record = entry.record;
  const keys = {};
  for (const field of CONTACTS) {
    try {
      keys[field] = normalizedContact(field, record[field]);
    } catch {
      keys[field] = null;
      addIssue(
        entry,
        "invalid_contact",
        field,
        "error",
        "A supplied contact cannot be interpreted safely.",
      );
    }
  }
  const sets = CONTACTS.filter((field) => keys[field]).map((field) => ({
    field,
    ids: clients.contacts[field].get(keys[field]) ?? [],
  }));
  const nameIds = clients.byName.get(fold(record.sourceClientLabel)) ?? [];
  consume(
    sets.reduce((count, { ids }) => count + ids.length, 0) + nameIds.length,
  );
  const matches = unique(sets.flatMap(({ ids }) => ids));
  const names = unique(nameIds);
  const sourceId =
    typeof record.sourceClientId === "string"
      ? record.sourceClientId.trim()
      : "";
  const sourceIds = sourceId
    ? (links.get(pair(record.source, `id:${digest(sourceId)}`)) ?? [])
    : [];
  consume(sourceIds.length);
  const linkedIds = unique(sourceIds);
  const identity = {
    state: "unresolved",
    clientId: null,
    candidates: matches.length ? matches : names,
    method: null,
  };
  const conflict = (code, message) => {
    identity.state = "conflict";
    addIssue(entry, code, "clientId", "conflict", message);
  };
  if (linkedIds.length > 1) {
    identity.candidates = unique([...linkedIds, ...matches]);
    conflict(
      "source_identity_conflict",
      "This source identity links to more than one client.",
    );
    return identity;
  }
  if (linkedIds.length === 1) {
    const target = clients.byId.get(linkedIds[0]);
    identity.candidates = unique([...linkedIds, ...matches]);
    if (!target)
      conflict(
        "missing_linked_client",
        "The linked client is absent from the supplied snapshot.",
      );
    else if (
      CONTACTS.some(
        (field) =>
          keys[field] &&
          target.keys[field] &&
          keys[field] !== target.keys[field],
      ) ||
      matches.some((id) => id !== linkedIds[0])
    )
      conflict(
        "source_contact_conflict",
        "Supplied contacts contradict the source identity link.",
      );
    else {
      identity.state = "linked";
      identity.clientId = linkedIds[0];
      identity.method = "source-id";
      identity.snapshotVersion = target.client.version ?? null;
      if (
        fold(record.sourceClientLabel) &&
        fold(record.sourceClientLabel) !== fold(target.client.name)
      )
        addIssue(
          entry,
          "linked_name_changed",
          "sourceClientLabel",
          "review",
          "The source name differs from the linked profile; review the label.",
        );
    }
    return identity;
  }
  const nonemptySets = sets.filter(({ ids }) => ids.length);
  if (
    nonemptySets.length > 1 &&
    !matches.some((id) => nonemptySets.every(({ ids }) => ids.includes(id)))
  )
    conflict(
      "contact_identity_conflict",
      "Supplied contacts identify different client profiles.",
    );
  else if (sets.some(({ ids }) => ids.length > 1) || matches.length > 1)
    addIssue(
      entry,
      "shared_contact",
      "clientId",
      "review",
      "A contact is shared by multiple profiles; select the client explicitly.",
    );
  else if (matches.length === 1) {
    const target = clients.byId.get(matches[0]);
    if (
      CONTACTS.some(
        (field) =>
          keys[field] &&
          target.keys[field] &&
          keys[field] !== target.keys[field],
      )
    )
      conflict(
        "contact_details_conflict",
        "The candidate has conflicting nonempty contact details.",
      );
    else {
      identity.state = "proposed";
      identity.method = "contact";
      identity.snapshotVersion = target.client.version ?? null;
      addIssue(
        entry,
        "contact_link_review",
        "clientId",
        "review",
        "Review and approve this contact-based candidate before linking history.",
      );
      if (
        fold(record.sourceClientLabel) &&
        fold(record.sourceClientLabel) !== fold(target.client.name)
      )
        addIssue(
          entry,
          "candidate_name_changed",
          "sourceClientLabel",
          "review",
          "The source name differs from the proposed profile.",
        );
    }
  } else {
    identity.method = names.length ? "name" : null;
    addIssue(
      entry,
      names.length ? "name_only_review" : "client_unresolved",
      "clientId",
      "review",
      names.length
        ? "A name is only a suggestion; select the client explicitly."
        : "No verified client identity is available.",
    );
  }
  return identity;
}

function keyFor(record, mode, entry) {
  const appointment = text(record.sourceAppointmentRef)
    ? record.sourceAppointmentRef.trim()
    : null;
  const line = text(record.sourceServiceLineRef)
    ? record.sourceServiceLineRef.trim()
    : null;
  if (mode === "verified-appointment" && appointment)
    return {
      sourceKey: `appointment:${digest(pair(appointment))}`,
      keyScope: "appointment",
    };
  if (mode === "service-line" && appointment && line)
    return {
      sourceKey: `service-line:${digest(pair(appointment, line))}`,
      keyScope: "service-line",
    };
  addIssue(
    entry,
    "unverified_reference",
    "sourceAppointmentRef",
    "review",
    "A stable service-level source key is unverified; file position protects only exact-file retries.",
  );
  return {
    sourceKey: `row:${record.fileDigest}:${record.row}`,
    keyScope: "file-row",
  };
}

function checkRecord(entry) {
  const r = entry.record;
  if (
    !text(r.source) ||
    !/^[a-f0-9]{64}$/.test(r.fileDigest) ||
    !Number.isSafeInteger(r.row) ||
    r.row < 1
  )
    addIssue(
      entry,
      "invalid_provenance",
      "row",
      "error",
      "A source namespace, file digest and positive row number are required.",
    );
  for (const field of [
    "sourceAppointmentRef",
    "sourceServiceLineRef",
    "sourceClientId",
    "sourceClientLabel",
  ])
    if (r[field] != null && typeof r[field] !== "string")
      addIssue(
        entry,
        "invalid_text_identity",
        field,
        "error",
        "Source identities and labels must remain text.",
      );
  const day =
    typeof r.scheduledLocalDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.scheduledLocalDate)
      ? new Date(`${r.scheduledLocalDate}T00:00:00.000Z`)
      : null;
  if (
    !day ||
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== r.scheduledLocalDate ||
    !Number.isInteger(r.startMinute) ||
    r.startMinute < 0 ||
    r.startMinute >= 1440 ||
    !Number.isInteger(r.durationMinutes) ||
    r.durationMinutes <= 0 ||
    r.startMinute + r.durationMinutes > 1440
  )
    addIssue(
      entry,
      "invalid_schedule",
      "scheduledLocalDate",
      "error",
      "The historical local date, start and duration must be valid.",
    );
  if (!r.sourceTimeZone || !r.scheduledAt)
    addIssue(
      entry,
      "unresolved_timezone",
      "sourceTimeZone",
      "review",
      "Confirm the source timezone and unambiguous appointment instant.",
    );
  for (const [field, allowed] of [
    ["completionState", ["completed", "not_completed", "unknown"]],
    ["requestState", ["yes", "no", "unknown"]],
  ])
    if (!allowed.includes(r[field]))
      addIssue(
        entry,
        "invalid_state",
        field,
        "error",
        "An explicit known or unknown state is required.",
      );
  for (const field of [
    "sourceNetSalesMinor",
    "fullPriceMinor",
    "paidAmountMinor",
    "bonusAmountMinor",
  ])
    if (r[field] != null && !Number.isSafeInteger(r[field]))
      addIssue(
        entry,
        "invalid_amount",
        field,
        "error",
        "Known historical amounts must be safe integer minor units.",
      );
}

function nativeIndex(appointments) {
  const index = new Map(),
    ids = new Set();
  for (const item of appointments) {
    if (
      !text(item.id) ||
      ids.has(item.id) ||
      !text(item.date) ||
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.duration) ||
      item.duration <= 0
    )
      throw new TypeError(
        "Native appointment snapshots require ID, date, start and duration.",
      );
    ids.add(item.id);
    if (item.clientId)
      indexPush(index, pair(item.date, "id", item.clientId), item);
    if (item.clientName)
      indexPush(index, pair(item.date, "name", fold(item.clientName)), item);
  }
  return index;
}

/**
 * Read-only, synchronous preview. Snapshots are JSON; no persistence or approvals.
 * clients: {id,name,phone?,email?,instagram?,version?}; sourceLinks accepts the
 * existing DB {source,source_key,client_id} or camel-case equivalent.
 * existingHistory: {id,source,sourceKey,payloadDigest}; only previously accepted
 * archive rows belong here. nativeAppointments: {id,clientId?,clientName?,date,
 * start,duration}. Modes are an explicit caller assertion about reference scope.
 * Reuse an output row's source/sourceKey/payloadDigest for future repeat checks.
 * Caller must enforce owner-only access before ever exposing this private plan.
 * Limits: 50,000 normalized rows; 100,000 entries per reference snapshot;
 * 1,000,000 combined identity/native candidate visits. Oversize ambiguity fails
 * explicitly instead of truncating candidates or silently guessing a match.
 */
export function planHistoryImport({
  rows,
  clients = [],
  sourceLinks = [],
  existingHistory = [],
  nativeAppointments = [],
  referenceMode = "unverified",
}) {
  if (
    ![rows, clients, sourceLinks, existingHistory, nativeAppointments].every(
      Array.isArray,
    )
  )
    throw new TypeError("History planner inputs must be arrays.");
  if (!MODES.has(referenceMode))
    throw new TypeError("Unknown source reference mode.");
  if (rows.length > 50000)
    throw new RangeError("History previews support at most 50000 rows.");
  if (
    [clients, sourceLinks, existingHistory, nativeAppointments].some(
      (items) => items.length > 100000,
    )
  )
    throw new RangeError(
      "Each history reference snapshot supports at most 100000 entries.",
    );
  let remainingCandidates = 1000000;
  const consume = (count) => {
    remainingCandidates -= count;
    if (remainingCandidates < 0)
      throw new RangeError(
        "History preview candidate limit exceeded; use a narrower reference snapshot.",
      );
  };
  const clientIndex = buildClients(clients),
    links = sourceLinkIndex(sourceLinks),
    natives = nativeIndex(nativeAppointments);
  const existing = new Map(),
    existingIds = new Set(),
    incoming = new Map(),
    positions = new Map();
  for (const item of existingHistory) {
    if (
      !text(item.id) ||
      existingIds.has(item.id) ||
      !text(item.source) ||
      !text(item.sourceKey) ||
      !/^[a-f0-9]{64}$/.test(item.payloadDigest)
    )
      throw new TypeError(
        "Existing history snapshots require ID, namespace, key and payload digest.",
      );
    existingIds.add(item.id);
    indexPush(existing, pair(item.source, item.sourceKey), item);
  }
  const planned = rows.map((input) => {
    if (!input || Array.isArray(input) || typeof input !== "object")
      throw new TypeError("Normalized history rows must be objects.");
    const record = JSON.parse(canonical(input));
    const payload = Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => !["row", "fileDigest", "issues"].includes(key),
      ),
    );
    const entry = {
      rowId: `history-row:${digest(pair(record.source, record.fileDigest, record.row))}`,
      record,
      payloadDigest: digest(canonical(payload)),
      selected: false,
      issues: (record.issues ?? []).map((issue) => ({ ...issue })),
      nativeOverlapIds: [],
      duplicateOf: null,
    };
    checkRecord(entry);
    Object.assign(entry, keyFor(record, referenceMode, entry));
    // Identity validation reports malformed labels; do not pass them to string normalizers.
    entry.identity =
      typeof record.sourceClientLabel === "string" ||
      record.sourceClientLabel == null
        ? resolveIdentity(entry, clientIndex, links, consume)
        : { state: "unresolved", clientId: null, candidates: [], method: null };
    const nativeGroups = entry.identity.candidates.map(
      (id) => natives.get(pair(record.scheduledLocalDate, "id", id)) ?? [],
    );
    if (typeof record.sourceClientLabel === "string")
      nativeGroups.push(
        natives.get(
          pair(
            record.scheduledLocalDate,
            "name",
            fold(record.sourceClientLabel),
          ),
        ) ?? [],
      );
    consume(nativeGroups.reduce((count, items) => count + items.length, 0));
    const possible = nativeGroups.flat();
    entry.nativeOverlapIds = unique(
      possible
        .filter(
          (item) =>
            item.start < record.startMinute + record.durationMinutes &&
            record.startMinute < item.start + item.duration,
        )
        .map((item) => item.id),
    );
    if (entry.nativeOverlapIds.length)
      addIssue(
        entry,
        "native_overlap_review",
        "nativeAppointmentId",
        "review",
        "A native appointment may represent this visit; review an explicit link before combining history.",
      );
    indexPush(incoming, pair(record.source, entry.sourceKey), entry);
    indexPush(positions, entry.rowId, entry);
    return entry;
  });
  for (const group of positions.values())
    if (group.length > 1) {
      group.forEach((entry, index) => {
        entry.rowId += `:${index + 1}`;
      });
    }
  for (const [key, group] of incoming) {
    const stored = existing.get(key) ?? [];
    if (
      unique([
        ...group.map((entry) => entry.payloadDigest),
        ...stored.map((item) => item.payloadDigest),
      ]).length > 1
    ) {
      for (const entry of group)
        addIssue(
          entry,
          "source_payload_conflict",
          "sourceKey",
          "conflict",
          "The same source key represents different content; review the correction or service-line identity.",
        );
    } else {
      const prior = stored.length
        ? {
            kind: "existing-history",
            id: stored.map((item) => item.id).sort()[0],
          }
        : null;
      group.forEach((entry, index) => {
        entry.duplicateOf =
          prior ?? (index ? { kind: "preview-row", id: group[0].rowId } : null);
      });
    }
  }
  const summary = {
    total: planned.length,
    ...Object.fromEntries(DISPOSITIONS.map((state) => [state, 0])),
    linked: 0,
    proposed: 0,
    selectedReady: 0,
    eligibleVisits: 0,
    eligibleSourceNetSales: 0,
    eligibleBonuses: 0,
    unknown: {
      completion: 0,
      request: 0,
      sourceTimeZone: 0,
      sourceNetSales: 0,
      currency: 0,
      fullPrice: 0,
      paidAmount: 0,
      bonusRule: 0,
      bonusAmount: 0,
    },
  };
  for (const entry of planned) {
    entry.issues.sort((a, b) =>
      pair(a.field, a.code, a.severity, a.message).localeCompare(
        pair(b.field, b.code, b.severity, b.message),
        "en",
      ),
    );
    entry.disposition = entry.issues.some((i) => i.severity === "error")
      ? "invalid"
      : entry.issues.some((i) => i.severity === "conflict")
        ? "conflict"
        : entry.duplicateOf
          ? "duplicate"
          : entry.issues.some((i) => i.severity === "review") ||
              entry.identity.state !== "linked"
            ? "unresolved"
            : "ready";
    const ready = entry.disposition === "ready";
    entry.eligibility = {
      visits: ready && entry.record.completionState === "completed",
      sourceNetSales:
        ready &&
        Number.isSafeInteger(entry.record.sourceNetSalesMinor) &&
        text(entry.record.currency),
      bonuses: false,
    };
    summary[entry.disposition]++;
    if (entry.identity.state === "linked") summary.linked++;
    if (entry.identity.state === "proposed") summary.proposed++;
    if (entry.eligibility.visits) summary.eligibleVisits++;
    if (entry.eligibility.sourceNetSales) summary.eligibleSourceNetSales++;
    for (const [key, missing] of Object.entries({
      completion: entry.record.completionState === "unknown",
      request: entry.record.requestState === "unknown",
      sourceTimeZone: !entry.record.sourceTimeZone,
      sourceNetSales: entry.record.sourceNetSalesMinor == null,
      currency: !entry.record.currency,
      fullPrice: entry.record.fullPriceMinor == null,
      paidAmount: entry.record.paidAmountMinor == null,
      bonusRule: entry.record.bonusRule == null,
      bonusAmount: entry.record.bonusAmountMinor == null,
    }))
      if (missing) summary.unknown[key]++;
  }
  return { rows: planned, summary };
}
