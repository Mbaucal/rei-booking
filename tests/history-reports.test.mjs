import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  loadHistoricalReportRows,
  historicalVisitEligibility,
} from "../src/history-reports.mjs";
import {
  buildReport,
  reportOptions,
  reportCSV,
  GROUPS,
  comparison,
} from "../src/reports.mjs";
import { HISTORY_SALON_SCHEMA } from "../src/history-salon-schema.mjs";
const options = (extra = {}) =>
  reportOptions(
    new URLSearchParams({
      preset: "custom",
      from: "2026-08-01",
      to: "2026-08-31",
      ...extra,
    }),
    "2026-10-25",
  );
const native = (id, extra = {}) => ({
  id,
  therapist_id: "t1",
  therapist_name: "Therapist One",
  service_id: "s1",
  service_name: "Treatment One",
  date: "2026-08-02",
  start_minute: 600,
  duration: 60,
  created_at: "2026-07-01T10:00:00Z",
  cancelled_at: null,
  gross_cents: 10000,
  net_cents: 9000,
  status: "done",
  requested_therapist_id: null,
  bonus_regular_cents_hour: 1000,
  bonus_requested_cents_hour: 2000,
  ...extra,
});
const history = (id, extra = {}) => ({
  id: `history:${id}`,
  report_source: "history",
  source: "fictional",
  visit_key: JSON.stringify(["fictional", id]),
  therapist_id: "ht1",
  therapist_name: "Source Therapist",
  service_id: "hs1",
  service_name: "Source Treatment",
  date: "2026-08-03",
  start_minute: 600,
  duration: 60,
  status: "booked",
  source_status: "New",
  completion_state: "unknown",
  counts_as_visit: true,
  request_state: "unknown",
  source_net_sales_minor: 50000,
  currency: "RSD",
  minor_unit_digits: 2,
  money_basis: "source",
  source_time_zone: null,
  native_overlap: false,
  ...extra,
});
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE audit_log(id INTEGER PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE clients(id TEXT PRIMARY KEY); CREATE TABLE therapists(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE services(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE history_archive_state(id INTEGER PRIMARY KEY,revision INTEGER); INSERT INTO history_archive_state VALUES(1,7); CREATE TABLE history_archive(id TEXT,source TEXT,ref_hash TEXT,client_id TEXT,source_status TEXT,completion_state TEXT,date TEXT,start_minute INTEGER,duration INTEGER,record_json TEXT); CREATE INDEX history_ref ON history_archive(source,ref_hash); CREATE TABLE appointments(id TEXT,client_id TEXT,date TEXT,start_minute INTEGER,duration INTEGER);`,
  );
  for (const sql of HISTORY_SALON_SCHEMA) sqlite.exec(sql);
  function prepare(sql, args = []) {
    return {
      bind(...values) {
        return prepare(sql, values);
      },
      async first() {
        return sqlite.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...args) };
      },
      execute() {
        const query = sqlite.prepare(sql);
        return {
          results: query.columns().length
            ? query.all(...args)
            : (query.run(...args), []),
        };
      },
    };
  }
  const db = {
    prepare,
    batch: async (statements) => statements.map((s) => s.execute()),
  };
  const insert = (id, overrides = {}) => {
    const record = {
      sourceTherapistLabel: "Old Therapist",
      sourceServiceLabel: "Old Treatment",
      sourceRoomLabel: "Old Room",
      requestState: "unknown",
      sourceNetSalesMinor: 50000,
      currency: "RSD",
      sourceTimeZone: null,
      raw: { netSales: "500.00" },
      interpretation: {
        money: {
          currency: "RSD",
          minorUnitDigits: 2,
          decimalSeparator: ".",
          groupSeparator: null,
        },
      },
      ...overrides.record,
    };
    sqlite
      .prepare("INSERT INTO history_archive VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        overrides.source || "fictional",
        overrides.ref || id,
        overrides.client || "private-client-id",
        overrides.status ?? "New",
        overrides.completion || "unknown",
        overrides.date || "2026-08-03",
        overrides.start ?? 600,
        overrides.duration || 60,
        JSON.stringify(record),
      );
  };
  return { sqlite, db, insert };
}
test("all source statuses except explicit no-show/cancellation remain eligible without changing completion evidence", () => {
  for (const status of [
    "New",
    "Confirmed",
    "Started",
    "Completed",
    "Custom supplied status",
    "-",
    "_",
  ])
    assert.equal(historicalVisitEligibility(status), true);
  for (const status of [
    "No Show",
    "no_show",
    "NO-SHOW",
    "Canceled",
    "Cancelled",
  ])
    assert.equal(historicalVisitEligibility(status), false);
  assert.equal(historicalVisitEligibility(null), null);
  const rows = [
    native("native"),
    native("pending", { status: "confirmed" }),
    history("a"),
    history("b", {
      visit_key: JSON.stringify(["fictional", "a"]),
      therapist_id: "ht2",
      duration: 30,
      source_status: "Started",
      status: "unknown",
      source_net_sales_minor: null,
      currency: null,
    }),
    history("cancel", {
      counts_as_visit: false,
      status: "cancelled",
      source_status: "Cancelled",
    }),
    history("no", {
      counts_as_visit: false,
      status: "no_show",
      source_status: "No Show",
    }),
    history("custom", {
      source_status: "Custom supplied status",
      source_net_sales_minor: null,
      currency: null,
    }),
    history("zero", { source_net_sales_minor: 0, currency: "EUR" }),
  ];
  const report = buildReport(rows, options());
  assert.equal(report.totals.includedTreatments, 5);
  assert.equal(report.totals.historicalTreatments, 4);
  assert.equal(report.totals.historicalVisits, 3);
  assert.equal(report.totals.totalMinutes, 270);
  assert.equal(report.totals.revenueCents, 9000);
  assert.equal(report.totals.completed, 1);
  assert.equal(report.totals.totalBonusCents, 1000);
  assert.equal(report.totals.unavailableMoneyRows, 2);
  assert.deepEqual(report.totals.sourceNetSales, [
    { currency: "EUR", minorUnitDigits: 2, amountMinor: 0, rows: 1 },
    { currency: "RSD", minorUnitDigits: 2, amountMinor: 50000, rows: 1 },
  ]);
  const detail = report.details.find((r) => r.id === "history:a");
  assert.equal(detail.sourceStatus, "New");
  assert.equal(detail.completionState, "unknown");
  for (const field of [
    "requested",
    "requestFulfilled",
    "bonusCents",
    "bonusMode",
    "grossCents",
    "netCents",
  ])
    assert.equal(detail[field], null, field);
});
test("all nine groupings reconcile additive treatment/time/money metrics while visits stay unique per group", () => {
  const rows = [
    native("a"),
    history("b"),
    history("c", {
      visit_key: JSON.stringify(["fictional", "b"]),
      therapist_id: "ht2",
      therapist_name: "Other Source",
      service_id: "hs2",
      service_name: "Other Treatment",
      date: "2026-08-04",
      source_net_sales_minor: 1000,
      currency: "EUR",
    }),
  ];
  for (const group of Object.keys(GROUPS)) {
    const report = buildReport(rows, options({ group }));
    for (const metric of [
      "includedTreatments",
      "historicalTreatments",
      "historicalMinutes",
      "totalMinutes",
      "revenueCents",
      "totalBonusCents",
    ])
      assert.equal(
        report.groups.reduce((n, g) => n + g[metric], 0),
        report.totals[metric],
        group + metric,
      );
    for (const currency of ["RSD", "EUR"])
      assert.equal(
        report.groups
          .flatMap((g) => g.sourceNetSales)
          .filter((a) => a.currency === currency)
          .reduce((n, a) => n + a.amountMinor, 0),
        report.totals.sourceNetSales.find((a) => a.currency === currency)
          .amountMinor,
      );
    assert.equal(report.totals.historicalVisits, 1);
  }
});
test("source/request/status/date filters and comparisons remain explicit; unknown requests are never regular", () => {
  const rows = [
    native("a"),
    history("b"),
    history("c", {
      request_state: "no",
      status: "confirmed",
      source_status: "Confirmed",
    }),
    history("d", { request_state: "yes", date: "2026-07-31" }),
  ];
  assert.equal(
    buildReport(rows, options({ source: "native" })).totals.appointments,
    1,
  );
  assert.equal(
    buildReport(rows, options({ source: "history" })).totals.appointments,
    2,
  );
  assert.equal(
    buildReport(rows, options({ source: "history", requested: "no" }))
      .details[0].id,
    "history:c",
  );
  assert.equal(
    buildReport(rows, options({ source: "history", requested: "yes" })).totals
      .appointments,
    0,
  );
  assert.equal(
    buildReport(rows, options({ source: "history", status: "done" })).totals
      .appointments,
    0,
  );
  assert.equal(
    buildReport(rows, options({ source: "history", status: "confirmed" }))
      .totals.historicalTreatments,
    1,
  );
  assert.throws(() => options({ source: "arbitrary" }));
  const current = buildReport(rows, options()).totals,
    previous = buildReport([], options()).totals;
  const compared = comparison(current, previous);
  assert.equal(compared.includedTreatments.value, 3);
  assert.equal(compared.historicalMinutes.value, 120);
  assert.equal(compared.revenueCents.value, 9000);
});
test("CSV preserves raw status and unknown evidence with no client identity, invented price or bonus", () => {
  const r = buildReport(
    [
      history("x", {
        therapist_name: "=DANGER()",
        source_status: "Started",
        source_net_sales_minor: null,
        currency: null,
      }),
    ],
    options(),
  );
  const csv = reportCSV(r, "details", true);
  assert.match(csv, /"Started"/);
  assert.match(csv, /"Unknown"/);
  assert.match(csv, /"'\=DANGER\(\)"/);
  assert.doesNotMatch(csv, /private-client-id|"0\.00"/);
  assert.match(csv, /"Imported history"/);
  assert.match(csv, /"Full price RSD"/);
  assert.doesNotMatch(reportCSV(r, "details", false), /bonus/i);
  assert.match(
    reportCSV(r, "summary", true),
    /Imported visits \(unique in this group\)/,
  );
});
test("loader keeps source labels, stable source-scoped fallback IDs and exposes older date range", async () => {
  const f = fixture();
  f.insert("old", { date: "2020-05-01" });
  f.insert("current");
  f.insert("other", { source: "other-source" });
  const empty = await loadHistoricalReportRows(f.db, {
    from: "2026-10-01",
    to: "2026-10-24",
  });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.metadata.minDate, "2020-05-01");
  assert.equal(empty.metadata.totalRows, 3);
  assert.equal(empty.therapists.length, 2);
  const loaded = await loadHistoricalReportRows(f.db, {
    from: "2026-08-01",
    to: "2026-08-31",
  });
  assert.equal(loaded.rows[0].therapist_name, "Old Therapist");
  assert.notEqual(loaded.rows[0].therapist_id, loaded.rows[1].therapist_id);
  assert.ok(loaded.rows.every((r) => r.therapist_id.length <= 100));
  assert.equal(loaded.metadata.archiveRevision, 7);
  assert.equal(loaded.metadata.nativeAuditId, 0);
  assert.ok(Number.isInteger(loaded.metadata.catalogueRevision));
  assert.doesNotMatch(
    JSON.stringify(buildReport(loaded.rows, options())),
    /private-client-id/,
  );
  f.sqlite.close();
});
test("loader mappings do not replace source labels/prices; money settings recover only unknown amounts", async () => {
  const f = fixture();
  f.insert("explicit");
  f.insert("unknown", {
    record: {
      sourceNetSalesMinor: null,
      currency: null,
      interpretation: {
        money: {
          currency: null,
          minorUnitDigits: null,
          decimalSeparator: ".",
          groupSeparator: null,
        },
      },
    },
  });
  f.sqlite.exec(
    "INSERT INTO users VALUES('u'); INSERT INTO therapists VALUES('mapped-t','Renamed today'); INSERT INTO services VALUES('mapped-s','Current menu'); INSERT INTO history_catalogue_links VALUES('therapist','fictional','old therapist',0,'mapped-t','u','2026-10-25'),('service','fictional','old treatment',60,'mapped-s','u','2026-10-25'); UPDATE history_salon_settings SET currency='RSD',minor_unit_digits=2,time_zone='Europe/Belgrade' WHERE id=1;",
  );
  const loaded = await loadHistoricalReportRows(f.db, {
    from: "2026-08-01",
    to: "2026-08-31",
  });
  assert.ok(
    loaded.rows.every(
      (r) =>
        r.therapist_id === "mapped-t" &&
        r.service_id === "mapped-s" &&
        r.service_name === "Old Treatment",
    ),
  );
  assert.equal(
    loaded.rows.find((r) => r.id === "history:unknown").money_basis,
    "owner-confirmed",
  );
  assert.equal(
    loaded.rows.find((r) => r.id === "history:explicit").money_basis,
    "source",
  );
  const r = buildReport(
    loaded.rows,
    options({ therapist: "mapped-t", service: "mapped-s" }),
  );
  assert.equal(r.totals.sourceNetSales[0].amountMinor, 100000);
  assert.equal(r.totals.totalBonusCents, 0);
  assert.ok(
    r.details.every((d) => d.bonusCents === null && d.grossCents === null),
  );
  f.sqlite.close();
});
test("multi-line money stays unconfirmed across filtered ranges and native overlap is visible but excluded", async () => {
  const f = fixture();
  f.insert("line-a", { ref: "same-ref" });
  f.insert("line-b", { ref: "same-ref", date: "2026-07-31" });
  f.insert("overlap", { client: "another-client", start: 700 });
  f.sqlite.exec(
    "INSERT INTO appointments VALUES('a','another-client','2026-08-03',720,60)",
  );
  const loaded = await loadHistoricalReportRows(f.db, {
    from: "2026-08-01",
    to: "2026-08-31",
  });
  assert.equal(loaded.metadata.ambiguousMoneyRows, 1);
  assert.equal(loaded.metadata.nativeOverlapRows, 1);
  const r = buildReport(loaded.rows, options());
  assert.equal(r.totals.historicalTreatments, 1);
  assert.equal(r.totals.historicalVisits, 1);
  assert.equal(r.totals.totalMinutes, 60);
  assert.equal(r.totals.unavailableMoneyRows, 1);
  assert.deepEqual(r.totals.sourceNetSales, []);
  assert.equal(
    r.details.find((d) => d.id === "history:overlap").included,
    false,
  );
  assert.match(
    r.details.find((d) => d.id === "history:line-a").moneyIssue,
    /service lines/,
  );
  f.sqlite.close();
});
