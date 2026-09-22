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
  if (
    !Object.hasOwn(GROUPS, group) ||
    !["all", "booked", "confirmed", "done", "cancelled", "no_show"].includes(
      status,
    ) ||
    !["all", "yes", "no"].includes(requested) ||
    !["active", "calendar"].includes(dayBasis)
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

function detail(row) {
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
    if (r.status !== "done") continue;
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
  };
  const dates = new Set();
  for (const r of records) {
    if (r.requested) out.requestedCount++;
    if (r.status === "cancelled") out.cancelled++;
    else if (r.status === "no_show") out.noShow++;
    else if (r.status !== "done") out.pending++;
    if (r.status !== "done") continue;
    out.completed++;
    dates.add(r.date);
    out.totalMinutes += r.duration;
    out.revenueCents += r.netCents;
    const prefix = r.requestFulfilled ? "requested" : "regular";
    out[prefix + "Minutes"] += r.duration;
    out[prefix + "BonusCents"] += r.bonusCents;
  }
  out.dayCount = options.dayBasis === "calendar" ? days(from, to) : dates.size;
  out.averageMinutesPerDay = out.dayCount ? out.totalMinutes / out.dayCount : 0;
  out.averageRevenueCents = out.completed
    ? out.revenueCents / out.completed
    : 0;
  out.totalBonusCents = out.regularBonusCents + out.requestedBonusCents;
  return { ...out, from, to };
}
export function buildReport(rows, options, therapists = []) {
  const seen = new Set();
  const records = rows
    .filter((r) => {
      if (seen.has(r.id)) fail(422, "Duplicate appointments in report data.");
      seen.add(r.id);
      return (
        r.date >= options.from &&
        r.date <= options.to &&
        (!options.therapist || r.therapist_id === options.therapist) &&
        (!options.service || r.service_id === options.service) &&
        (options.status === "all" || r.status === options.status) &&
        (options.requested === "all" ||
          !!r.requested_therapist_id === (options.requested === "yes"))
      );
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
  if (options.group === "therapist")
    for (const t of therapists.filter(
      (t) => !options.therapist || t.id === options.therapist,
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
    ["revenueCents", "completed", "totalMinutes", "totalBonusCents"].map(
      (key) => {
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
      },
    ),
  );
}
const csvCell = (value) => {
  const s = String(value ?? "");
  return (
    '"' + (/^[\s]*[=+@-]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
  );
};
const decimal = (value) => (value / 100).toFixed(2);
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
  if (view === "details") {
    header = [
      "Appointment ID",
      "Therapist",
      "Treatment date (Europe/Belgrade)",
      "Start",
      "Treatment",
      "Duration minutes",
      "Full price RSD",
      "After discount RSD",
      "Booked on (Europe/Belgrade)",
      "Status",
      "Cancelled",
      "Cancelled on (Europe/Belgrade)",
      "Requested",
      "Requested therapist",
      "Request fulfilled",
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
      localTime(r.createdAt),
      r.status === "done" ? "Completed" : r.status,
      r.status === "cancelled" ? "Yes" : "No",
      localTime(r.cancelledAt),
      r.requested ? "Yes" : "No",
      r.requestedTherapist,
      r.requestFulfilled ? "Yes" : "No",
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
      "Completed",
      "Cancelled",
      "No-show",
      "Pending",
      "Requested bookings",
      "Total hours",
      "Regular hours",
      "Fulfilled requested hours",
      "Treatment revenue RSD",
      "Average revenue per completed massage RSD",
      "Day basis",
      "Days",
      "Average hours per day",
    ];
    if (bonuses)
      header.push(
        "Regular bonus RSD",
        "Requested bonus RSD",
        "Total bonus RSD",
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
