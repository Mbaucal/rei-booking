import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizeHistoryRows } from "../src/history-normalize.mjs";
import { planHistoryImport } from "../src/history-import-plan.mjs";

// Fictional data only. These cases exercise the two public APIs together.
const fields = [
  "appointmentRef",
  "serviceLineRef",
  "clientSourceId",
  "clientName",
  "phone",
  "email",
  "instagram",
  "therapistName",
  "serviceName",
  "scheduledDate",
  "slot",
  "duration",
  "createdAt",
  "cancelledAt",
  "status",
  "netSales",
  "requested",
  "roomName",
];
const mapping = Object.fromEntries(
  fields.map((field, index) => [field, index]),
);
const source = "synthetic-salon:fresha";
const fileDigest = "a".repeat(64);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const client = {
  id: "client-qa-1",
  name: "Nora Example",
  phone: "+381 60 1234567",
  email: "nora@example.test",
  instagram: "nora_example",
  version: 4,
};
const sourceLinks = [
  { source, source_key: `id:${hash("0007")}`, client_id: client.id },
];
const base = {
  appointmentRef: "00042",
  serviceLineRef: "01",
  clientSourceId: "0007",
  clientName: client.name,
  therapistName: "Former Therapist Example",
  serviceName: "Historical treatment label",
  scheduledDate: "15 Jan 2026, 10:00am",
  slot: "10:00:00-11:00:00",
  duration: "1h 0min",
  createdAt: "04 Jan 2026, 5:43pm",
  status: "Completed",
  netSales: "5900",
  requested: "No",
};
const confirmedFormat = {
  dateTimeFormat: "fresha-en",
  slotFormat: "HH:mm:ss-HH:mm:ss",
  durationFormat: "hours-minutes",
  sourceTimeZone: "Europe/Belgrade",
  money: {
    currency: "RSD",
    minorUnitDigits: 2,
    decimalSeparator: ".",
    groupSeparator: null,
  },
  completionMap: { Completed: "completed" },
  requestMap: { No: "no" },
};
function input(overrides = [{}], options = {}) {
  return {
    headers: [...fields],
    mapping: { ...mapping },
    source,
    fileDigest,
    rows: overrides.map((overrides) => {
      const values = { ...base, ...overrides };
      return fields.map((field) => values[field] ?? "");
    }),
    format: structuredClone(confirmedFormat),
    ...options,
  };
}
function normalized(overrides, options) {
  return normalizeHistoryRows(input(overrides, options)).rows;
}
function planned(rows, options = {}) {
  return planHistoryImport({
    rows,
    clients: [client],
    sourceLinks,
    referenceMode: "verified-appointment",
    ...options,
  });
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function assertAccounting(plan) {
  assert.equal(
    ["ready", "unresolved", "conflict", "duplicate", "invalid"].reduce(
      (sum, key) => sum + plan.summary[key],
      0,
    ),
    plan.rows.length,
  );
  assert.equal(plan.summary.selectedReady, 0);
  assert.ok(plan.rows.every((row) => row.selected === false));
  assert.equal(plan.summary.eligibleBonuses, 0);
}

test("history acceptance: source-shaped name-only data preserves unknowns instead of inventing visits or money", () => {
  const rows = normalized(
    [
      {
        clientSourceId: "",
        serviceLineRef: "",
        status: "Started",
        requested: "",
        serviceName: '<script>alert("fictional")</script>',
      },
    ],
    {
      format: {
        dateTimeFormat: "fresha-en",
        slotFormat: "HH:mm:ss-HH:mm:ss",
        durationFormat: "hours-minutes",
        sourceTimeZone: null,
      },
    },
  );
  const record = rows[0];
  assert.equal(record.sourceAppointmentRef, "00042");
  assert.equal(record.raw.serviceName, '<script>alert("fictional")</script>');
  assert.equal(record.sourceServiceLabel, record.raw.serviceName);
  assert.equal(record.scheduledLocalDate, "2026-01-15");
  assert.equal(record.startMinute, 600);
  assert.equal(record.durationMinutes, 60);
  assert.equal(record.scheduledAt, null);
  assert.equal(record.sourceTimeZone, null);
  assert.equal(record.completionState, "unknown");
  assert.equal(record.requestState, "unknown");
  assert.deepEqual(record.completionBasis, {
    method: "unresolved",
    sourceValue: "Started",
    mappedValue: "unknown",
  });
  for (const field of [
    "sourceNetSalesMinor",
    "currency",
    "fullPriceMinor",
    "paidAmountMinor",
    "bonusRule",
    "bonusAmountMinor",
  ])
    assert.equal(record[field], null, field);
  const plan = planned(rows, { referenceMode: "unverified" });
  assert.equal(plan.rows[0].disposition, "unresolved");
  assert.equal(plan.rows[0].identity.clientId, null);
  assert.deepEqual(plan.rows[0].identity.candidates, [client.id]);
  assert.equal(plan.summary.eligibleVisits, 0);
  assert.equal(plan.summary.eligibleSourceNetSales, 0);
  assert.equal(plan.summary.unknown.completion, 1);
  assert.equal(plan.summary.unknown.request, 1);
  assertAccounting(plan);
});

test("history acceptance: local dates, created timestamps and DST ambiguity are distinct evidence", () => {
  const ordinary = normalized()[0];
  assert.deepEqual(ordinary.completionBasis, {
    method: "explicit_mapping",
    sourceValue: "Completed",
    mappedValue: "completed",
  });
  assert.deepEqual(ordinary.requestBasis, {
    method: "explicit_mapping",
    sourceValue: "No",
    mappedValue: "no",
  });
  assert.equal(ordinary.interpretation.dateTimeFormat, "fresha-en");
  assert.equal(ordinary.interpretation.sourceTimeZone, "Europe/Belgrade");
  assert.deepEqual(ordinary.interpretation.money, confirmedFormat.money);
  assert.equal(ordinary.scheduledAt, "2026-01-15T09:00:00.000Z");
  assert.equal(ordinary.sourceCreatedAt.localDate, "2026-01-04");
  assert.equal(ordinary.sourceCreatedAt.timeMinute, 17 * 60 + 43);
  assert.equal(ordinary.sourceCreatedAt.instant, "2026-01-04T16:43:00.000Z");
  for (const scheduledDate of ["29 Mar 2026, 2:30am", "25 Oct 2026, 2:30am"]) {
    const row = normalized([{ scheduledDate, slot: "02:30:00-03:30:00" }])[0];
    assert.equal(row.scheduledAt, null, scheduledDate);
    assert.ok(row.issues.length, scheduledDate);
    assert.notEqual(planned([row]).rows[0].disposition, "ready");
  }
  for (const bad of [
    { scheduledDate: "31 Feb 2026, 10:00am" },
    { slot: "10:15:00-11:15:00" },
    { duration: "1h 30min" },
    { duration: "25h 0min" },
  ]) {
    const plan = planned(normalized([bad]));
    assert.equal(plan.rows[0].disposition, "invalid", JSON.stringify(bad));
    assertAccounting(plan);
  }
});

test("history acceptance: exact minor units never become payment, full price or a rounded malformed value", () => {
  const rows = normalized([
    { netSales: "0.29" },
    { netSales: "" },
    { netSales: "1.005" },
    { netSales: "not money" },
  ]);
  assert.equal(rows[0].sourceNetSalesMinor, 29);
  assert.equal(rows[1].sourceNetSalesMinor, null);
  assert.equal(rows[2].sourceNetSalesMinor, null);
  assert.equal(rows[3].sourceNetSalesMinor, null);
  for (const row of rows) {
    assert.equal(row.fullPriceMinor, null);
    assert.equal(row.paidAmountMinor, null);
    assert.equal(row.bonusAmountMinor, null);
  }
  const comma = normalized([{ netSales: "1.234,56" }], {
    format: {
      ...confirmedFormat,
      money: {
        currency: "EUR",
        minorUnitDigits: 2,
        decimalSeparator: ",",
        groupSeparator: ".",
      },
    },
  });
  assert.equal(comma[0].sourceNetSalesMinor, 123456);
  const plan = planned(rows);
  assert.equal(plan.rows[2].disposition, "invalid");
  assert.equal(plan.rows[3].disposition, "invalid");
  assertAccounting(plan);
});

test("history acceptance: past and paid-looking rows do not prove completion or requested bonus", () => {
  const statuses = [
    "New",
    "Confirmed",
    "Started",
    "Cancelled",
    "No Show",
    "Completed",
  ];
  const rows = normalized(
    statuses.map((status, i) => ({
      appointmentRef: `s${i}`,
      status,
      requested: "",
      netSales: "9900",
    })),
  );
  assert.deepEqual(
    rows.map((r) => r.completionState),
    [
      "unknown",
      "unknown",
      "unknown",
      "not_completed",
      "not_completed",
      "completed",
    ],
  );
  for (const row of rows) {
    assert.equal(row.requestState, "unknown");
    assert.equal(row.bonusRule, null);
    assert.equal(row.bonusAmountMinor, null);
  }
  assertAccounting(planned(rows));
});

test("history acceptance: optional unknowns do not erase independently verified visit eligibility", () => {
  const plan = planned(
    normalized([
      { appointmentRef: "known-visit", netSales: "", requested: "" },
      { appointmentRef: "unknown-completion", status: "New", requested: "" },
    ]),
  );
  assert.deepEqual(
    plan.rows.map((row) => row.disposition),
    ["ready", "ready"],
  );
  assert.deepEqual(plan.rows[0].eligibility, {
    visits: true,
    sourceNetSales: false,
    bonuses: false,
  });
  assert.deepEqual(plan.rows[1].eligibility, {
    visits: false,
    sourceNetSales: true,
    bonuses: false,
  });
  assert.equal(plan.rows[0].record.requestState, "unknown");
  assert.equal(plan.rows[0].record.sourceNetSalesMinor, null);
  assert.equal(plan.rows[1].record.completionState, "unknown");
  assert.equal(plan.summary.eligibleVisits, 1);
  assert.equal(plan.summary.eligibleSourceNetSales, 1);
  assert.equal(plan.summary.unknown.request, 2);
  const unknownCurrency = planned(
    normalized([{}], {
      format: {
        ...confirmedFormat,
        money: {
          currency: null,
          minorUnitDigits: null,
          decimalSeparator: ".",
          groupSeparator: null,
        },
      },
    }),
  );
  assert.equal(unknownCurrency.rows[0].disposition, "ready");
  assert.deepEqual(unknownCurrency.rows[0].eligibility, {
    visits: true,
    sourceNetSales: false,
    bonuses: false,
  });
  assert.equal(unknownCurrency.rows[0].record.sourceNetSalesMinor, null);
  assertAccounting(plan);
  assertAccounting(unknownCurrency);
});

test("history acceptance: verified external identities preserve namespace and leading zeros", () => {
  const exact = planned(normalized()).rows[0];
  assert.equal(exact.identity.state, "linked");
  assert.equal(exact.identity.clientId, client.id);
  assert.equal(exact.record.sourceClientId, "0007");
  for (const row of [
    normalized([{ clientSourceId: "7" }])[0],
    normalized([{}], { source: "different-salon:fresha" })[0],
  ]) {
    const entry = planned([row]).rows[0];
    assert.equal(entry.identity.clientId, null);
    assert.equal(entry.disposition, "unresolved");
  }
  const rowKeyOnly = planned(normalized(), {
    sourceLinks: [
      { source, source_key: `row:${fileDigest}:2`, client_id: client.id },
    ],
  });
  assert.equal(rowKeyOnly.rows[0].identity.clientId, null);
  assertAccounting(rowKeyOnly);
});

test("history acceptance: name twins and compatible contacts remain reviewable, contradictory contacts conflict", () => {
  const twin = {
    ...client,
    id: "client-qa-twin",
    phone: "",
    email: "",
    instagram: "",
  };
  const nameOnly = planned(normalized([{ clientSourceId: "" }]), {
    clients: [twin, client],
  });
  assert.deepEqual(
    nameOnly.rows[0].identity.candidates,
    [client.id, twin.id].sort(),
  );
  assert.equal(nameOnly.rows[0].identity.clientId, null);
  assert.equal(nameOnly.rows[0].disposition, "unresolved");
  const proposal = planned(
    normalized([
      {
        clientSourceId: "",
        phone: "060 1234567",
        email: "NORA@EXAMPLE.TEST",
        instagram: "https://instagram.com/nora_example/",
      },
    ]),
  );
  assert.equal(proposal.rows[0].identity.state, "proposed");
  assert.equal(proposal.rows[0].identity.clientId, null);
  assert.equal(proposal.rows[0].disposition, "unresolved");
  const other = {
    id: "client-qa-other",
    name: "Milo Example",
    email: "milo@example.test",
  };
  for (const externalId of ["", "0007"]) {
    const conflict = planned(
      normalized([
        { clientSourceId: externalId, phone: "0601234567", email: other.email },
      ]),
      { clients: [client, other] },
    );
    assert.equal(conflict.rows[0].identity.state, "conflict");
    assert.equal(conflict.rows[0].identity.clientId, null);
    assert.equal(conflict.rows[0].disposition, "conflict");
    assertAccounting(conflict);
  }
  assertAccounting(nameOnly);
  assertAccounting(proposal);
});

test("history acceptance: stable references survive file reordering; changed content conflicts for every occurrence", () => {
  const first = planned(
    normalized([{}, { appointmentRef: "0043", netSales: "6200" }]),
  );
  const accepted = first.rows.map((row, i) => ({
    id: `archive-${i}`,
    source: row.record.source,
    sourceKey: row.sourceKey,
    payloadDigest: row.payloadDigest,
  }));
  const reordered = planned(
    normalized([{ appointmentRef: "0043", netSales: "6200" }, {}], {
      fileDigest: "b".repeat(64),
    }),
    { existingHistory: accepted },
  );
  assert.deepEqual(
    reordered.rows.map((row) => row.disposition),
    ["duplicate", "duplicate"],
  );
  assert.deepEqual(
    reordered.rows.map((row) => row.payloadDigest),
    first.rows.map((row) => row.payloadDigest).reverse(),
  );
  const changed = planned(normalized([{}, { netSales: "5901" }, {}]));
  assert.deepEqual(
    changed.rows.map((row) => row.disposition),
    ["conflict", "conflict", "conflict"],
  );
  assert.equal(changed.summary.conflict, 3);
  const namespace = planned(
    normalized([{}], { source: "second-salon:fresha" }),
    { existingHistory: accepted },
  );
  assert.notEqual(namespace.rows[0].disposition, "duplicate");
  const zero = planned(normalized([{ appointmentRef: "42" }]));
  assert.notEqual(zero.rows[0].sourceKey, first.rows[0].sourceKey);
  const defaultBasis = planned(normalized([{ status: "Cancelled" }])).rows[0];
  const revisedInterpretation = planned(
    normalized([{ status: "Cancelled" }], {
      format: {
        ...confirmedFormat,
        completionMap: { Cancelled: "not_completed" },
      },
    }),
    {
      existingHistory: [
        {
          id: "basis-archive",
          source,
          sourceKey: defaultBasis.sourceKey,
          payloadDigest: defaultBasis.payloadDigest,
        },
      ],
    },
  );
  assert.equal(defaultBasis.record.completionBasis.method, "source_status");
  assert.equal(
    revisedInterpretation.rows[0].record.completionState,
    "not_completed",
  );
  assert.equal(
    revisedInterpretation.rows[0].record.completionBasis.method,
    "explicit_mapping",
  );
  assert.equal(revisedInterpretation.rows[0].disposition, "conflict");
  assertAccounting(reordered);
  assertAccounting(changed);
});

test("history acceptance: service-line verification and file retry keys never silently establish global uniqueness", () => {
  const rows = normalized([
    {},
    { serviceLineRef: "02", serviceName: "Second historical service" },
  ]);
  const linePlan = planned(rows, { referenceMode: "service-line" });
  assert.notEqual(linePlan.rows[0].sourceKey, linePlan.rows[1].sourceKey);
  assert.ok(linePlan.rows.every((row) => row.keyScope === "service-line"));
  const unverified = planned(rows, { referenceMode: "unverified" });
  assert.ok(
    unverified.rows.every(
      (row) => row.keyScope === "file-row" && row.disposition === "unresolved",
    ),
  );
  const missingLine = planned(normalized([{ serviceLineRef: "" }]), {
    referenceMode: "service-line",
  });
  assert.equal(missingLine.rows[0].disposition, "unresolved");
  const accepted = unverified.rows.map((row, i) => ({
    id: `file-archive-${i}`,
    source,
    sourceKey: row.sourceKey,
    payloadDigest: row.payloadDigest,
  }));
  const retry = planned(rows, {
    referenceMode: "unverified",
    existingHistory: accepted,
  });
  assert.ok(retry.rows.every((row) => row.disposition === "duplicate"));
  const differentFile = planned(
    normalized(
      [{}, { serviceLineRef: "02", serviceName: "Second historical service" }],
      { fileDigest: "c".repeat(64) },
    ),
    { referenceMode: "unverified", existingHistory: accepted },
  );
  assert.ok(
    differentFile.rows.every((row) => row.disposition === "unresolved"),
  );
  assertAccounting(differentFile);
});

test("history acceptance: native overlap is review-only and pure calls preserve frozen snapshots and historical labels", () => {
  const sourceInput = freeze(input());
  const originalInput = structuredClone(sourceInput);
  const result = normalizeHistoryRows(sourceInput);
  const args = freeze({
    rows: result.rows,
    clients: [structuredClone(client)],
    sourceLinks: structuredClone(sourceLinks),
    referenceMode: "verified-appointment",
    nativeAppointments: [
      {
        id: "native-existing",
        clientId: client.id,
        clientName: client.name,
        date: "2026-01-15",
        start: 600,
        duration: 60,
        serviceName: "Renamed current treatment",
      },
    ],
  });
  const originalArgs = structuredClone(args);
  const a = planHistoryImport(args);
  const b = planHistoryImport(args);
  assert.deepEqual(a, b);
  assert.deepEqual(sourceInput, originalInput);
  assert.deepEqual(args, originalArgs);
  assert.equal(a.rows[0].disposition, "unresolved");
  assert.deepEqual(a.rows[0].nativeOverlapIds, ["native-existing"]);
  assert.equal(
    a.rows[0].record.sourceServiceLabel,
    "Historical treatment label",
  );
  assert.equal(
    a.rows[0].record.sourceTherapistLabel,
    "Former Therapist Example",
  );
  assert.equal(a.rows[0].duplicateOf, null);
  assert.equal(a.summary.eligibleVisits, 0);
  assertAccounting(a);
});
