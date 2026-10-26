import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../public/rei-reports-sync.gs", import.meta.url),
  "utf8",
);
const secret = "rei_rpt_" + "private-fixture-token".repeat(3);
const base = "https://rei-booking.mbaucal.workers.dev/api";
const shift = (date, days) =>
  new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
const comparisonKeys = [
  "revenue_cents",
  "completed_massages",
  "massage_minutes",
  "bonus_cents",
  "included_treatments",
  "historical_visits",
  "historical_minutes",
];

function metrics(from, to) {
  return {
    from,
    to,
    appointments: 3,
    completed_massages: 1,
    cancelled: 1,
    no_show: 1,
    pending: 0,
    requested_bookings: 1,
    massage_minutes: 150,
    native_minutes: 90,
    regular_minutes: 0,
    requested_minutes: 90,
    revenue_cents: 590000,
    average_revenue_cents: 590000,
    average_minutes_per_day: 75,
    day_count: 2,
    included_treatments: 2,
    historical_rows: 1,
    historical_treatments: 1,
    historical_visits: 1,
    historical_minutes: 60,
    source_net_sales: [
      { currency: "RSD", minor_unit_digits: 2, amount_minor: 470000, rows: 1 },
      { currency: "EUR", minor_unit_digits: 2, amount_minor: null, rows: 1 },
    ],
    missing: {
      requested: 1,
      completion: 1,
      status: 0,
      source_money: 1,
      full_price: 1,
      bonus: 1,
    },
    excluded_native_overlap: 0,
    bonus_cents: 75000,
    regular_bonus_cents: 0,
    requested_bonus_cents: 75000,
  };
}

function report(from, to) {
  const count = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  const previousFrom = shift(from, -count),
    previousTo = shift(from, -1);
  const totals = metrics(from, to),
    previous = metrics(previousFrom, previousTo);
  return {
    schema_version: "1",
    demo: false,
    currency: "RSD",
    timezone: "Europe/Belgrade",
    from,
    to,
    filters: {
      group_by: "therapist",
      source: "all",
      therapist: "",
      treatment: "",
      status: "all",
      requested: "all",
      average_day_basis: "active",
      include_bonuses: true,
    },
    complete: true,
    next_cursor: null,
    generated_at: "2026-10-25T12:00:00.000Z",
    rows: [
      {
        key: '{"therapist":"t-1"}',
        dimensions: { therapist: "t-1" },
        label: '=HYPERLINK("https://invalid.example")',
        ...metrics(from, to),
      },
    ],
    totals,
    previous,
    comparison: Object.fromEntries(
      comparisonKeys.map((key) => [
        key,
        {
          value: totals[key],
          previous: previous[key],
          difference: 0,
          percent: 0,
        },
      ]),
    ),
    coverage: {
      from,
      to,
      comparison_from: previousFrom,
      comparison_to: previousTo,
      source: "all",
      snapshot_consistent: true,
      native_rows_loaded: 3,
      history_rows_loaded: 1,
      history_archive_rows: 1,
      history_archive_from: "2024-03-12",
      history_archive_to: "2026-08-10",
      historical_import_completeness: "not_verified",
      native_row_limit: 20000,
      historical_row_limit: 50000,
      archive_revision: 2,
      catalogue_revision: 1,
      native_audit_id: 19,
    },
    client_email: "must-not-be-exported@example.invalid",
  };
}

function harness(options = {}) {
  const state = {
    properties: {
      REI_API_BASE: base,
      REI_API_TOKEN: secret,
      REI_SPREADSHEET_ID: "fixture_private_workbook_id",
      REI_START_DATE: "2026-09-01",
      ...options.properties,
    },
    operations: [],
    requests: [],
    openCount: 0,
    releases: 0,
    insertCount: 0,
    deleted: [],
    triggers: [],
  };
  function sheet(name, existing = false) {
    const result = {
      name,
      existing,
      matrix: null,
      metadata: [],
      maxRows: 1000,
      maxColumns: 26,
      getName() {
        return name;
      },
      getDeveloperMetadata() {
        return result.metadata.map(([key, value]) => ({
          getKey: () => key,
          getValue: () => value,
        }));
      },
      getMaxRows() {
        return result.maxRows;
      },
      getMaxColumns() {
        return result.maxColumns;
      },
      insertRowsAfter(_after, count) {
        mutate();
        result.maxRows += count;
      },
      insertColumnsAfter(_after, count) {
        mutate();
        result.maxColumns += count;
      },
      getRange() {
        return {
          setValues(values) {
            mutate();
            if (options.failWriteAt === state.insertCount)
              throw new Error("private vendor error " + secret);
            result.matrix = JSON.parse(JSON.stringify(values));
            state.operations.push("write:" + name);
            return this;
          },
          setFontWeight() {
            mutate();
            return this;
          },
          setBackground() {
            mutate();
            return this;
          },
          setNumberFormat() {
            mutate();
            return this;
          },
        };
      },
      setFrozenRows() {
        mutate();
      },
      setFrozenColumns() {
        mutate();
      },
      setColumnWidth() {
        mutate();
      },
      setColumnWidths() {
        mutate();
      },
      addDeveloperMetadata(key, value) {
        mutate();
        result.metadata.push([key, value]);
      },
    };
    function mutate() {
      assert.equal(existing, false, "an existing tab must never be modified");
    }
    return result;
  }
  state.sheets = [sheet("Old salon spreadsheet", true)];
  const workbook = {
    getSheets: () => state.sheets,
    getSheetByName: (name) =>
      state.sheets.find((item) => item.name === name) || null,
    insertSheet(name) {
      state.insertCount++;
      const item = sheet(name);
      state.sheets.push(item);
      return item;
    },
    deleteSheet(item) {
      assert.equal(item.existing, false, "never delete existing tabs");
      if (options.failDelete)
        throw new Error("private deletion error " + secret);
      state.deleted.push(item);
      state.sheets = state.sheets.filter((s) => s !== item);
    },
  };
  const clock = options.now || "2026-10-26T10:00:00Z";
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
  }
  const formatDate = (date, timezone, format) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return format === "yyyy-MM-dd"
      ? `${p.year}-${p.month}-${p.day}`
      : `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
  };
  const context = vm.createContext({
    Date: FixedDate,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({ ...state.properties }),
        getProperty: (key) => state.properties[key] || null,
        setProperty: (key, value) => {
          state.properties[key] = value;
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => !options.busy,
        releaseLock: () => {
          state.releases++;
        },
      }),
    },
    Utilities: {
      formatDate,
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm, value) =>
        Array.from(createHash("sha256").update(value).digest()),
    },
    UrlFetchApp: {
      fetch(url, fetchOptions) {
        state.requests.push({ url, options: fetchOptions });
        state.operations.push("fetch");
        if (options.fetchError)
          throw new Error("private URL or token " + secret);
        const query = new URL(url).searchParams;
        const payload = report(query.get("from"), query.get("to"));
        options.mutateReport?.(payload, state.requests.length);
        return {
          getResponseCode: () => options.status || 200,
          getContentText: () => options.rawBody ?? JSON.stringify(payload),
        };
      },
    },
    SpreadsheetApp: {
      openById(id) {
        assert.equal(id, state.properties.REI_SPREADSHEET_ID);
        state.openCount++;
        state.operations.push("open");
        if (options.openError) throw new Error(secret);
        return workbook;
      },
      flush() {},
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers,
      deleteTrigger(trigger) {
        state.triggers = state.triggers.filter((t) => t !== trigger);
      },
      newTrigger(handler) {
        const config = { handler, getHandlerFunction: () => handler };
        const builder = {
          timeBased() {
            return this;
          },
          atHour(value) {
            config.hour = value;
            return this;
          },
          nearMinute(value) {
            config.minute = value;
            return this;
          },
          everyDays(value) {
            config.days = value;
            return this;
          },
          inTimezone(value) {
            config.timezone = value;
            return this;
          },
          create() {
            state.triggers.push(config);
            return config;
          },
        };
        return builder;
      },
    },
  });
  new vm.Script(source, { filename: "rei-reports-sync.gs" }).runInContext(
    context,
  );
  return {
    state,
    options,
    run: (fn = "reiSyncReports") => context[fn](),
    context,
  };
}

test("manual snapshot keeps old tabs, projects only aggregate fields and writes real numeric hours and RSD", () => {
  const h = harness();
  const result = h.run();
  assert.equal(result.created, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(h.state.sheets[0].matrix, null);
  const cells = h.state.sheets[1].matrix,
    current = cells[9];
  assert.match(current[0], /^'=HYPERLINK/);
  assert.equal(current[11], 2.5);
  assert.equal(current[15], 5900);
  assert.equal(current[19], 750);
  assert.equal(cells.find((row) => row[1] === "RSD")[2], 4700);
  assert.equal(cells.find((row) => row[1] === "EUR")[2], "");
  assert.equal(
    cells.find((row) => row[0] === "historical_import_completeness")[1],
    "not_verified",
  );
  assert.equal(JSON.stringify(cells).includes("must-not-be-exported"), false);
  assert.equal(JSON.stringify(cells).includes(secret), false);
  assert.equal(h.state.properties.REI_MANUAL_SYNC_SIGNATURE.length, 64);
  const fetch = h.state.requests[0];
  assert.equal(fetch.options.headers.Authorization, "Bearer " + secret);
  assert.equal(fetch.options.followRedirects, false);
  assert.equal(fetch.options.validateHttpsCertificates, true);
  assert.equal(fetch.options.muteHttpExceptions, true);
  assert.equal(fetch.url.includes(secret), false);
  assert.equal(h.state.releases, 1);
});

test("calendar-year windows support two years including leap days, through yesterday in Belgrade", () => {
  const h = harness({
    now: "2026-01-01T23:30:00Z",
    properties: { REI_START_DATE: "2024-01-01" },
  });
  const result = h.run();
  assert.equal(result.periods, 3);
  assert.deepEqual(
    h.state.requests.map((r) => {
      const q = new URL(r.url).searchParams;
      return [q.get("from"), q.get("to")];
    }),
    [
      ["2024-01-01", "2024-12-31"],
      ["2025-01-01", "2025-12-31"],
      ["2026-01-01", "2026-01-01"],
    ],
  );
  assert.deepEqual(h.state.operations.slice(0, 4), [
    "fetch",
    "fetch",
    "fetch",
    "open",
  ]);
  assert.equal(h.state.sheets.length, 4);
});

test("unchanged retries ignore generation time and provenance revisions; changed data creates another tab", () => {
  const h = harness();
  h.run();
  h.options.mutateReport = (r) => {
    r.generated_at = "2026-10-26T12:00:00.000Z";
    r.coverage.native_audit_id++;
  };
  assert.equal(h.run().unchanged, 1);
  assert.equal(h.state.sheets.length, 2);
  h.options.mutateReport = (r) => {
    r.rows[0].revenue_cents++;
    r.totals.revenue_cents++;
    r.comparison.revenue_cents.value++;
    r.comparison.revenue_cents.difference++;
  };
  assert.equal(h.run().created, 1);
  assert.equal(h.state.sheets.length, 3);
  assert.match(h.state.sheets[2].name, /\(2\)$/);
  assert.equal(h.state.deleted.length, 0);
});

test("manual success is bound to all config before creating one daily trigger; other triggers survive", () => {
  const h = harness();
  assert.throws(
    () => h.run("reiInstallDailySync"),
    /Run reiSyncReports manually/,
  );
  assert.throws(() => h.run("reiScheduledSync"), /Run reiSyncReports manually/);
  h.run();
  const other = { getHandlerFunction: () => "otherAutomation" };
  h.state.triggers.push(other);
  h.run("reiInstallDailySync");
  h.run("reiInstallDailySync");
  assert.equal(h.state.triggers.length, 2);
  assert.equal(h.state.triggers[1].hour, 9);
  assert.equal(h.state.triggers[1].timezone, "Europe/Belgrade");
  h.state.triggers.push({ getHandlerFunction: () => "reiScheduledSync" });
  h.run("reiInstallDailySync");
  assert.equal(h.state.triggers.length, 2);
  assert.equal(h.run("reiScheduledSync").unchanged, 1);
  for (const [key, value] of Object.entries({
    REI_API_TOKEN: secret + "x",
    REI_SPREADSHEET_ID: "another_private_workbook_id",
    REI_START_DATE: "2026-09-02",
  })) {
    const old = h.state.properties[key];
    h.state.properties[key] = value;
    assert.throws(
      () => h.run("reiInstallDailySync"),
      /Run reiSyncReports manually/,
    );
    assert.throws(
      () => h.run("reiScheduledSync"),
      /Run reiSyncReports manually/,
    );
    h.state.properties[key] = old;
  }
  h.run("reiRemoveDailySync");
  assert.deepEqual(h.state.triggers, [other]);
});

test("bad destinations, credentials, dates and lock contention fail before fetching", () => {
  for (const properties of [
    { REI_API_BASE: "https://attacker.example/api" },
    { REI_API_BASE: base + "?token=bad" },
    { REI_API_BASE: base.replace("https:", "http:") },
    { REI_API_BASE: base.replace("https://", "https://user@") },
    { REI_API_TOKEN: "short" },
    { REI_SPREADSHEET_ID: "bad" },
    { REI_START_DATE: "2026-02-30" },
    { REI_START_DATE: "2026-10-26" },
    { REI_START_DATE: "2010-01-01" },
  ]) {
    const h = harness({ properties });
    assert.throws(() => h.run());
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.openCount, 0);
  }
  const busy = harness({ busy: true });
  assert.throws(() => busy.run(), /Another Rei sync/);
  assert.equal(busy.state.requests.length, 0);
});

test("HTTP redirects/errors, malformed JSON and transport failures never expose response bodies or credentials", () => {
  for (const options of [
    { status: 302 },
    { status: 401 },
    { status: 429 },
    { rawBody: secret },
    { fetchError: true },
    { openError: true },
  ]) {
    const h = harness(options);
    assert.throws(
      () => h.run(),
      (error) => !String(error).includes(secret),
    );
    assert.equal(h.state.sheets.length, 1);
    assert.equal(h.state.insertCount, 0);
    assert.equal(h.state.releases, 1);
  }
});

test("incompatible, partial, incorrectly filtered or malformed reports are rejected before opening Sheets", () => {
  const mutations = [
    (r) => {
      r.schema_version = "2";
    },
    (r) => {
      r.demo = true;
    },
    (r) => {
      r.complete = false;
    },
    (r) => {
      r.next_cursor = "next";
    },
    (r) => {
      r.timezone = "UTC";
    },
    (r) => {
      r.currency = "EUR";
    },
    (r) => {
      r.from = "2025-01-01";
    },
    (r) => {
      r.previous.from = r.from;
    },
    (r) => {
      r.filters.source = "native";
    },
    (r) => {
      r.filters.therapist = "hidden-filter";
    },
    (r) => {
      r.filters.include_bonuses = false;
    },
    (r) => {
      r.filters.average_day_basis = "calendar";
    },
    (r) => {
      r.rows[0].dimensions = { day: r.from };
    },
    (r) => {
      r.rows.push(r.rows[0]);
    },
    (r) => {
      r.totals.revenue_cents = "590000";
    },
    (r) => {
      r.rows[0].massage_minutes = -1;
    },
    (r) => {
      r.rows[0].appointments = 1.5;
    },
    (r) => {
      r.rows[0].appointments = Number.MAX_SAFE_INTEGER + 1;
    },
    (r) => {
      r.rows[0].source_net_sales[0].minor_unit_digits = 8;
    },
    (r) => {
      r.rows[0].source_net_sales[0].currency = "=SUM(A1)";
    },
    (r) => {
      r.rows[0].missing.bonus = null;
    },
    (r) => {
      r.comparison.revenue_cents.difference = 1;
    },
    (r) => {
      r.coverage.snapshot_consistent = false;
    },
    (r) => {
      r.coverage.history_rows_loaded = 50001;
    },
    (r) => {
      r.coverage.history_archive_to = null;
    },
  ];
  for (const mutateReport of mutations) {
    const h = harness({ mutateReport });
    assert.throws(() => h.run(), /incomplete or incompatible/);
    assert.equal(h.state.openCount, 0);
  }
  const h = harness();
  for (const value of [Infinity, -Infinity, NaN])
    assert.throws(() => h.context.reiNumber_(value, false, true, true));
  assert.equal(h.context.reiNumber_(null, false, true, true), null);
});

test("a failed later period causes no writes; partial writes only remove sheets from this invocation", () => {
  const h = harness({
    properties: { REI_START_DATE: "2025-06-01" },
    mutateReport: (r, number) => {
      if (number === 2) r.complete = false;
    },
  });
  assert.throws(() => h.run(), /incomplete/);
  assert.equal(h.state.openCount, 0);
  const write = harness({
    properties: { REI_START_DATE: "2025-06-01" },
    failWriteAt: 2,
  });
  assert.throws(() => write.run(), /existing tabs were preserved/);
  assert.equal(write.state.sheets.length, 1);
  assert.equal(write.state.deleted.length, 2);
  assert.equal(write.state.properties.REI_MANUAL_SYNC_SIGNATURE, undefined);
  const cleanup = harness({ failWriteAt: 1, failDelete: true });
  assert.throws(() => cleanup.run(), /check new incomplete Rei tabs/);
  assert.equal(cleanup.state.sheets[0].existing, true);
  assert.equal(cleanup.state.sheets[1].metadata.length, 0);
});

test("response, row and aggregate cell bounds reject oversized work before mutation", () => {
  const oversized = harness({ rawBody: "x".repeat(4000001) });
  assert.throws(() => oversized.run(), /too large/);
  assert.equal(oversized.state.openCount, 0);
  const manyRows = harness({
    mutateReport: (r) => {
      r.rows = Array(5001).fill({});
    },
  });
  assert.throws(() => manyRows.run(), /incomplete/);
  assert.equal(manyRows.state.openCount, 0);
  const manyCells = harness({
    mutateReport: (r) => {
      r.rows = Array.from({ length: 400 }, (_, index) => ({
        ...r.rows[0],
        key: "t" + index,
        dimensions: { therapist: "t" + index },
        source_net_sales: Array.from({ length: 50 }, (_, i) => ({
          currency:
            "X" +
            String.fromCharCode(65 + Math.floor(i / 26)) +
            String.fromCharCode(65 + (i % 26)),
          minor_unit_digits: 2,
          amount_minor: 1,
          rows: 1,
        })),
      }));
    },
  });
  assert.throws(() => manyCells.run(), /combined report is too large/);
  assert.equal(manyCells.state.openCount, 0);
});
