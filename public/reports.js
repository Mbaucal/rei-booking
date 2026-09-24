const groups = {
  therapist: "Therapist",
  month: "Month",
  day: "Day",
  treatment: "Treatment",
  therapist_month: "Therapist + month",
  therapist_day: "Therapist + day",
  therapist_treatment: "Therapist + treatment",
  therapist_month_treatment: "Therapist + month + treatment",
  therapist_day_treatment: "Therapist + day + treatment",
};
let saved = {
  preset: "last_month",
  therapist: "",
  service: "",
  status: "all",
  requested: "all",
  group: "therapist",
  dayBasis: "active",
  view: "summary",
  bonuses: true,
};
let dashboardPreset = "last7";
const hours = (n) =>
  (n / 60).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " h";
export async function renderReports(ctx, dashboard = false, snapshot = null) {
  const viewState = snapshot
    ? { ...saved, bonuses: snapshot.includeBonuses !== false }
    : saved;
  const {
    root,
    api,
    esc,
    money,
    stamp,
    clock,
    statusName,
    catalogue,
    isCurrent,
    download,
    openReports,
  } = ctx;
  const choose = (name, label, list, selected) =>
    `<label><span>${label}</span><select name="${name}">${Object.entries(list)
      .map(
        ([v, text]) =>
          `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(text)}</option>`,
      )
      .join("")}</select></label>`;
  const form = dashboard
    ? { preset: dashboardPreset, group: "therapist", dayBasis: "active" }
    : { ...viewState };
  let report = null,
    sequence = 0,
    loadedQuery = "";
  root.innerHTML = `<form id="report-filter"><div class="report-controls">${choose("preset", "Period", { last7: "Last 7 days", last30: "Last 30 days", last_month: "Last month", ...(!dashboard ? { custom: "Custom dates" } : {}) }, form.preset)}${!dashboard ? `<label data-custom-date><span>From</span><input type="date" name="from" value="${esc(form.from || "")}"></label><label data-custom-date><span>To</span><input type="date" name="to" value="${esc(form.to || "")}"></label>${choose("therapist", "Therapist", Object.fromEntries([["", "All therapists"], ...catalogue.therapists.map((t) => [t.id, t.name])]), form.therapist)}${choose("service", "Treatment", Object.fromEntries([["", "All treatments"], ...catalogue.services.map((s) => [s.id, `${s.name} · ${s.duration} min`])]), form.service)}${choose("status", "Status", { all: "All statuses", booked: "Booked", confirmed: "Confirmed", done: "Completed", cancelled: "Cancelled", no_show: "No-show" }, form.status)}${choose("requested", "Client request", { all: "All appointments", yes: "Requested", no: "Not requested" }, form.requested)}${choose("group", "Group by", groups, form.group)}${choose("dayBasis", "Average hours per day", { active: "Days with completed massages", calendar: "All calendar days in period" }, form.dayBasis)}` : ""}<button class="btn primary" type="submit">${dashboard ? "Refresh" : "Run report"}</button></div></form><p class="hint report-period" id="report-period"></p><p class="error" id="report-error" role="alert" hidden></p><div id="report-metrics" class="report-metrics"></div>${dashboard ? '<div class="toolbar"><button class="btn" id="open-reports">Open detailed reports</button></div>' : `<div class="toolbar report-view">${choose("view", "View", { summary: "Summary", details: "Appointment list" }, form.view)}<label class="check"><input id="report-bonuses" type="checkbox" ${form.bonuses ? "checked" : ""}>Include bonus columns</label><button class="btn" id="report-export" disabled>Export CSV</button></div><div id="report-table"></div><p class="hint report-note">Hours, treatment revenue and bonuses count Completed massages only. Revenue is the treatment value after discount, before bonuses and other costs. Requested bonus hours count fulfilled requests; a replacement therapist earns the regular rate. Percentage bonuses use the full price. Booked on remains the original creation time. Bonus cents are reconciled per therapist and category within this filtered period.</p>`}`;
  const $ = (id) => root.querySelector("#" + id);
  const filter = $("report-filter");
  function datesVisibility() {
    root.querySelectorAll("[data-custom-date]").forEach((el) => {
      el.hidden = filter.elements.preset.value !== "custom";
      el.querySelector("input").required = !el.hidden;
    });
  }
  function showError(error) {
    $("report-error").textContent = error.message;
    $("report-error").hidden = false;
  }
  function metric(label, value, change, format, cost = false) {
    let note = "";
    if (change) {
      const sign =
        change.difference > 0 ? "+" : change.difference < 0 ? "−" : "";
      const percent =
        change.percent == null
          ? "percentage unavailable (previously zero)"
          : `${Math.abs(change.percent).toFixed(1)}%`;
      note = `<p class="report-change ${cost ? "neutral" : change.difference < 0 ? "down" : change.difference > 0 ? "up" : "neutral"}">${sign}${esc(format(Math.abs(change.difference)))} · ${esc(percent)}</p><small>Previous: ${esc(format(change.previous))}</small>`;
    }
    return `<article class="report-metric"><span>${label}</span><strong>${esc(value)}</strong>${note}</article>`;
  }
  function renderData() {
    if (!report) return;
    const t = report.totals,
      c = report.comparison;
    const period = `${report.options.from} – ${report.options.to} · Europe/Belgrade`;
    $("report-period").textContent =
      `${period}. ${c ? `Compared with ${report.options.previousFrom} – ${report.options.previousTo}. Last 7/30 days exclude today.` : "Full-day comparison is unavailable for periods including today or future dates."}`;
    $("report-metrics").innerHTML =
      metric(
        "Total earnings · treatment revenue",
        money(t.revenueCents),
        c?.revenueCents,
        money,
      ) +
      metric("Completed massages", String(t.completed), c?.completed, String) +
      metric(
        "Completed massage hours",
        hours(t.totalMinutes),
        c?.totalMinutes,
        hours,
      ) +
      (!dashboard && viewState.bonuses
        ? metric(
            "Earned bonuses",
            money(t.totalBonusCents),
            c?.totalBonusCents,
            money,
            true,
          )
        : "");
    if (dashboard) return;
    const bonus = viewState.bonuses,
      details = viewState.view === "details";
    let heads,
      rows,
      footer = "";
    const cells = (values) => values.map((v) => `<td>${esc(v)}</td>`).join("");
    const summary = (r) => [
      r.label,
      r.appointments,
      r.completed,
      r.cancelled,
      r.noShow,
      r.pending,
      hours(r.totalMinutes),
      hours(r.regularMinutes),
      hours(r.requestedMinutes),
      money(r.revenueCents),
      money(r.averageRevenueCents),
      r.dayCount,
      hours(r.averageMinutesPerDay),
      ...(bonus
        ? [
            money(r.regularBonusCents),
            money(r.requestedBonusCents),
            money(r.totalBonusCents),
          ]
        : []),
    ];
    if (details) {
      heads = [
        "Therapist",
        "Treatment date",
        "Time",
        "Treatment",
        "Minutes",
        "Full price",
        "After discount",
        "Booked on",
        "Status",
        "Cancelled on",
        "Requested",
        "Requested therapist",
        "Request fulfilled",
        ...(bonus ? ["Bonus rule", "Earned bonus"] : []),
      ];
      rows = report.details.map((r) =>
        cells([
          r.therapist,
          r.date,
          clock(r.start),
          r.treatment,
          r.duration,
          money(r.grossCents),
          money(r.netCents),
          stamp(r.createdAt),
          statusName(r.status),
          r.cancelledAt ? stamp(r.cancelledAt) : "—",
          r.requested ? "Yes" : "No",
          r.requestedTherapist || "—",
          r.requestFulfilled ? "Yes" : "No",
          ...(bonus
            ? [
                r.bonusMode === "hourly"
                  ? `${money(r.bonusRate)}/h`
                  : `${(r.bonusRate / 100).toFixed(2)}% of full price`,
                money(r.bonusCents),
              ]
            : []),
        ]),
      );
    } else {
      heads = [
        groups[report.options.group],
        "Appointments",
        "Completed",
        "Cancelled",
        "No-show",
        "Pending",
        "Total hours",
        "Regular hours",
        "Requested hours",
        "Treatment revenue",
        "Avg. revenue / massage",
        report.options.dayBasis === "active"
          ? "Days with massages"
          : "Calendar days",
        "Avg. hours / day",
        ...(bonus ? ["Regular bonus", "Requested bonus", "Total bonus"] : []),
      ];
      rows = report.groups.map((r) => cells(summary(r)));
      footer = `<tfoot><tr>${cells(summary({ ...t, label: "TOTAL" }))}</tr></tfoot>`;
    }
    $("report-table").innerHTML =
      `<p class="hint">${report.details.length} appointments in this report. Scroll the table sideways to see every column.</p><div class="table-wrap report-table" tabindex="0" role="region" aria-label="${details ? "Appointment list" : "Summary report"}"><table><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r}</tr>`).join("") || `<tr><td colspan="${heads.length}">No appointments match this period and filters.</td></tr>`}</tbody>${footer}</table></div>`;
    $("report-export").disabled = false;
  }
  async function load() {
    const seq = ++sequence;
    report = null;
    $("report-error").hidden = true;
    $("report-metrics").innerHTML = "";
    $("report-period").textContent = "Loading report…";
    if (!dashboard) {
      $("report-export").disabled = true;
      $("report-table").textContent = "";
    }
    const values = Object.fromEntries(new FormData(filter));
    if (dashboard) dashboardPreset = values.preset;
    else Object.assign(viewState, values);
    const query = new URLSearchParams(values).toString();
    try {
      const next = snapshot || (await api("/reports/appointments?" + query));
      if (!isCurrent() || seq !== sequence) return;
      report = next;
      loadedQuery = query;
      if (!dashboard) {
        for (const key of ["from", "to"])
          if (!filter.elements[key].value)
            filter.elements[key].value = next.options[key];
      }
      renderData();
    } catch (error) {
      if (isCurrent() && seq === sequence) {
        $("report-period").textContent = "";
        showError(error);
      }
    }
  }
  filter.onsubmit = (e) => {
    e.preventDefault();
    load();
  };
  filter.onchange = () => {
    datesVisibility();
    // Discard stale results as soon as controls change, so exports never
    // silently use a different set of filters than those currently displayed.
    sequence++;
    report = null;
    $("report-metrics").innerHTML = "";
    $("report-period").textContent =
      "Click Run report to apply this selection.";
    if (!dashboard) {
      $("report-export").disabled = true;
      $("report-table").textContent = "";
    }
    if (dashboard) load();
  };
  datesVisibility();
  if (dashboard) $("open-reports").onclick = openReports;
  else {
    root.querySelector('[name="view"]').onchange = (e) => {
      viewState.view = e.target.value;
      renderData();
    };
    $("report-bonuses").onchange = (e) => {
      viewState.bonuses = e.target.checked;
      renderData();
    };
    $("report-export").onclick = async () => {
      if (!report) return;
      const button = $("report-export");
      button.disabled = true;
      try {
        await download(
          loadedQuery +
            `&view=${viewState.view}&bonuses=${viewState.bonuses ? "1" : "0"}`,
        );
      } catch (error) {
        if (isCurrent()) showError(error);
      } finally {
        if (isCurrent() && report) button.disabled = false;
      }
    };
  }
  if (snapshot) {
    filter.hidden = true;
    $("report-bonuses").disabled = true;
  } else if (!dashboard && ctx.openMonthly) {
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.innerHTML =
      '<button class="btn" data-monthly>Monthly reports</button><button class="btn" data-schedule>Save filters as monthly schedule</button>';
    root.prepend(toolbar);
    toolbar.querySelector("[data-monthly]").onclick = () => ctx.openMonthly();
    toolbar.querySelector("[data-schedule]").onclick = () =>
      ctx.openMonthly({
        ...Object.fromEntries(new FormData(filter)),
        bonuses: viewState.bonuses,
      });
  }
  await load();
}
