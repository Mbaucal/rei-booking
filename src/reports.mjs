import { fail } from "./security.mjs";
import { isoDate, integer } from "./domain.mjs";

export const GROUPS = {
  therapist: ["therapist"],
  month: ["month"],
  day: ["day"],
  treatment: ["treatment"],
  therapist_month: ["therapist", "month"],
  therapist_day: ["therapist", "day"],
  therapist_treatment: ["therapist", "treatment"],
  therapist_month_treatment: ["therapist", "month", "treatment"],
  therapist_day_treatment: ["therapist", "day", "treatment"],
};
export const shiftDate = (date, days) =>
  new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
const days = (from, to) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
export const belgradeToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const monthStart = (date) => date.slice(0, 7) + "-01";

export function reportOptions(params, today = belgradeToday()) {
  const preset = params.get("preset") || "last_month";
  let from, to, previousFrom, previousTo;
  if (preset === "last7" || preset === "last30") {
    to = shiftDate(today, -1);
    from = shiftDate(today, preset === "last7" ? -7 : -30);
  } else if (preset === "last_month") {
    to = shiftDate(monthStart(today), -1);
    from = monthStart(to);
    previousTo = shiftDate(from, -1);
    previousFrom = monthStart(previousTo);
  } else if (preset === "custom") {
    from = isoDate(params.get("from"));
    to = isoDate(params.get("to"));
  } else fail(400, "Choose a report period.");
  if (from > to || days(from, to) > 366)
    fail(400, "Choose a period of 1–366 days.");
  previousTo ||= shiftDate(from, -1);
  previousFrom ||= shiftDate(from, -days(from, to));
  const group = params.get("group") || "therapist";
  const status = params.get("status") || "all";
  const requested = params.get("requested") || "all";
  const dayBasis = params.get("dayBasis") || "active";
  const source = params.get("source") || "all";
  if (
    !Object.hasOwn(GROUPS, group) ||
    !["all", "booked", "confirmed", "done", "cancelled", "no_show"].includes(
      status,
    ) ||
    !["all", "yes", "no"].includes(requested) ||
    !["active", "calendar"].includes(dayBasis) ||
    !["all", "native", "history"].includes(source)
  )
    fail(400, "Choose valid report filters.");
  for (const key of ["therapist", "service"])
    if ((params.get(key) || "").length > 100)
      fail(400, "Invalid report filter.");
  return {
    preset,
    from,
    to,
    previousFrom,
    previousTo,
    group,
    status,
    requested,
    dayBasis,
    source,
    therapist: params.get("therapist") || "",
    service: params.get("service") || "",
    compare: to < today,
    timeZone: "Europe/Belgrade",
  };
}
export function bonusInput(input) {
  if (!input || !["hourly", "percent"].includes(input.mode))
    fail(400, "Choose a bonus mode.");
  const max = input.mode === "hourly" ? 100000000 : 10000;
  return {
    mode: input.mode,
    regular_rate: integer(input.regularRate, 0, max, "regular bonus rate"),
    requested_rate: integer(
      input.requestedRate,
      0,
      max,
      "requested bonus rate",
    ),
  };
}

function historicalDetail(row) {
  if (
    ![
      "id",
      "therapist_id",
      "therapist_name",
      "service_id",
      "service_name",
      "date",
      "visit_key",
    ].every((key) => typeof row[key] === "string" && row[key]) ||
    !Number.isSafeInteger(row.duration) ||
    row.duration <= 0 ||
    !Number.isSafeInteger(row.start_minute) ||
    row.start_minute < 0 ||
    row.start_minute + row.duration > 1440
  )
    fail(422, "Some imported history has incomplete report data.");
  return {
    id: row.id,
    rowSource: "history",
    source: row.source,
    visitKey: row.visit_key,
    therapistId: row.therapist_id,
    therapist: row.therapist_name,
    date: row.date,
    start: row.start_minute,
    duration: row.duration,
    serviceId: row.service_id,
    treatment: row.service_name,
    room: row.room_name || null,
    grossCents: null,
    netCents: null,
    createdAt: null,
    cancelledAt: null,
    sourceCreatedAt: row.source_created_at || null,
    sourceCancelledAt: row.source_cancelled_at || null,
    status: row.status,
    sourceStatus: row.source_status,
    completionState: row.completion_state,
    countsAsVisit: row.counts_as_visit,
    nativeOverlap: !!row.native_overlap,
    included: row.counts_as_visit === true && !row.native_overlap,
    requested:
      row.request_state === "yes"
        ? true
        : row.request_state === "no"
          ? false
          : null,
    requestedTherapist: null,
    requestFulfilled: null,
    bonusMode: null,
    bonusRate: null,
    bonusCents: null,
    sourceNetSalesMinor: row.source_net_sales_minor ?? null,
    currency: row.currency ?? null,
    minorUnitDigits: row.minor_unit_digits ?? null,
    moneyBasis: row.money_basis || "unknown",
    moneyIssue: row.money_issue || null,
    sourceTimeZone: row.source_time_zone || null,
  };
}
function detail(row) {
  if (row.report_source === "history") return historicalDetail(row);
  const required = [
    "id",
    "therapist_id",
    "therapist_name",
    "service_id",
    "service_name",
    "date",
    "created_at",
  ];
  if (
    required.some((k) => typeof row[k] !== "string" || !row[k]) ||
    !Number.isSafeInteger(row.duration) ||
    row.duration <= 0 ||
    !Number.isSafeInteger(row.gross_cents) ||
    row.gross_cents < 0 ||
    !Number.isSafeInteger(row.net_cents) ||
    row.net_cents < 0 ||
    row.net_cents > row.gross_cents ||
    row.requested_therapist_id === undefined ||
    !["booked", "confirmed", "done", "cancelled", "no_show"].includes(
      row.status,
    )
  )
    fail(
      422,
      "Some appointments have incomplete report data. Correct the records before exporting.",
    );
  const fulfilled =
    !!row.requested_therapist_id &&
    row.requested_therapist_id === row.therapist_id;
  const mode = row.bonus_mode ?? "hourly";
  // Existing v0.1 appointments already contain their historical hourly rates.
  const regular =
    row.bonus_mode == null ? row.bonus_regular_cents_hour : row.regular_rate;
  const requested =
    row.bonus_mode == null
      ? row.bonus_requested_cents_hour
      : row.requested_rate;
  const rate = fulfilled ? requested : regular;
  if (
    !["hourly", "percent"].includes(mode) ||
    !Number.isSafeInteger(rate) ||
    rate < 0 ||
    rate > (mode === "hourly" ? 100000000 : 10000)
  )
    fail(
      422,
      "Some appointments have missing bonus rates. Correct the records before exporting.",
    );
  return {
    id: row.id,
    rowSource: "native",
    included: row.status === "done",
    therapistId: row.therapist_id,
    therapist: row.therapist_name,
    date: row.date,
    start: row.start_minute,
    duration: row.duration,
    serviceId: row.service_id,
    treatment: row.service_name,
    grossCents: row.gross_cents,
    netCents: row.net_cents,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    status: row.status,
    requested: !!row.requested_therapist_id,
    requestedTherapist: row.requested_name || "",
    requestFulfilled: fulfilled,
    bonusMode: mode,
    bonusRate: rate,
    bonusCents: 0,
  };
}
function allocateBonuses(records) {
  const buckets = new Map();
  for (const r of records) {
    if (r.rowSource === "history" || r.status !== "done") continue;
    const key = JSON.stringify([r.therapistId, r.requestFulfilled]);
    if (!buckets.has(key)) buckets.set(key, []);
    const n =
      r.bonusMode === "hourly"
        ? BigInt(r.duration) * BigInt(r.bonusRate) * 500n
        : BigInt(r.grossCents) * BigInt(r.bonusRate) * 3n;
    buckets.get(key).push({ r, n });
  }
  for (const bucket of buckets.values()) {
    let total = 0n,
      used = 0n;
    for (const { r, n } of bucket) {
      r.bonusCents = Number(n / 30000n);
      total += n;
      used += n / 30000n;
    }
    const extra = Number((total + 15000n) / 30000n - used);
    bucket.sort(
      (a, b) =>
        Number((b.n % 30000n) - (a.n % 30000n)) || a.r.id.localeCompare(b.r.id),
    );
    for (let i = 0; i < extra; i++) bucket[i].r.bonusCents++;
  }
}
function aggregate(records, options, parts = {}) {
  let from = options.from,
    to = options.to;
  if (parts.day) from = to = parts.day;
  else if (parts.month) {
    const first = parts.month + "-01";
    const next = new Date(first + "T12:00:00Z");
    next.setUTCMonth(next.getUTCMonth() + 1);
    const last = shiftDate(next.toISOString().slice(0, 10), -1);
    from = first > from ? first : from;
    to = last < to ? last : to;
  }
  const out = {
    appointments: records.length,
    completed: 0,
    cancelled: 0,
    noShow: 0,
    pending: 0,
    requestedCount: 0,
    totalMinutes: 0,
    regularMinutes: 0,
    requestedMinutes: 0,
    revenueCents: 0,
    regularBonusCents: 0,
    requestedBonusCents: 0,
    includedTreatments: 0,
    historicalRows: 0,
    historicalTreatments: 0,
    historicalVisits: 0,
    historicalMinutes: 0,
    nativeMinutes: 0,
    unknownRequested: 0,
    unknownCompletion: 0,
    unknownStatus: 0,
    unavailableMoneyRows: 0,
    unavailableFullPriceRows: 0,
    unavailableBonusRows: 0,
    nativeOverlapRows: 0,
    sourceNetSales: [],
  };
  const dates = new Set(),
    visits = new Set(),
    amounts = new Map();
  for (const r of records) {
    if (r.rowSource === "history") {
      out.historicalRows++;
      if (r.requested === true) out.requestedCount++;
      if (r.requested === null) out.unknownRequested++;
      if (r.completionState === "unknown") out.unknownCompletion++;
      if (r.countsAsVisit == null) out.unknownStatus++;
      if (r.status === "cancelled") out.cancelled++;
      if (r.status === "no_show") out.noShow++;
      if (r.nativeOverlap) out.nativeOverlapRows++;
      if (!r.included) continue;
      out.includedTreatments++;
      out.historicalTreatments++;
      out.historicalMinutes += r.duration;
      out.totalMinutes += r.duration;
      out.unavailableFullPriceRows++;
      out.unavailableBonusRows++;
      dates.add(r.date);
      visits.add(r.visitKey);
      if (
        r.sourceNetSalesMinor == null ||
        !r.currency ||
        r.minorUnitDigits == null
      )
        out.unavailableMoneyRows++;
      else {
        const key = JSON.stringify([r.currency, r.minorUnitDigits]);
        if (!amounts.has(key))
          amounts.set(key, {
            currency: r.currency,
            minorUnitDigits: r.minorUnitDigits,
            amountMinor: 0,
            rows: 0,
          });
        const bucket = amounts.get(key);
        bucket.amountMinor += r.sourceNetSalesMinor;
        bucket.rows++;
        if (!Number.isSafeInteger(bucket.amountMinor))
          fail(422, "Historical source amounts exceed the report limit.");
      }
      continue;
    }
    if (r.requested) out.requestedCount++;
    if (r.status === "cancelled") out.cancelled++;
    else if (r.status === "no_show") out.noShow++;
    else if (r.status !== "done") out.pending++;
    if (r.status !== "done") continue;
    out.completed++;
    out.includedTreatments++;
    out.nativeMinutes += r.duration;
    dates.add(r.date);
    out.totalMinutes += r.duration;
    out.revenueCents += r.netCents;
    const prefix = r.requestFulfilled ? "requested" : "regular";
    out[prefix + "Minutes"] += r.duration;
    out[prefix + "BonusCents"] += r.bonusCents;
  }
  out.historicalVisits = visits.size;
  out.sourceNetSales = [...amounts.values()].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      a.minorUnitDigits - b.minorUnitDigits,
  );
  out.dayCount = options.dayBasis === "calendar" ? days(from, to) : dates.size;
  out.averageMinutesPerDay = out.dayCount ? out.totalMinutes / out.dayCount : 0;
  out.averageRevenueCents = out.completed
    ? out.revenueCents / out.completed
    : 0;
  out.totalBonusCents = out.regularBonusCents + out.requestedBonusCents;
  return { ...out, from, to };
}
export function reportRowMatches(r, options) {
  return (
    (!options.source ||
      options.source === "all" ||
      (r.report_source === "history" ? "history" : "native") ===
        options.source) &&
    r.date >= options.from &&
    r.date <= options.to &&
    (!options.therapist || r.therapist_id === options.therapist) &&
    (!options.service || r.service_id === options.service) &&
    (options.status === "all" || r.status === options.status) &&
    (options.requested === "all" ||
      (r.report_source === "history"
        ? r.request_state === options.requested
        : !!r.requested_therapist_id === (options.requested === "yes")))
  );
}
export function buildReport(rows, options, therapists = []) {
  const seen = new Set();
  const records = rows
    .filter((r) => {
      if (seen.has(r.id)) fail(422, "Duplicate appointments in report data.");
      seen.add(r.id);
      return reportRowMatches(r, options);
    })
    .map(detail)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start - b.start ||
        a.id.localeCompare(b.id),
    );
  allocateBonuses(records);
  const groups = new Map();
  for (const r of records) {
    const dimensions = {
      therapist: r.therapistId,
      treatment: r.serviceId,
      month: r.date.slice(0, 7),
      day: r.date,
    };
    const parts = Object.fromEntries(
      GROUPS[options.group].map((k) => [k, dimensions[k]]),
    );
    const key = JSON.stringify(parts);
    if (!groups.has(key))
      groups.set(key, {
        key,
        parts,
        label: GROUPS[options.group]
          .map((k) =>
            k === "therapist"
              ? r.therapist
              : k === "treatment"
                ? r.treatment
                : dimensions[k],
          )
          .join(" · "),
        records: [],
      });
    groups.get(key).records.push(r);
  }
  if (options.group === "therapist" && options.source !== "history")
    for (const t of therapists.filter(
      (t) =>
        (!options.therapist || t.id === options.therapist) &&
        (options.source !== "native" || !t.id.startsWith("history:")),
    )) {
      const parts = { therapist: t.id },
        key = JSON.stringify(parts);
      if (!groups.has(key))
        groups.set(key, { key, parts, label: t.name, records: [] });
    }
  return {
    options,
    details: records,
    totals: aggregate(records, options),
    groups: [...groups.values()]
      .map((g) => ({
        key: g.key,
        label: g.label,
        ...aggregate(g.records, options, g.parts),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
export function comparison(current, previous) {
  return Object.fromEntries(
    [
      "revenueCents",
      "completed",
      "totalMinutes",
      "totalBonusCents",
      "includedTreatments",
      "historicalVisits",
      "historicalMinutes",
    ]
      .filter((key) => current[key] != null && previous[key] != null)
      .map((key) => {
        const value = current[key],
          before = previous[key],
          difference = value - before;
        return [
          key,
          {
            value,
            previous: before,
            difference,
            percent: before
              ? (difference / before) * 100
              : value === 0
                ? 0
                : null,
          },
        ];
      }),
  );
}
const csvCell = (value) => {
  const s = String(value ?? "");
  return (
    '"' + (/^[\s]*[=+@-]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
  );
};
const decimal = (value) => (value == null ? "" : (value / 100).toFixed(2));
const yesNo = (value) => (value == null ? "Unknown" : value ? "Yes" : "No");
const sourceAmount = (value, digits) =>
  value == null || digits == null ? "" : (value / 10 ** digits).toFixed(digits);
const sourceAmounts = (r) =>
  (r.sourceNetSales || [])
    .map(
      (a) => `${a.currency} ${sourceAmount(a.amountMinor, a.minorUnitDigits)}`,
    )
    .join("; ");
const hours = (value) => (value / 60).toFixed(4);
const clock = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const localTime = (iso) =>
  iso
    ? new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Belgrade",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(iso))
    : "";
export function reportCSV(report, view = "summary", bonuses = true) {
  if (!["summary", "details"].includes(view))
    fail(400, "Choose Summary or Appointment list.");
  let header, rows;
  const combined =
    report.options.source === "history" || report.totals.historicalRows > 0;
  if (view === "details") {
    header = [
      "Appointment ID",
      "Therapist",
      "Treatment date (Rei: Europe/Belgrade; history: source date)",
      "Start",
      "Treatment",
      "Duration minutes",
      "Full price RSD",
      "After discount RSD",
      "Booked on (Rei: Europe/Belgrade; history: original source)",
      "Status",
      "Cancelled",
      "Cancelled on (Rei: Europe/Belgrade; history: original source)",
      "Requested",
      "Requested therapist",
      "Request fulfilled",
      "Data source",
      "Source status",
      "Source completion",
      "Included treatment",
      "Source net sales",
      "Source currency",
      "Source money basis",
      "Source money note",
      "Source time zone",
      "Excluded: overlapping Rei booking",
    ];
    if (bonuses)
      header.push(
        "Bonus mode",
        "Bonus rate (RSD/hour or percent)",
        "Earned bonus RSD",
      );
    rows = report.details.map((r) => [
      r.id,
      r.therapist,
      r.date,
      clock(r.start),
      r.treatment,
      r.duration,
      decimal(r.grossCents),
      decimal(r.netCents),
      r.rowSource === "history"
        ? r.sourceCreatedAt?.raw || ""
        : localTime(r.createdAt),
      r.status === "done" ? "Completed" : r.status,
      r.status === "cancelled" ? "Yes" : "No",
      r.rowSource === "history"
        ? r.sourceCancelledAt?.raw || ""
        : localTime(r.cancelledAt),
      yesNo(r.requested),
      r.requestedTherapist,
      yesNo(r.requestFulfilled),
      r.rowSource === "history" ? "Imported history" : "Rei booking",
      r.sourceStatus,
      r.completionState,
      yesNo(r.included ?? r.status === "done"),
      sourceAmount(r.sourceNetSalesMinor, r.minorUnitDigits),
      r.currency,
      r.moneyBasis,
      r.moneyIssue,
      r.sourceTimeZone,
      r.nativeOverlap ? "Yes" : "No",
      ...(bonuses
        ? [r.bonusMode, decimal(r.bonusRate), decimal(r.bonusCents)]
        : []),
    ]);
  } else {
    header = [
      "Group",
      "From",
      "To",
      "Appointments",
      combined ? "Completed Rei bookings" : "Completed",
      "Cancelled",
      "No-show",
      combined ? "Pending Rei bookings" : "Pending",
      "Requested bookings",
      "Total hours",
      combined ? "Rei regular hours" : "Regular hours",
      combined ? "Rei fulfilled requested hours" : "Fulfilled requested hours",
      combined ? "Rei treatment revenue RSD" : "Treatment revenue RSD",
      combined
        ? "Average revenue per completed Rei booking RSD"
        : "Average revenue per completed massage RSD",
      "Day basis",
      "Days",
      "Average hours per day",
      "Included treatments",
      "Imported treatments",
      "Imported visits (unique in this group)",
      "Imported hours",
      "Imported source net sales by currency",
      "Imported amounts unavailable",
      "Overlapping history excluded",
    ];
    if (bonuses)
      header.push(
        combined ? "Rei regular bonus RSD" : "Regular bonus RSD",
        combined ? "Rei requested bonus RSD" : "Requested bonus RSD",
        combined ? "Rei total bonus RSD" : "Total bonus RSD",
      );
    rows = [...report.groups, { ...report.totals, label: "TOTAL" }].map((r) => [
      r.label,
      r.from,
      r.to,
      r.appointments,
      r.completed,
      r.cancelled,
      r.noShow,
      r.pending,
      r.requestedCount,
      hours(r.totalMinutes),
      hours(r.regularMinutes),
      hours(r.requestedMinutes),
      decimal(r.revenueCents),
      decimal(r.averageRevenueCents),
      report.options.dayBasis,
      r.dayCount,
      hours(r.averageMinutesPerDay),
      r.includedTreatments ?? r.completed,
      r.historicalTreatments ?? 0,
      r.historicalVisits ?? 0,
      hours(r.historicalMinutes ?? 0),
      sourceAmounts(r),
      r.unavailableMoneyRows ?? 0,
      r.nativeOverlapRows ?? 0,
      ...(bonuses
        ? [
            decimal(r.regularBonusCents),
            decimal(r.requestedBonusCents),
            decimal(r.totalBonusCents),
          ]
        : []),
    ]);
  }
  return (
    "\uFEFF" +
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}
