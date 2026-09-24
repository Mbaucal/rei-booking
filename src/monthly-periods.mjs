import { fail } from "./security.mjs";
import { reportOptions, belgradeToday } from "./reports.mjs";
export function month(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))
    fail(400, "Choose a month between 2000 and 2099.");
  return value;
}
export function shiftMonth(value, count) {
  const [year, m] = month(value).split("-").map(Number);
  return new Date(Date.UTC(year, m - 1 + count, 1, 12))
    .toISOString()
    .slice(0, 7);
}
export const currentMonth = (time = Date.now()) =>
  belgradeToday(new Date(time)).slice(0, 7);
export function monthOptions(period, filters = {}) {
  month(period);
  // Resolve relative to the following first day, rather than an execution/downtime date.
  return reportOptions(
    new URLSearchParams({ ...filters, preset: "last_month" }),
    shiftMonth(period, 1) + "-01",
  );
}
export function dueAt(period, minute) {
  const first = shiftMonth(period, 1) + "-01";
  const target = Date.parse(first + "T00:00:00Z") + minute * 60000;
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      fmt.formatToParts(new Date(instant)).map((x) => [x.type, x.value]),
    );
    const rendered = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    instant += target - rendered;
  }
  return instant;
}
export function scheduleFilters(input = {}) {
  const normalized = reportOptions(
    new URLSearchParams({ ...input, preset: "last_month" }),
    "2026-01-01",
  );
  return Object.fromEntries(
    ["therapist", "service", "status", "requested", "group", "dayBasis"]
      .map((key) => [key, normalized[key]])
      .concat([["bonuses", input.bonuses !== false]]),
  );
}
const cell = (value) => {
  const s = String(value ?? "");
  return (
    '"' + (/^[\s]*[=+@-]/.test(s) ? "'" : "") + s.replaceAll('"', '""') + '"'
  );
};
export const csv = (rows) =>
  "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
export function comparisonCSV(report, bonuses = true) {
  const labels = {
    revenueCents: "Treatment revenue RSD",
    completed: "Completed massages",
    totalMinutes: "Completed hours",
    totalBonusCents: "Earned bonuses RSD",
  };
  return csv([
    [
      "Metric",
      "Current from",
      "Current to",
      "Previous from",
      "Previous to",
      "Current",
      "Previous",
      "Difference",
      "Change percent",
    ],
    ...Object.entries(report.comparison)
      .filter(([key]) => bonuses || key !== "totalBonusCents")
      .map(([key, value]) => {
        const format = (n) =>
          key === "totalMinutes"
            ? (n / 60).toFixed(4)
            : key.endsWith("Cents")
              ? (n / 100).toFixed(2)
              : n;
        return [
          labels[key],
          report.options.from,
          report.options.to,
          report.options.previousFrom,
          report.options.previousTo,
          format(value.value),
          format(value.previous),
          format(value.difference),
          value.percent == null
            ? "Unavailable: previous value is zero"
            : value.percent.toFixed(4),
        ];
      }),
  ]);
}
