import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  HISTORY_LIMITS,
  normalizeHistoryRows,
} from "../src/history-normalize.mjs";

// Every value is synthetic. Only the verified public column/format vocabulary
// is reproduced; no historical client records belong in tests.
const headers = [
  "Appt. ref.",
  "Client",
  "Team member",
  "Status",
  "Created date",
  "Scheduled date",
  "Cancelled date",
  "Category",
  "Service",
  "Duration (mins)",
  "Appt. slot",
  "Created by",
  "Cancelled by",
  "Location",
  "Net sales",
  "Cancellation reason",
  "Fees charged",
  "Upfront payments",
];
const mapping = {
  appointmentRef: 0,
  clientName: 1,
  therapistName: 2,
  status: 3,
  createdAt: 4,
  scheduledDate: 5,
  cancelledAt: 6,
  serviceName: 8,
  duration: 9,
  slot: 10,
  netSales: 14,
};
const source = "synthetic-salon:fresha",
  fileDigest = "a".repeat(64);
const format = {
  dateTimeFormat: "fresha-en",
  slotFormat: "HH:mm:ss-HH:mm:ss",
  durationFormat: "hours-minutes",
};
const values = () => [
  "000042",
  "Fictional Client",
  "Fictional Therapist",
  "Started",
  "03 Jan 2026, 5:43pm",
  "04 Jan 2026, 9:00pm",
  "",
  "Synthetic category",
  "Synthetic massage",
  "1h 0min",
  "21:00:00-22:00:00",
  "",
  "",
  "Synthetic location",
  "4700",
  "",
  "0",
  "0",
];
const input = (overrides = {}) => ({
  headers,
  mapping,
  source,
  fileDigest,
  rows: [values()],
  format,
  ...overrides,
});
const row = (changes = {}) => {
  const data = values();
  for (const [field, value] of Object.entries(changes))
    data[mapping[field]] = value;
  return data;
};
const normalized = (changes = {}, opts = {}) =>
  normalizeHistoryRows(
    input({ rows: [row(changes)], format: { ...format, ...opts } }),
  ).rows[0];
const codes = (row) => row.issues.map((issue) => issue.code);
const verified = {
  sourceTimeZone: "Europe/Belgrade",
  money: { currency: "RSD", minorUnitDigits: 2 },
  completionMap: { Started: "completed" },
};

test("verified Fresha-shaped synthetic row retains labels, leading zeros, raw fields and unknowns without side effects", () => {
  const original = input(),
    snapshot = structuredClone(original);
  const result = normalizeHistoryRows(original),
    item = result.rows[0];
  assert.deepEqual(original, snapshot);
  assert.equal(item.row, 2);
  assert.equal(item.sourceAppointmentRef, "000042");
  assert.equal(item.raw.appointmentRef, "000042");
  assert.equal(item.sourceClientLabel, "Fictional Client");
  assert.equal(item.sourceTherapistLabel, "Fictional Therapist");
  assert.equal(item.sourceServiceLabel, "Synthetic massage");
  assert.equal(
    item.sourceRoomLabel,
    null,
    "Location is not invented as a room",
  );
  assert.equal(item.scheduledLocalDate, "2026-01-04");
  assert.equal(item.startMinute, 1260);
  assert.equal(item.durationMinutes, 60);
  assert.deepEqual(item.sourceCreatedAt, {
    raw: "03 Jan 2026, 5:43pm",
    localDate: "2026-01-03",
    timeMinute: 1063,
    instant: null,
    timeZone: null,
  });
  for (const field of [
    "scheduledAt",
    "sourceTimeZone",
    "sourceClientId",
    "sourceCancelledAt",
    "sourceNetSalesMinor",
    "currency",
    "fullPriceMinor",
    "paidAmountMinor",
    "bonusRule",
    "bonusAmountMinor",
  ])
    assert.equal(item[field], null, field);
  assert.equal(item.completionState, "unknown");
  assert.equal(item.requestState, "unknown");
  for (const code of [
    "timezone_unconfirmed",
    "currency_unconfirmed",
    "completion_unknown",
    "request_unknown",
  ])
    assert.ok(codes(item).includes(code), code);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.needsReview, 1);
  assert.equal(
    result.summary.valid + result.summary.invalid + result.summary.needsReview,
    result.summary.total,
  );
});

test("timestamps parse midnight, noon, padded/unpadded days and off-grid historical minute values", () => {
  for (const [text, slot, minute] of [
    ["4 Jan 2026, 12:00am", "00:00:00-01:00:00", 0],
    ["04 Jan 2026, 12:00pm", "12:00:00-13:00:00", 720],
    ["04 Jan 2026, 5:43pm", "17:43:00-18:43:00", 1063],
  ]) {
    const item = normalized(
      { scheduledDate: text, slot, createdAt: "" },
      verified,
    );
    assert.equal(item.startMinute, minute);
    assert.equal(
      item.issues.some((issue) => issue.severity === "error"),
      false,
    );
  }
  const midnight = normalized(
    { scheduledDate: "04 Jan 2026, 11:30pm", slot: "23:30:00-00:30:00" },
    verified,
  );
  assert.equal(midnight.startMinute, 1410);
  assert.equal(midnight.durationMinutes, 60);
  assert.ok(codes(midnight).includes("cross_day_unsupported"));
  assert.ok(codes(midnight).includes("slot_cross_day_unsupported"));
  const endOfDay = normalized(
    { scheduledDate: "04 Jan 2026, 11:00pm", slot: "23:00:00-24:00:00" },
    verified,
  );
  assert.ok(!codes(endOfDay).includes("cross_day_unsupported"));
  assert.ok(!codes(endOfDay).includes("slot_duration_mismatch"));
});

test("invalid calendars, malformed time, nonzero slot seconds and contradictions keep raw evidence", () => {
  for (const scheduledDate of [
    "31 Feb 2026, 9:00pm",
    "29 Feb 2025, 9:00pm",
    "04 Jan 2026, 0:00pm",
    "04 Jan 2026, 13:00pm",
    "04 Jan 2026, 9:60pm",
    "04 Jan 2026, 9:00pm trailing",
  ])
    assert.ok(
      codes(normalized({ scheduledDate })).includes("invalid_datetime"),
    );
  assert.ok(
    codes(normalized({ scheduledDate: "29 Feb 2024, 9:00pm" })).every(
      (code) => code !== "invalid_datetime",
    ),
  );
  const invalid = normalized({
    slot: "21:00:01-22:00:00",
    createdAt: "unparseable original",
    cancelledAt: "also invalid",
  });
  assert.ok(codes(invalid).includes("invalid_slot"));
  assert.equal(invalid.raw.createdAt, "unparseable original");
  assert.equal(invalid.sourceCreatedAt.raw, "unparseable original");
  assert.equal(invalid.sourceCreatedAt.localDate, null);
  const differentStart = normalized({ slot: "20:00:00-21:00:00" });
  assert.ok(codes(differentStart).includes("scheduled_slot_mismatch"));
  assert.equal(differentStart.startMinute, null);
  assert.equal(differentStart.scheduledAt, null);
  assert.ok(
    codes(normalized({ duration: "1h 30min" })).includes(
      "slot_duration_mismatch",
    ),
  );
});

test("small explicit ISO and ordinal presets never use machine date parsing or guessed day/month order", () => {
  const base = { createdAt: "", slot: "09:10-10:10" };
  for (const [dateTimeFormat, value, date] of [
    ["iso-local", "2026-02-03T09:10", "2026-02-03"],
    ["iso-date", "2026-02-03", "2026-02-03"],
    ["dmy-date", "03/02/2026", "2026-02-03"],
    ["mdy-date", "03/02/2026", "2026-03-02"],
  ]) {
    const item = normalized(
      { ...base, scheduledDate: value },
      { dateTimeFormat, slotFormat: "HH:mm-HH:mm", sourceTimeZone: "UTC" },
    );
    assert.equal(item.scheduledLocalDate, date);
    assert.equal(item.startMinute, 550);
    assert.equal(item.scheduledAt, date + "T09:10:00.000Z");
  }
  const dateOnly = normalized(
    { ...base, scheduledDate: "2026-02-03", createdAt: "2026-01-01" },
    {
      dateTimeFormat: "iso-date",
      slotFormat: "HH:mm-HH:mm",
      sourceTimeZone: "UTC",
    },
  );
  assert.equal(dateOnly.sourceCreatedAt.instant, null);
  assert.ok(codes(dateOnly).includes("timestamp_time_missing"));
});

test("textual and numeric durations preserve historical minutes without current menu or five-minute assumptions", () => {
  for (const [duration, expected] of [
    ["1h 0min", 60],
    ["1h 30min", 90],
    ["30min", 30],
    ["45min", 45],
    ["2h 0min", 120],
    ["47min", 47],
    ["25h 0min", 1500],
  ]) {
    const item = normalized(
      { duration, slot: "21:00" },
      { slotFormat: "HH:mm" },
    );
    assert.equal(item.durationMinutes, expected);
  }
  assert.equal(
    normalized(
      { duration: "47", slot: "21:00" },
      { durationFormat: "minutes", slotFormat: "HH:mm" },
    ).durationMinutes,
    47,
  );
  for (const duration of [
    "0min",
    "-30min",
    "1.5h",
    "1h 60min",
    "60",
    "",
    "90min junk",
    "99999999999999999h",
  ])
    assert.equal(normalized({ duration }).durationMinutes, null);
});

test("money is parsed exactly with explicit separators, sign and precision; unknown currency stays unavailable", () => {
  for (const [amount, money, expected] of [
    ["4700", { currency: "RSD", minorUnitDigits: 2 }, 470000],
    ["0", { currency: "RSD", minorUnitDigits: 2 }, 0],
    ["1.01", { currency: "RSD", minorUnitDigits: 2 }, 101],
    ["-1.01", { currency: "RSD", minorUnitDigits: 2 }, -101],
    [
      "4,700.50",
      {
        currency: "RSD",
        minorUnitDigits: 2,
        decimalSeparator: ".",
        groupSeparator: ",",
      },
      470050,
    ],
    [
      "4.700,50",
      {
        currency: "RSD",
        minorUnitDigits: 2,
        decimalSeparator: ",",
        groupSeparator: ".",
      },
      470050,
    ],
    [
      "4 700,50",
      {
        currency: "RSD",
        minorUnitDigits: 2,
        decimalSeparator: ",",
        groupSeparator: " ",
      },
      470050,
    ],
    ["123", { currency: "JPY", minorUnitDigits: 0 }, 123],
  ])
    assert.equal(
      normalized({ netSales: amount }, { money }).sourceNetSalesMinor,
      expected,
    );
  for (const amount of [
    "1.005",
    "1e3",
    "NaN",
    "Infinity",
    "1,000",
    "RSD 100",
    "1.2.3",
    "90071992547409.92",
  ])
    assert.equal(
      normalized(
        { netSales: amount },
        { money: { currency: "RSD", minorUnitDigits: 2 } },
      ).sourceNetSalesMinor,
      null,
      amount,
    );
  const badGroup = normalized(
    { netSales: "47,00.50" },
    { money: { currency: "RSD", minorUnitDigits: 2, groupSeparator: "," } },
  );
  assert.ok(codes(badGroup).includes("invalid_money"));
  assert.equal(normalized({ netSales: "4700" }).sourceNetSalesMinor, null);
  assert.equal(
    normalized({ netSales: "bad source amount" }).issues.some((issue) =>
      issue.message.includes("bad source amount"),
    ),
    false,
  );
});

test("confirmed timezone resolves winter/summer instants but leaves DST gaps and folds unresolved", () => {
  const winter = normalized({}, { sourceTimeZone: "Europe/Belgrade" });
  assert.equal(winter.scheduledAt, "2026-01-04T20:00:00.000Z");
  const summer = normalized(
    { scheduledDate: "04 Jul 2026, 9:00pm" },
    { sourceTimeZone: "Europe/Belgrade" },
  );
  assert.equal(summer.scheduledAt, "2026-07-04T19:00:00.000Z");
  for (const [scheduledDate, code] of [
    ["25 Oct 2026, 2:30am", "time_ambiguous"],
    ["29 Mar 2026, 2:30am", "time_nonexistent"],
  ]) {
    const item = normalized(
      { scheduledDate, slot: "02:30:00-03:30:00" },
      { sourceTimeZone: "Europe/Belgrade" },
    );
    assert.equal(item.scheduledAt, null);
    assert.ok(codes(item).includes(code));
    assert.equal(
      item.issues.some((issue) => issue.severity === "error"),
      false,
    );
  }
  assert.equal(normalized().scheduledAt, null);
  assert.ok(codes(normalized()).includes("timezone_unconfirmed"));
});

test("completion and requests require evidence; cancellation contradictions are flagged and money never becomes earnings or bonuses", () => {
  for (const status of [
    "New",
    "Confirmed",
    "Started",
    "Completed",
    "Unrecognized",
  ])
    assert.equal(normalized({ status }).completionState, "unknown");
  for (const status of ["Cancelled", "No Show"]) {
    const item = normalized({ status }, verified);
    assert.equal(item.completionState, "not_completed");
    assert.equal(item.sourceNetSalesMinor, 470000);
    assert.equal(item.bonusAmountMinor, null);
    assert.equal(item.paidAmountMinor, null);
  }
  assert.equal(normalized({}, verified).completionState, "completed");
  assert.ok(
    codes(
      normalized({ cancelledAt: "04 Jan 2026, 8:00pm" }, verified),
    ).includes("cancellation_status_mismatch"),
  );
  assert.ok(
    codes(
      normalized(
        { status: "Cancelled", cancelledAt: "02 Jan 2026, 8:00pm" },
        { ...verified, completionMap: { Cancelled: "completed" } },
      ),
    ).includes("completion_conflict"),
  );
  assert.ok(
    codes(
      normalized({ status: "Cancelled", cancelledAt: "02 Jan 2026, 8:00pm" }),
    ).includes("cancelled_before_created"),
  );
  const requestHeaders = [...headers, "Requested"],
    requestMapping = { ...mapping, requested: 18 };
  for (const [value, expected] of [
    ["Yes", "yes"],
    ["No", "no"],
    ["yes", "unknown"],
    ["", "unknown"],
  ]) {
    const item = normalizeHistoryRows(
      input({
        headers: requestHeaders,
        mapping: requestMapping,
        rows: [[...values(), value]],
        format: { ...format, requestMap: { Yes: "yes", No: "no" } },
      }),
    ).rows[0];
    assert.equal(item.requestState, expected);
  }
});

test("row numbering and summary states reconcile across mixed valid, invalid and unresolved input", () => {
  const result = normalizeHistoryRows(
    input({
      rows: [values(), row({ duration: "bad" }), row({ status: "Unknown" })],
      format: { ...format, ...verified },
    }),
  );
  assert.deepEqual(
    result.rows.map((item) => item.row),
    [2, 3, 4],
  );
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.summary.needsReview, 0);
  assert.equal(result.summary.valid, 2);
  assert.equal(
    result.summary.valid + result.summary.invalid + result.summary.needsReview,
    3,
  );
  const requestHeaders = [...headers, "Requested"];
  const ready = normalizeHistoryRows(
    input({
      headers: requestHeaders,
      mapping: { ...mapping, requested: 18 },
      rows: [[...values(), "No"]],
      format: { ...format, ...verified, requestMap: { No: "no" } },
    }),
  );
  assert.equal(
    ready.summary.valid,
    1,
    "normalizer-valid is not an identity/import approval",
  );
});

test("explicit mapping preserves leading-zero external IDs and raw contact evidence without interpreting source location", () => {
  const custom = normalizeHistoryRows({
    headers: [
      "Date",
      "Duration",
      "ID",
      "Line",
      "Phone",
      "Email",
      "Social",
      "Room",
    ],
    rows: [
      [
        "2026-01-04T21:00",
        "47",
        " 000007 ",
        "0002",
        " +381 60 000 0000 ",
        " SYNTHETIC@example.invalid ",
        " @synthetic_profile ",
        "Original room label",
      ],
    ],
    mapping: {
      scheduledDate: 0,
      duration: 1,
      clientSourceId: 2,
      serviceLineRef: 3,
      phone: 4,
      email: 5,
      instagram: 6,
      roomName: 7,
    },
    source,
    fileDigest,
    format: { dateTimeFormat: "iso-local", durationFormat: "minutes" },
  });
  const item = custom.rows[0];
  assert.equal(item.sourceClientId, "000007");
  assert.equal(item.raw.clientSourceId, " 000007 ");
  assert.equal(item.sourceServiceLineRef, "0002");
  assert.equal(item.phone, "+381 60 000 0000");
  assert.equal(item.email, "SYNTHETIC@example.invalid");
  assert.equal(item.instagram, "@synthetic_profile");
  assert.equal(item.sourceRoomLabel, "Original room label");
});

test("Fresha No resource stays raw evidence while absent room remains unknown", () => {
  const input = {
    headers: [...headers, "Resource"],
    rows: [
      [...values(), "No resource"],
      [...values(), "Fictional room"],
    ],
    mapping: { ...mapping, roomName: headers.length },
    source,
    fileDigest,
    format,
  };
  const result = normalizeHistoryRows(input).rows;
  assert.equal(result[0].sourceRoomLabel, null);
  assert.equal(result[0].raw.roomName, "No resource");
  assert.equal(result[1].sourceRoomLabel, "Fictional room");
  assert.equal(
    normalizeHistoryRows({ ...input, headers: [...headers, "Room"] }).rows[0]
      .sourceRoomLabel,
    "No resource",
  );
});

test("shape, mapping, timezone and bounded cells reject safely without repeating private source text", () => {
  for (const overrides of [
    { rows: [["PRIVATE"]] },
    { rows: [[...values().slice(0, -1), 12]] },
    { mapping: { ...mapping, typo: 0 } },
    { mapping: { ...mapping, slot: 0 } },
    { mapping: { ...mapping, slot: 99 } },
    { fileDigest: "invalid" },
    { source: "" },
    { format: { ...format, sourceTimeZone: "Invalid/Secret" } },
    { format: { ...format, dateTimeFormat: "auto" } },
    {
      format: {
        ...format,
        money: { currency: "RSD", minorUnitDigits: 2, groupSeparator: "." },
      },
    },
    { rows: [row({ clientName: "X".repeat(HISTORY_LIMITS.cellBytes + 1) })] },
    { rows: [row({ clientName: "😃".repeat(HISTORY_LIMITS.cellBytes / 2) })] },
    { rows: Array(HISTORY_LIMITS.rows + 1).fill(values()) },
    { headers: Array(129).fill("Column"), rows: [] },
  ])
    assert.throws(
      () => normalizeHistoryRows(input(overrides)),
      (error) =>
        !error.message.includes("PRIVATE") && !error.message.includes("Secret"),
    );
  assert.throws(
    () =>
      normalizeHistoryRows(
        input({
          rows: Array(1700).fill(row({ clientName: "X".repeat(16384) })),
        }),
      ),
    /total size/,
  );
});

test("50,000 synthetic rows normalize within published bounds using cached timezone resolutions", (t) => {
  const start = performance.now();
  const result = normalizeHistoryRows(
    input({
      rows: Array.from({ length: HISTORY_LIMITS.rows }, (_, index) => {
        const entry = values();
        entry[0] = String(index).padStart(6, "0");
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        entry[5] = `${(index % 28) + 1} ${months[Math.floor((index % 336) / 28)]} 2026, 9:00pm`;
        return entry;
      }),
      format: { ...format, ...verified },
    }),
  );
  assert.equal(result.rows.length, 50000);
  assert.equal(result.rows.at(-1).row, 50001);
  assert.equal(result.rows.at(-1).scheduledAt, "2026-10-20T19:00:00.000Z");
  assert.equal(
    new Set(result.rows.map((item) => item.scheduledLocalDate)).size,
    336,
  );
  assert.equal(result.summary.invalid, 0);
  t.diagnostic(
    `50,000 synthetic rows across 336 dates normalized in ${Math.round(performance.now() - start)}ms; no timing threshold depends on host speed.`,
  );
});

test("interpretation and status/request basis preserve supplied mapping decisions without implying approval", () => {
  const explicit = normalized({}, verified);
  assert.deepEqual(explicit.completionBasis, {
    method: "explicit_mapping",
    sourceValue: "Started",
    mappedValue: "completed",
  });
  assert.deepEqual(explicit.requestBasis, {
    method: "unresolved",
    sourceValue: null,
    mappedValue: "unknown",
  });
  assert.equal(explicit.interpretation.version, 1);
  assert.equal(explicit.interpretation.dateTimeFormat, "fresha-en");
  assert.deepEqual(explicit.interpretation.money, {
    currency: "RSD",
    minorUnitDigits: 2,
    decimalSeparator: ".",
    groupSeparator: null,
  });
  assert.equal(
    normalized({ status: "Cancelled" }).completionBasis.method,
    "source_status",
  );
  assert.equal(normalized().completionBasis.method, "unresolved");
  assert.equal(Object.hasOwn(explicit, "approved"), false);
});

test("durations that alias the same slot end after one or more days are preserved but explicitly unsupported", () => {
  for (const duration of ["25h 0min", "49h 0min"]) {
    const item = normalized({ duration });
    assert.ok(item.durationMinutes > 1440);
    assert.equal(item.raw.duration, duration);
    assert.ok(codes(item).includes("cross_day_unsupported"));
    assert.ok(codes(item).includes("slot_duration_mismatch"));
    assert.ok(item.issues.some((entry) => entry.severity === "error"));
  }
  const oneDay = normalized({
    scheduledDate: "04 Jan 2026, 12:00am",
    slot: "00:00:00-00:00:00",
    duration: "24h 0min",
  });
  assert.ok(codes(oneDay).includes("slot_cross_day_unsupported"));
});

test("missing optional metrics are informational and do not reject an otherwise validated historical row", () => {
  const item = normalized(
    { netSales: "", status: "Started" },
    { sourceTimeZone: "Europe/Belgrade" },
  );
  for (const code of [
    "completion_unknown",
    "request_unknown",
    "net_sales_missing",
  ])
    assert.equal(
      item.issues.find((issue) => issue.code === code).severity,
      "info",
    );
  assert.ok(item.issues.every((issue) => issue.severity === "info"));
  const unknownCurrency = normalized({}, { sourceTimeZone: "Europe/Belgrade" });
  assert.equal(
    unknownCurrency.issues.find(
      (issue) => issue.code === "currency_unconfirmed",
    ).severity,
    "info",
  );
  assert.equal(item.completionState, "unknown");
  assert.equal(item.sourceNetSalesMinor, null);
  assert.equal(item.requestState, "unknown");
});
