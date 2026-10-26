const pages = new Set([
  "dashboard",
  "calendar",
  "clients",
  "team",
  "services",
  "users",
  "reports",
  "monthly",
  "sales",
  "client-transfer",
  "history-preview",
  "history-salon",
  "history-links",
]);
const modes = new Set(["all", "therapists", "rooms"]);

export function canOpenPage(page, role) {
  if (!pages.has(page)) return false;
  return (
    role === "owner" ||
    (role === "reception" && ["calendar", "clients"].includes(page)) ||
    (role === "therapist" && page === "calendar")
  );
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || value.startsWith("0000"))
    return false;
  const date = new Date(value + "T12:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

// Persist only navigation, never client data or unfinished forms.
export function readPageLocation(hash, { role, compact, date, mode }) {
  const fallback = role === "owner" && !compact ? "dashboard" : "calendar";
  if (role === "owner" && /^#report=[a-f0-9]{64}$/.test(hash))
    return { page: "monthly", reportId: hash.slice(8), date, mode };
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const page = canOpenPage(params.get("page"), role)
    ? params.get("page")
    : fallback;
  return {
    page,
    reportId: null,
    date:
      page === "calendar" && validDate(params.get("date"))
        ? params.get("date")
        : date,
    mode:
      page === "calendar" && modes.has(params.get("mode"))
        ? params.get("mode")
        : mode,
  };
}

export function writePageLocation(
  { page, date, mode, reportId },
  replace = false,
) {
  const params = new URLSearchParams({ page });
  if (page === "calendar") {
    params.set("date", date);
    params.set("mode", mode);
  }
  const hash =
    page === "monthly" && /^[a-f0-9]{64}$/.test(reportId || "")
      ? "#report=" + reportId
      : "#" + params.toString();
  if (location.hash !== hash)
    history[replace ? "replaceState" : "pushState"](
      null,
      "",
      location.pathname + location.search + hash,
    );
}
