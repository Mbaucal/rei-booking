import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  GROUPS,
  reportOptions,
  buildReport,
  reportCSV,
  comparison,
  bonusInput,
  belgradeToday,
} from "../src/reports.mjs";
import { REPORT_SCHEMA } from "../src/report-schema.mjs";
const options = (extra = {}) =>
  reportOptions(
    new URLSearchParams({
      preset: "custom",
      from: "2026-08-01",
      to: "2026-08-31",
      ...extra,
    }),
    "2026-09-22",
  );
const row = (id, extra = {}) => ({
  id,
  therapist_id: "t1",
  therapist_name: "Therapist One",
  service_id: "s1",
  service_name: "Thai 60",
  date: "2026-08-02",
  created_at: "2026-07-01T10:00:00Z",
  cancelled_at: null,
  start_minute: 600,
  duration: 60,
  gross_cents: 470000,
  net_cents: 470000,
  status: "done",
  requested_therapist_id: null,
  requested_name: null,
  bonus_regular_cents_hour: 10000,
  bonus_requested_cents_hour: 50000,
  ...extra,
});

test("report periods use complete Belgrade days, month boundaries, leap years and DST", () => {
  const r = reportOptions(
    new URLSearchParams({ preset: "last7" }),
    "2026-03-31",
  );
  assert.deepEqual(
    [r.from, r.to, r.previousFrom, r.previousTo],
    ["2026-03-24", "2026-03-30", "2026-03-17", "2026-03-23"],
  );
  const month = reportOptions(
    new URLSearchParams({ preset: "last_month" }),
    "2028-03-01",
  );
  assert.deepEqual(
    [month.from, month.to, month.previousFrom, month.previousTo],
    ["2028-02-01", "2028-02-29", "2028-01-01", "2028-01-31"],
  );
  const jan = reportOptions(
    new URLSearchParams({ preset: "last_month" }),
    "2026-01-10",
  );
  assert.equal(jan.from, "2025-12-01");
  assert.equal(belgradeToday(new Date("2026-09-22T22:30:00Z")), "2026-09-23");
  assert.equal(options({ to: "2026-09-22" }).compare, false);
  for (const patch of [
    { from: "2026-02-30" },
    { from: "2026-09-01", to: "2026-08-01" },
    { from: "2020-01-01" },
    { group: "__proto__" },
    { status: "unknown" },
    { requested: "unknown" },
  ])
    assert.throws(() => options(patch));
});
test("completed hours and earnings exclude cancelled, uncompleted and no-show prices", () => {
  const r = buildReport(
    [
      row("a", { duration: 90 }),
      row("b", {
        duration: 45,
        therapist_id: "t2",
        therapist_name: "Two",
        requested_therapist_id: "t2",
        requested_name: "Two",
        net_cents: 400000,
      }),
      row("c", { status: "cancelled", cancelled_at: "2026-08-01T10:00:00Z" }),
      row("d", { status: "no_show" }),
      row("e", { status: "confirmed" }),
    ],
    options(),
  );
  assert.deepEqual(
    [
      r.totals.appointments,
      r.totals.completed,
      r.totals.cancelled,
      r.totals.noShow,
      r.totals.pending,
    ],
    [5, 2, 1, 1, 1],
  );
  assert.equal(r.totals.totalMinutes, 135);
  assert.equal(r.totals.revenueCents, 870000);
  assert.equal(r.totals.averageRevenueCents, 435000);
  assert.equal(r.totals.regularBonusCents, 15000);
  assert.equal(r.totals.requestedBonusCents, 37500);
  assert.equal(r.totals.averageMinutesPerDay, 135);
  assert.equal(r.totals.dayCount, 1); // Salon distinct days, not sum of therapists' days.
  assert.equal(r.details.find((r) => r.id === "c").bonusCents, 0);
});
test("fulfilled requests use 500/h; a replacement uses regular; percentages use full price", () => {
  const r = buildReport(
    [
      row("a", {
        duration: 90,
        requested_therapist_id: "t1",
        requested_name: "One",
      }),
      row("b", { requested_therapist_id: "t2", requested_name: "Two" }),
      row("c", {
        gross_cents: 590000,
        net_cents: 300000,
        bonus_mode: "percent",
        regular_rate: 1000,
        requested_rate: 2000,
      }),
    ],
    options(),
  );
  assert.equal(r.details.find((r) => r.id === "a").bonusCents, 75000);
  assert.equal(r.details.find((r) => r.id === "b").bonusCents, 10000);
  assert.equal(r.details.find((r) => r.id === "b").requested, true);
  assert.equal(r.details.find((r) => r.id === "b").requestFulfilled, false);
  assert.equal(r.details.find((r) => r.id === "c").bonusCents, 59000);
  assert.equal(r.totals.requestedMinutes, 90);
  assert.equal(r.totals.regularMinutes, 120);
  assert.equal(
    buildReport(
      [
        row("zero", {
          gross_cents: 0,
          net_cents: 0,
          bonus_mode: "percent",
          regular_rate: 1000,
          requested_rate: 2000,
        }),
      ],
      options(),
    ).totals.totalBonusCents,
    0,
  );
});
test("fractional cents reconcile across detail, every grouping and CSV", () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    row(String(i).padStart(2, "0"), {
      duration: 5,
      date: i % 2 ? "2026-08-03" : "2026-08-02",
    }),
  );
  for (const group of Object.keys(GROUPS)) {
    const r = buildReport(items, options({ group }));
    assert.equal(r.totals.totalBonusCents, 10000);
    assert.equal(
      r.details.reduce((sum, d) => sum + d.bonusCents, 0),
      10000,
    );
    assert.equal(
      r.groups.reduce((sum, g) => sum + g.totalBonusCents, 0),
      10000,
    );
    const sorted = buildReport([...items].reverse(), options({ group }));
    assert.deepEqual(
      r.details.map((d) => d.bonusCents),
      sorted.details.map((d) => d.bonusCents),
    );
    assert.ok(reportCSV(r).includes('"100.00"'));
  }
});
test("filters and partial month denominators keep totals weighted correctly", () => {
  const items = [
    row("a"),
    row("b", {
      date: "2026-08-31",
      duration: 120,
      requested_therapist_id: "t1",
    }),
    row("c", { date: "2026-09-01", therapist_id: "t2", service_id: "s2" }),
  ];
  const r = buildReport(
    items,
    options({
      from: "2026-08-30",
      to: "2026-09-02",
      group: "month",
      dayBasis: "calendar",
    }),
  );
  assert.equal(r.totals.dayCount, 4);
  assert.equal(r.totals.averageMinutesPerDay, 45);
  assert.deepEqual(
    r.groups.map((g) => g.dayCount),
    [2, 2],
  );
  assert.equal(
    buildReport(items, options({ requested: "yes" })).totals.completed,
    1,
  );
  assert.equal(
    buildReport(items, options({ therapist: "t2" })).totals.completed,
    0,
  );
  assert.equal(
    buildReport(items, options({ service: "s2" })).totals.completed,
    0,
  );
  assert.equal(
    buildReport([], options(), [{ id: "t1", name: "One" }]).groups[0]
      .totalMinutes,
    0,
  );
});
test("incomplete records and duplicated IDs are rejected; CSV contains no client identity and escapes formula cells", () => {
  for (const patch of [
    { duration: null },
    { gross_cents: null },
    { requested_therapist_id: undefined },
    { bonus_regular_cents_hour: null },
    { status: "unknown" },
  ])
    assert.throws(
      () => buildReport([row("bad", patch)], options()),
      /incomplete|missing/,
    );
  assert.throws(
    () => buildReport([row("a"), row("a")], options()),
    /Duplicate/,
  );
  const report = buildReport(
    [
      row("a", {
        service_name: '=HYPERLINK("bad")',
        client_name: "SECRET CLIENT",
        note: "PRIVATE NOTE",
      }),
    ],
    options(),
  );
  const csv = reportCSV(report, "details");
  assert.match(csv, /'\=HYPERLINK/);
  assert.doesNotMatch(csv, /SECRET CLIENT|PRIVATE NOTE/);
  assert.match(csv, /2026-07-01 12:00:00/);
  assert.doesNotMatch(reportCSV(report, "details", false), /bonus/i);
  const delta = comparison(
    { revenueCents: 100, completed: 0, totalMinutes: 0, totalBonusCents: 0 },
    { revenueCents: 0, completed: 0, totalMinutes: 0, totalBonusCents: 0 },
  );
  assert.equal(delta.revenueCents.percent, null);
  assert.equal(delta.completed.percent, 0);
  assert.throws(() =>
    bonusInput({ mode: "percent", regularRate: 10001, requestedRate: 0 }),
  );
});
test("automatic additive schema matches migration and is safe to apply repeatedly", async () => {
  const migration = await readFile(
    new URL("../migrations/0002_report_bonuses.sql", import.meta.url),
    "utf8",
  );
  const normalized = (s) => s.replace(/\s/g, "").replaceAll(";", "");
  assert.equal(normalized(migration), normalized(REPORT_SCHEMA.join(";")));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      await readFile(
        new URL("../migrations/0001_core.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(REPORT_SCHEMA.join(";"));
    db.exec(migration);
    db.exec(migration);
    assert.equal(db.prepare("SELECT count(*) AS n FROM rooms").get().n, 3);
  } finally {
    db.close();
  }
});
