import test from "node:test";
import assert from "node:assert/strict";
import { planHistoryImport } from "../src/history-import-plan.mjs";
import { digest } from "../src/security.mjs";

const file = digest("fictional history export A");
const client = {
  id: "client-a",
  name: "Sample Guest",
  phone: "+381 60 111 2222",
  email: "guest@example.test",
  instagram: "sample.guest",
  version: 3,
};
const row = (changes = {}) => ({
  row: 2,
  source: "salon-a:fresha",
  fileDigest: file,
  raw: {
    client: "Sample Guest",
    appointment: "000012",
    service: "Former treatment",
    status: "Completed",
  },
  sourceAppointmentRef: "000012",
  sourceServiceLineRef: null,
  sourceClientId: "0007",
  sourceClientLabel: "Sample Guest",
  phone: null,
  email: null,
  instagram: null,
  sourceTherapistLabel: "Former Therapist",
  sourceServiceLabel: "Former treatment",
  sourceRoomLabel: null,
  scheduledLocalDate: "2026-01-12",
  startMinute: 600,
  durationMinutes: 60,
  scheduledAt: "2026-01-12T09:00:00.000Z",
  sourceTimeZone: "Europe/Belgrade",
  sourceCreatedAt: null,
  sourceCancelledAt: null,
  sourceStatus: "Completed",
  completionState: "completed",
  requestState: "unknown",
  sourceNetSalesMinor: 390000,
  currency: "RSD",
  fullPriceMinor: null,
  paidAmountMinor: null,
  bonusRule: null,
  bonusAmountMinor: null,
  issues: [],
  ...changes,
});
const link = (changes = {}) => ({
  source: "salon-a:fresha",
  source_key: `id:${digest("0007")}`,
  client_id: "client-a",
  ...changes,
});
function plan(rows, options = {}) {
  return planHistoryImport({
    rows,
    clients: [client],
    sourceLinks: [link()],
    referenceMode: "verified-appointment",
    ...options,
  });
}
function codes(entry) {
  return entry.issues.map((issue) => issue.code);
}
function archive(entry, id = "archive-a") {
  return {
    id,
    source: entry.record.source,
    sourceKey: entry.sourceKey,
    payloadDigest: entry.payloadDigest,
  };
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("source namespace and textual ID preserve leading zeros and legacy digest format", () => {
  const result = plan([
    row(),
    row({ row: 3, sourceAppointmentRef: "000013", sourceClientId: "7" }),
    row({ row: 4, source: "salon-b:fresha" }),
  ]);
  assert.equal(result.rows[0].disposition, "ready");
  assert.equal(result.rows[0].identity.clientId, client.id);
  assert.equal(result.rows[0].selected, false);
  assert.deepEqual(
    result.rows.slice(1).map((item) => item.identity.clientId),
    [null, null],
  );
  assert.deepEqual(
    result.rows.slice(1).map((item) => item.disposition),
    ["unresolved", "unresolved"],
  );
  const camel = plan([row({ sourceClientId: " 0007 " })], {
    sourceLinks: [
      {
        source: link().source,
        sourceKey: link().source_key,
        clientId: client.id,
      },
    ],
  });
  assert.equal(camel.rows[0].identity.clientId, client.id);
  assert.equal(
    plan([row({ sourceClientId: 7 })]).rows[0].disposition,
    "invalid",
  );
});

test("trusted source links reject contradictions, shared contacts and dangling or reassigned identities", () => {
  const other = {
    id: "client-b",
    name: "Other Guest",
    phone: "+381601112222",
    email: "other@example.test",
  };
  const contradictory = plan([row({ email: "other@example.test" })], {
    clients: [client, other],
  });
  assert.equal(contradictory.rows[0].disposition, "conflict");
  assert.equal(contradictory.rows[0].identity.clientId, null);
  assert.equal(
    plan([row({ phone: "+381601112222" })], { clients: [client, other] })
      .rows[0].disposition,
    "conflict",
  );
  const reassigned = plan([row()], {
    clients: [client, other],
    sourceLinks: [link(), link({ client_id: other.id })],
  });
  assert.ok(codes(reassigned.rows[0]).includes("source_identity_conflict"));
  const missing = plan([row()], { clients: [] });
  assert.ok(codes(missing.rows[0]).includes("missing_linked_client"));
  const renamed = plan([row({ sourceClientLabel: "Previous Display Name" })]);
  assert.equal(renamed.rows[0].identity.state, "linked");
  assert.equal(renamed.rows[0].disposition, "unresolved");
});

test("compatible normalized contacts propose a profile but never create an identity link", () => {
  const result = plan(
    [
      row({
        phone: "060 111 2222",
        email: " GUEST@EXAMPLE.TEST ",
        instagram: "https://www.instagram.com/Sample.Guest/",
      }),
    ],
    { sourceLinks: [] },
  );
  assert.equal(result.rows[0].identity.state, "proposed");
  assert.equal(result.rows[0].identity.clientId, null);
  assert.deepEqual(result.rows[0].identity.candidates, [client.id]);
  assert.equal(result.rows[0].disposition, "unresolved");
  assert.equal(result.summary.proposed, 1);
  assert.equal(result.summary.linked, 0);
  assert.equal(result.summary.eligibleVisits, 0);
  const rowKey = link({ source_key: `row:${file}:0` });
  assert.equal(
    plan([row()], { sourceLinks: [rowKey] }).rows[0].identity.clientId,
    null,
  );
});

test("name-only suggestions, name twins, shared phone and contradictory contacts require review", () => {
  const twin = {
    ...client,
    id: "client-b",
    phone: "+381603334444",
    email: "twin@example.test",
    instagram: "twin.guest",
  };
  const named = plan([row({ sourceClientId: null })], {
    clients: [client, twin],
    sourceLinks: [],
  }).rows[0];
  assert.deepEqual(named.identity.candidates, [client.id, twin.id]);
  assert.equal(named.identity.method, "name");
  assert.equal(named.disposition, "unresolved");
  assert.equal(
    plan([row()], { sourceLinks: [] }).rows[0].disposition,
    "unresolved",
  );
  const shared = plan([row({ phone: client.phone })], {
    clients: [client, { ...twin, phone: client.phone }],
    sourceLinks: [],
  }).rows[0];
  assert.ok(codes(shared).includes("shared_contact"));
  assert.equal(shared.identity.clientId, null);
  const crossed = plan([row({ phone: client.phone, email: twin.email })], {
    clients: [client, twin],
    sourceLinks: [],
  }).rows[0];
  assert.equal(crossed.disposition, "conflict");
  const newMail = plan(
    [row({ phone: client.phone, email: "different@example.test" })],
    { sourceLinks: [] },
  ).rows[0];
  assert.ok(codes(newMail).includes("contact_details_conflict"));
});

test("same verified payload is repeat-safe across file order; changed content conflicts with archive", () => {
  const original = plan([row()]).rows[0];
  const changedPosition = row({
    row: 30,
    fileDigest: digest("reordered synthetic export"),
  });
  const retry = plan([changedPosition], {
    existingHistory: [archive(original)],
  }).rows[0];
  assert.equal(retry.payloadDigest, original.payloadDigest);
  assert.equal(retry.sourceKey, original.sourceKey);
  assert.equal(retry.disposition, "duplicate");
  assert.deepEqual(retry.duplicateOf, {
    kind: "existing-history",
    id: "archive-a",
  });
  const changed = plan([row({ durationMinutes: 90 })], {
    existingHistory: [archive(original)],
  }).rows[0];
  assert.equal(changed.disposition, "conflict");
  assert.equal(changed.duplicateOf, null);
  const rawChanged = plan([row({ raw: { ...row().raw, status: "Started" } })], {
    existingHistory: [archive(original)],
  }).rows[0];
  assert.equal(rawChanged.disposition, "conflict");
});

test("incoming repeated references partition duplicates, and changed repeated references block every row", () => {
  const duplicate = plan([row(), row({ row: 3 })]);
  assert.deepEqual(
    duplicate.rows.map((item) => item.disposition),
    ["ready", "duplicate"],
  );
  assert.deepEqual(duplicate.rows[1].duplicateOf, {
    kind: "preview-row",
    id: duplicate.rows[0].rowId,
  });
  const collision = plan([
    row(),
    row({ row: 3, sourceServiceLabel: "Another treatment" }),
    row({ row: 4 }),
  ]);
  assert.deepEqual(
    collision.rows.map((item) => item.disposition),
    ["conflict", "conflict", "conflict"],
  );
  assert.equal(collision.summary.ready, 0);
});

test("service-line verification requires both textual IDs and collision-safe tuple encoding", () => {
  const records = [
    row({ sourceAppointmentRef: "a:b", sourceServiceLineRef: "c" }),
    row({ row: 3, sourceAppointmentRef: "a", sourceServiceLineRef: "b:c" }),
    row({ row: 4, sourceAppointmentRef: "a:b", sourceServiceLineRef: "d" }),
  ];
  const result = plan(records, { referenceMode: "service-line" });
  assert.equal(new Set(result.rows.map((item) => item.sourceKey)).size, 3);
  assert.equal(result.summary.ready, 3);
  const replay = plan(
    records.toReversed().map((item, index) => ({
      ...item,
      row: index + 2,
      fileDigest: digest("reordered lines"),
    })),
    {
      referenceMode: "service-line",
      existingHistory: result.rows.map((entry, index) =>
        archive(entry, `history-${index}`),
      ),
    },
  );
  assert.equal(replay.summary.duplicate, 3);
  assert.equal(
    plan([row()], { referenceMode: "service-line" }).rows[0].keyScope,
    "file-row",
  );
  const unverifiedLines = plan(records, {
    referenceMode: "verified-appointment",
  });
  assert.equal(unverifiedLines.rows[0].disposition, "conflict");
  assert.equal(unverifiedLines.rows[2].disposition, "conflict");
});

test("default unverified keys protect only exact-file retries and never infer reference uniqueness", () => {
  const options = { referenceMode: "unverified" };
  const initial = plan([row()], options).rows[0];
  assert.equal(initial.disposition, "unresolved");
  assert.equal(initial.keyScope, "file-row");
  const exact = plan([row()], {
    ...options,
    existingHistory: [archive(initial)],
  }).rows[0];
  assert.equal(exact.disposition, "duplicate");
  const another = plan(
    [row({ fileDigest: digest("overlapping different export") })],
    { ...options, existingHistory: [archive(initial)] },
  ).rows[0];
  assert.equal(another.disposition, "unresolved");
  assert.equal(another.duplicateOf, null);
  assert.notEqual(another.sourceKey, initial.sourceKey);
  assert.equal(
    planHistoryImport({ rows: [row()] }).rows[0].keyScope,
    "file-row",
  );
});

test("native overlaps remain explicit review and do not borrow current services, prices or request rules", () => {
  const nativeAppointments = [
    {
      id: "native-a",
      clientId: client.id,
      date: "2026-01-12",
      start: 630,
      duration: 30,
      serviceName: "Current menu label",
      price: 999999,
    },
    {
      id: "native-b",
      clientId: client.id,
      date: "2026-01-12",
      start: 660,
      duration: 60,
    },
    {
      id: "native-other",
      clientId: "unrelated",
      date: "2026-01-12",
      start: 600,
      duration: 60,
    },
  ];
  const result = plan([row()], { nativeAppointments }).rows[0];
  assert.deepEqual(result.nativeOverlapIds, ["native-a"]);
  assert.equal(result.disposition, "unresolved");
  assert.equal(result.record.sourceServiceLabel, "Former treatment");
  assert.equal(result.record.fullPriceMinor, null);
  assert.equal(result.record.bonusAmountMinor, null);
  assert.equal(result.eligibility.bonuses, false);
  const nameOnly = plan([row({ sourceClientId: null })], {
    clients: [],
    sourceLinks: [],
    nativeAppointments: [
      { ...nativeAppointments[0], clientName: "Sample Guest" },
    ],
  }).rows[0];
  assert.deepEqual(nameOnly.nativeOverlapIds, ["native-a"]);
  assert.equal(nameOnly.identity.clientId, null);
});

test("summary partitions all dispositions and preserves unknown, zero and non-completion separately", () => {
  const ready = row({
    sourceAppointmentRef: "known",
    completionState: "not_completed",
    sourceNetSalesMinor: 0,
  });
  const invalid = row({
    row: 3,
    sourceAppointmentRef: "invalid",
    issues: [
      {
        code: "bad_time",
        field: "startMinute",
        severity: "error",
        message: "Invalid time.",
      },
    ],
  });
  const unknown = row({
    row: 4,
    sourceAppointmentRef: "unknown",
    completionState: "unknown",
    requestState: "unknown",
    sourceNetSalesMinor: null,
    currency: null,
    scheduledAt: null,
    sourceTimeZone: null,
  });
  const conflict = row({
    row: 5,
    sourceAppointmentRef: "conflict",
    email: "different@example.test",
  });
  const result = plan([
    ready,
    invalid,
    unknown,
    conflict,
    { ...ready, row: 6 },
  ]);
  assert.deepEqual(
    result.rows.map((item) => item.disposition),
    ["ready", "invalid", "unresolved", "conflict", "duplicate"],
  );
  assert.equal(
    ["ready", "invalid", "unresolved", "conflict", "duplicate"].reduce(
      (n, key) => n + result.summary[key],
      0,
    ),
    result.summary.total,
  );
  assert.equal(result.summary.eligibleVisits, 0);
  assert.equal(result.summary.eligibleSourceNetSales, 1);
  assert.equal(result.summary.eligibleBonuses, 0);
  assert.equal(result.summary.selectedReady, 0);
  assert.equal(result.summary.unknown.sourceNetSales, 1);
  assert.equal(result.summary.unknown.completion, 1);
  assert.equal(result.summary.unknown.paidAmount, 5);
  assert.ok(result.rows.every((entry) => entry.selected === false));
  assert.equal(
    plan([row({ phone: "not a phone" })]).rows[0].disposition,
    "invalid",
  );
});

test("pure plans are deterministic with deeply frozen snapshots and return detached record copies", () => {
  const input = deepFreeze({
    rows: [row()],
    clients: [client],
    sourceLinks: [link()],
    existingHistory: [],
    nativeAppointments: [],
    referenceMode: "verified-appointment",
  });
  const before = JSON.stringify(input);
  const a = planHistoryImport(input),
    b = planHistoryImport(input);
  assert.deepEqual(a, b);
  a.rows[0].record.raw.client = "Changed only in output";
  a.rows[0].issues.push({ code: "output-only" });
  assert.equal(JSON.stringify(input), before);
  assert.equal(b.rows[0].record.raw.client, "Sample Guest");
  assert.throws(
    () => planHistoryImport({ ...input, referenceMode: "guess" }),
    /reference mode/,
  );
  assert.throws(
    () => planHistoryImport({ ...input, clients: [client, client] }),
    /unique IDs/,
  );
  assert.throws(
    () =>
      planHistoryImport({
        ...input,
        sourceLinks: [{ ...link(), clientId: "different" }],
      }),
    /aliases disagree/,
  );
  assert.throws(
    () =>
      planHistoryImport({
        ...input,
        rows: [row({ durationMinutes: Infinity })],
      }),
    /JSON values/,
  );
});

test("invalid dates and duplicate snapshot identities cannot appear validation-ready", () => {
  assert.equal(
    plan([row({ scheduledLocalDate: "2026-02-30" })]).rows[0].disposition,
    "invalid",
  );
  assert.equal(
    plan([
      row({
        scheduledLocalDate: "2024-02-29",
        scheduledAt: "2024-02-29T09:00:00.000Z",
      }),
    ]).rows[0].disposition,
    "ready",
  );
  const represented = archive(plan([row()]).rows[0]);
  assert.throws(
    () => plan([row()], { existingHistory: [represented, represented] }),
    /Existing history snapshots/,
  );
  const native = {
    id: "same-native-id",
    date: "2026-01-12",
    start: 600,
    duration: 60,
    clientId: client.id,
  };
  assert.throws(
    () => plan([row()], { nativeAppointments: [native, native] }),
    /Native appointment snapshots/,
  );
  const changedArchive = {
    ...represented,
    id: "second-archive",
    payloadDigest: digest("different source content"),
  };
  assert.equal(
    plan([row()], { existingHistory: [represented, changedArchive] }).rows[0]
      .disposition,
    "conflict",
  );
  assert.equal(plan([row()]).rows[0].identity.snapshotVersion, 3);
});

test("large snapshots use indexed identity lookup and explicit limits instead of truncated guesses", () => {
  const clients = Array.from({ length: 5000 }, (_, i) => ({
    id: `synthetic-${i}`,
    name: `Fictional Guest ${i}`,
  }));
  const rows = clients.map((item, i) =>
    row({
      row: i + 2,
      sourceClientLabel: item.name,
      sourceClientId: String(i).padStart(6, "0"),
      sourceAppointmentRef: `appointment-${i}`,
    }),
  );
  const sourceLinks = clients.map((item, i) =>
    link({
      client_id: item.id,
      source_key: `id:${digest(String(i).padStart(6, "0"))}`,
    }),
  );
  const result = plan(rows, { clients, sourceLinks });
  assert.equal(result.summary.ready, 5000);
  assert.equal(result.summary.linked, 5000);
  assert.equal(result.rows[4999].identity.clientId, "synthetic-4999");
  assert.throws(() => plan(new Array(50001)), /50000 rows/);
  assert.throws(
    () => plan([], { clients: new Array(100001) }),
    /100000 entries/,
  );
  const sharedNames = Array.from({ length: 1001 }, (_, i) => ({
    id: `twin-${i}`,
    name: "Sample Guest",
  }));
  assert.throws(
    () =>
      plan(
        Array.from({ length: 1000 }, (_, i) =>
          row({ row: i + 2, sourceAppointmentRef: `ambiguous-${i}` }),
        ),
        { clients: sharedNames, sourceLinks: [] },
      ),
    /candidate limit exceeded/,
  );
});
