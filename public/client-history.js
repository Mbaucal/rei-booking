import { HISTORY_COLUMNS, historyTime } from "./history-preview-helpers.js";

const completionLabels = {
  completed: "Completed",
  not_completed: "Not completed",
  unknown: "Unknown",
};
const requestLabels = { yes: "Yes", no: "No", unknown: "Unknown" };
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-GB")
    : "0";
const importedTime = (value) => {
  if (!value) return null;
  const time = new Date(value);
  return Number.isFinite(time.valueOf())
    ? time.toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Belgrade",
      })
    : null;
};

/** Pure display of the API projection. No current-menu or financial inference. */
export function renderClientHistoryPage(
  data,
  esc,
  { canViewSource = false } = {},
) {
  const safe = (value) => esc(String(value ?? ""));
  const facts = (pairs) =>
    `<dl class="client-history-facts">${pairs.map(([label, value]) => `<dt>${safe(label)}</dt><dd>${safe(value ?? "Unknown")}</dd>`).join("")}</dl>`;
  const statuses = (data.statusCounts || []).map((item) => ({
    status: item.status,
    count: item.count,
  }));
  for (const status of ["Cancelled", "No Show"])
    if (!statuses.some((item) => item.status === status))
      statuses.push({ status, count: 0 });
  const pages = Math.max(
    1,
    data.totalPages || Math.ceil(data.total / (data.pageSize || 25)),
  );
  return `<section class="client-history-section" aria-label="Imported appointment history">
    <header><p class="eyebrow">PREVIOUS BOOKING SYSTEMS</p><h3>Imported appointment history</h3><p class="hint">Saved source records. Bookings in Rei are shown separately.</p></header>
    <div id="client-history-summary"><p class="client-history-total"><strong>${count(data.total)}</strong> imported ${data.total === 1 ? "appointment" : "appointments"}</p><div class="client-history-statuses" aria-label="Original status counts across this client's imported history">${statuses.map((item) => `<span class="client-history-status-count"><strong>${count(item.count)}</strong> ${safe(item.status ?? "Unknown status")}</span>`).join("")}</div></div>
    <p id="client-history-loading" class="hint" role="status" hidden>Loading history…</p><div id="client-history-error" class="client-history-error" role="alert" hidden></div>
    <div class="client-history-records">${
      (data.rows || [])
        .map(
          (
            item,
          ) => `<article class="client-history-record" data-client-history-row="${safe(item.id)}"><div class="client-history-record-top"><div><strong>${safe(item.serviceName || "Treatment unknown")}</strong><p>${safe(item.date || "Date unknown")} · ${safe(historyTime(item.start, item.duration))}</p></div><span class="client-history-source-status">${safe(item.sourceStatus ?? "Unknown status")}</span></div><p class="hint">${safe(item.therapistName || "Therapist unknown")}${item.roomName ? ` · ${safe(item.roomName)}` : ""}</p><details><summary>Appointment details</summary>${facts(
            [
              ["Original status", item.sourceStatus],
              [
                "Duration",
                item.duration == null ? null : `${item.duration} min`,
              ],
              [
                "Completion",
                completionLabels[item.completionState] || "Unknown",
              ],
              [
                "Requested therapist",
                requestLabels[item.requestState] || "Unknown",
              ],
              ["Added to history", importedTime(item.importedAt)],
            ],
          )}
      ${canViewSource && item.record?.raw ? `<details class="client-history-source-values"><summary>Original source values</summary>${facts(Object.entries(item.record.raw).map(([key, value]) => [HISTORY_COLUMNS[key] || key, value == null ? "Not supplied" : value === "" ? "(empty)" : value]))}</details>` : ""}</details></article>`,
        )
        .join("") ||
      `<p class="client-history-empty">No imported appointment history yet.</p>`
    }</div>
    <div class="client-history-pagination"><button class="btn" id="client-history-prev" ${data.page <= 0 ? "disabled" : ""}>Previous</button><span>Page ${Number(data.page || 0) + 1} of ${pages}</span><button class="btn" id="client-history-next" ${Number(data.page || 0) + 1 >= pages ? "disabled" : ""}>Next</button></div>
    <p class="hint client-history-note">Original statuses are preserved. New, Confirmed and Started do not establish that a treatment was completed.</p>
  </section>`;
}

export function mountClientHistory({
  root,
  api,
  esc,
  isCurrent,
  clientId,
  canViewSource = false,
}) {
  let generation = 0,
    disposed = false,
    busy = false,
    currentPage = 0,
    lastData = null;
  const current = (version) =>
    !disposed && isCurrent() && version === generation;
  const $ = (id) => root.querySelector(`#${id}`);
  root.classList.add("client-history");
  root.innerHTML = `<section class="client-history-section"><h3>Imported appointment history</h3><p id="client-history-loading" class="hint" role="status">Loading history…</p><div id="client-history-error" class="client-history-error" role="alert" hidden></div></section>`;
  async function load(page) {
    if (busy || disposed || !isCurrent()) return;
    const version = ++generation;
    busy = true;
    root.setAttribute("aria-busy", "true");
    $("client-history-loading").hidden = false;
    $("client-history-error").hidden = true;
    for (const id of ["client-history-prev", "client-history-next"])
      if ($(id)) $(id).disabled = true;
    try {
      const data = await api(
        `/clients/${encodeURIComponent(clientId)}/history?page=${page}`,
      );
      if (!current(version)) return;
      if (data.clientId !== clientId)
        throw new Error(
          "This history could not be verified for the current client. Try again.",
        );
      lastData = data;
      currentPage = data.page ?? page;
      root.innerHTML = renderClientHistoryPage(data, esc, { canViewSource });
      bindPages();
    } catch (error) {
      if (!current(version)) return;
      if (lastData) {
        root.innerHTML = renderClientHistoryPage(lastData, esc, {
          canViewSource,
        });
        bindPages();
      }
      $("client-history-error").innerHTML =
        `<p>${esc(String(error.message || "History could not be loaded."))}</p><button class="btn" id="client-history-retry">Try again</button>`;
      $("client-history-error").hidden = false;
      $("client-history-retry").onclick = () => load(page);
    } finally {
      if (current(version)) {
        busy = false;
        root.setAttribute("aria-busy", "false");
        $("client-history-loading").hidden = true;
      }
    }
  }
  function bindPages() {
    $("client-history-prev").onclick = () => load(currentPage - 1);
    $("client-history-next").onclick = () => load(currentPage + 1);
  }
  load(0);
  return () => {
    disposed = true;
    generation++;
  };
}
