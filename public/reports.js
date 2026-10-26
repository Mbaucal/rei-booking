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
  preset: "last30",
  source: "all",
  therapist: "",
  service: "",
  status: "all",
  requested: "all",
  group: "therapist",
  dayBasis: "active",
  view: "summary",
  bonuses: true,
};
let dashboardPreset = "last30";
let dashboardSource = "all";
const hours = (n) =>
  (n / 60).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " h";
export async function renderReports(ctx, dashboard = false, snapshot = null) {
  if (!dashboard && !snapshot && ctx.initialFilters)
    saved = { ...saved, ...ctx.initialFilters, view: "summary" };
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
    ? {
        preset: dashboardPreset,
        source: dashboardSource,
        group: "therapist",
        dayBasis: "active",
      }
    : { ...viewState };
  let report = null,
    sequence = 0,
    loadedQuery = "";
  root.innerHTML = `<form id="report-filter"><div class="report-controls">${choose("preset", "Period", { last7: "Last 7 days", last30: "Last 30 days", last_month: "Last month", ...(!dashboard ? { custom: "Custom dates" } : {}) }, form.preset)}${choose("source", "Data source", { all: "All data", native: "Rei bookings", history: "Imported history" }, form.source || "all")}${!dashboard ? `<label data-custom-date><span>From</span><input type="date" name="from" value="${esc(form.from || "")}"></label><label data-custom-date><span>To</span><input type="date" name="to" value="${esc(form.to || "")}"></label>${choose("therapist", "Therapist", Object.fromEntries([["", "All therapists"], ...catalogue.therapists.map((t) => [t.id, t.name])]), form.therapist)}${choose("service", "Treatment", Object.fromEntries([["", "All treatments"], ...catalogue.services.map((s) => [s.id, `${s.name} · ${s.duration} min`])]), form.service)}${choose("status", "Status", { all: "All statuses", booked: "Booked", confirmed: "Confirmed", done: "Completed", cancelled: "Cancelled", no_show: "No-show" }, form.status)}${choose("requested", "Client request", { all: "All appointments", yes: "Requested", no: "Not requested" }, form.requested)}${choose("group", "Group by", groups, form.group)}${choose("dayBasis", "Average hours per day", { active: "Days with included treatments", calendar: "All calendar days in period" }, form.dayBasis)}` : ""}<button class="btn primary" type="submit">${dashboard ? "Refresh" : "Run report"}</button></div></form><p class="hint report-period" id="report-period"></p><div id="report-history-dates" class="toolbar" hidden></div><p class="error" id="report-error" role="alert" hidden></p><div id="report-metrics" class="report-metrics"></div>${dashboard ? '<div class="toolbar"><button class="btn" id="open-reports">Open detailed reports</button></div>' : `<div class="toolbar report-view">${choose("view", "View", { summary: "Summary", details: "Appointment list" }, form.view)}<label class="check"><input id="report-bonuses" type="checkbox" ${form.bonuses ? "checked" : ""}>Include bonus columns</label><button class="btn" id="report-export" disabled>Export CSV</button></div><div id="report-table"></div><p class="hint report-note" id="report-note"></p>`}`;
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
  function openDashboardDetails(range = {}) {
    if (!dashboard || !report || !isCurrent()) return;
    openReports({
      preset: report.options.preset,
      from: report.options.from,
      to: report.options.to,
      source: report.options.source,
      group: report.options.group,
      dayBasis: report.options.dayBasis,
      therapist: "",
      service: "",
      status: "all",
      requested: "all",
      ...range,
    });
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
  const optionalMoney = (n) => (n == null ? "Unavailable" : money(n));
  const yesNo = (v) => (v == null ? "Unknown" : v ? "Yes" : "No");
  const sourceValue = (amount, currency, digits) =>
    amount == null || !currency || digits == null
      ? "Unavailable"
      : `${currency} ${(amount / 10 ** digits).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const sourceTotals = (r) => {
    const amounts = (r.sourceNetSales || []).map((a) =>
      sourceValue(a.amountMinor, a.currency, a.minorUnitDigits),
    );
    if (r.unavailableMoneyRows)
      amounts.push(`${r.unavailableMoneyRows} unavailable`);
    return (
      amounts.join(" · ") || (r.historicalTreatments ? "Unavailable" : "—")
    );
  };
  function refreshCatalogues() {
    if (dashboard || !report.filters) return;
    for (const [field, list, label] of [
      ["therapist", report.filters.therapists, "All therapists"],
      ["service", report.filters.services, "All treatments"],
    ]) {
      if (!Array.isArray(list)) continue;
      const select = filter.elements[field],
        selected = select.value;
      select.innerHTML =
        `<option value="">${label}</option>` +
        list
          .map(
            (item) =>
              `<option value="${esc(item.id)}">${esc(item.name)}${field === "service" ? ` · ${esc(item.duration)} min` : ""}</option>`,
          )
          .join("");
      select.value = selected;
    }
  }
  function renderData() {
    if (!report) return;
    const t = report.totals,
      c = report.comparison;
    const period = `${report.options.from} – ${report.options.to} · Europe/Belgrade`;
    $("report-period").textContent =
      `${period}. ${c ? `Compared with ${report.options.previousFrom} – ${report.options.previousTo}. Last 7/30 days exclude today.` : "Full-day comparison is unavailable for periods including today or future dates."}`;
    const imported = (t.historicalRows || 0) > 0;
    const combined = imported || report.options.source === "history";
    const history = report.history;
    if (history?.totalRows && !imported && report.options.source !== "native")
      $("report-period").textContent +=
        ` No imported records match this selection. Imported history spans ${history.minDate} to ${history.maxDate}; check the dates and filters.`;
    const datesAction = $("report-history-dates");
    datesAction.hidden = !(
      history?.totalRows &&
      !imported &&
      report.options.source !== "native" &&
      !snapshot
    );
    datesAction.innerHTML = "";
    if (!datesAction.hidden) {
      const earliest = new Date(
        Date.parse(history.maxDate + "T12:00:00Z") - 365 * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      const clipped = history.minDate < earliest;
      const selectedRange = {
        preset: "custom",
        from: clipped ? earliest : history.minDate,
        to: history.maxDate,
      };
      datesAction.innerHTML = `<button class="btn" type="button" id="report-show-history-dates">Show imported dates${clipped ? " (latest 366 days)" : ""}</button>`;
      $("report-show-history-dates").onclick = () => {
        if (!isCurrent()) return;
        if (dashboard) {
          openDashboardDetails(selectedRange);
        } else {
          for (const [key, value] of Object.entries(selectedRange))
            filter.elements[key].value = value;
          datesVisibility();
          load();
        }
      };
    }
    if (t.nativeOverlapRows)
      $("report-period").textContent +=
        ` ${t.nativeOverlapRows} imported records overlap a Rei booking and are excluded from totals. Review the appointment list.`;
    $("report-metrics").innerHTML =
      (report.options.source === "history"
        ? ""
        : metric(
            imported
              ? "Rei treatment revenue"
              : "Total earnings · treatment revenue",
            money(t.revenueCents),
            c?.revenueCents,
            money,
          )) +
      metric(
        combined ? "Included treatments" : "Completed massages",
        String(t.includedTreatments ?? t.completed),
        c?.includedTreatments || c?.completed,
        String,
      ) +
      metric(
        combined ? "Included treatment hours" : "Completed massage hours",
        hours(t.totalMinutes),
        c?.totalMinutes,
        hours,
      ) +
      (!dashboard && viewState.bonuses && report.options.source !== "history"
        ? metric(
            imported ? "Rei earned bonuses" : "Earned bonuses",
            money(t.totalBonusCents),
            c?.totalBonusCents,
            money,
            true,
          )
        : "") +
      (imported
        ? metric("Imported source net sales", sourceTotals(t), null, String) +
          metric(
            "Imported visits",
            String(t.historicalVisits),
            c?.historicalVisits,
            String,
          )
        : "");
    if (imported)
      $("report-period").textContent +=
        ` ${t.unknownRequested || 0} imported requests and ${t.unknownCompletion || 0} source completion states are unknown. Imported dates remain the dates recorded by the source.`;
    if (dashboard) return;
    $("report-note").textContent = imported
      ? "Rei hours, revenue and bonuses count completed bookings. Imported treatments and hours include every supplied status except No Show, Canceled and Cancelled; the original status and completion evidence stay unchanged. Imported visits count each source appointment once within a group, so visit counts across groups may not add up. Source net sales are separate from Rei revenue and never converted between currencies. Missing or ambiguous source amounts, full prices, requests and bonuses stay unavailable. Current bonus rates are never applied to imported history."
      : "Hours, treatment revenue and bonuses count completed Rei bookings. Revenue is the treatment value after discount, before bonuses and other costs. Requested bonus hours count fulfilled requests; a replacement therapist earns the regular rate. Percentage bonuses use the full price. Bonus cents are reconciled per therapist and category within this filtered period.";
    const bonus = viewState.bonuses,
      details = viewState.view === "details";
    let heads,
      rows,
      footer = "";
    const cells = (values) => values.map((v) => `<td>${esc(v)}</td>`).join("");
    const summary = (r) => [
      r.label,
      r.appointments,
      r.includedTreatments ?? r.completed,
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
      ...(imported
        ? [
            r.historicalTreatments,
            r.historicalVisits,
            hours(r.historicalMinutes),
            sourceTotals(r),
            r.nativeOverlapRows,
          ]
        : []),
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
        "Source",
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
        ...(imported
          ? [
              "Source net sales",
              "Source completion",
              "Source time zone",
              "Included",
              "Review note",
            ]
          : []),
        ...(bonus ? ["Bonus rule", "Earned bonus"] : []),
      ];
      rows = report.details.map((r) =>
        cells([
          r.rowSource === "history" ? "Imported history" : "Rei booking",
          r.therapist,
          r.date,
          clock(r.start),
          r.treatment,
          r.duration,
          optionalMoney(r.grossCents),
          optionalMoney(r.netCents),
          r.rowSource === "history"
            ? r.sourceCreatedAt?.raw || "Unknown"
            : r.createdAt
              ? stamp(r.createdAt)
              : "Unknown",
          r.rowSource === "history"
            ? r.sourceStatus || "Unknown"
            : statusName(r.status),
          r.rowSource === "history"
            ? r.sourceCancelledAt?.raw || "Unknown"
            : r.cancelledAt
              ? stamp(r.cancelledAt)
              : "—",
          yesNo(r.requested),
          r.requestedTherapist || "—",
          yesNo(r.requestFulfilled),
          ...(imported
            ? [
                r.rowSource === "history"
                  ? sourceValue(
                      r.sourceNetSalesMinor,
                      r.currency,
                      r.minorUnitDigits,
                    )
                  : "—",
                r.completionState === "not_completed"
                  ? "Not completed"
                  : r.completionState === "completed"
                    ? "Completed"
                    : r.rowSource === "history"
                      ? "Unknown"
                      : "—",
                r.rowSource === "history"
                  ? r.sourceTimeZone || "Unknown"
                  : "Europe/Belgrade",
                yesNo(r.included ?? r.status === "done"),
                r.nativeOverlap
                  ? "Overlaps a Rei booking; excluded from totals"
                  : r.moneyIssue || "—",
              ]
            : []),
          ...(bonus
            ? [
                r.bonusMode == null
                  ? "Unavailable"
                  : r.bonusMode === "hourly"
                    ? `${money(r.bonusRate)}/h`
                    : `${(r.bonusRate / 100).toFixed(2)}% of full price`,
                optionalMoney(r.bonusCents),
              ]
            : []),
        ]),
      );
    } else {
      heads = [
        groups[report.options.group],
        "Appointments",
        combined ? "Included treatments" : "Completed",
        "Cancelled",
        "No-show",
        "Pending",
        "Total hours",
        combined ? "Rei regular hours" : "Regular hours",
        combined ? "Rei requested hours" : "Requested hours",
        combined ? "Rei treatment revenue" : "Treatment revenue",
        combined
          ? "Avg. Rei revenue / completed booking"
          : "Avg. revenue / massage",
        report.options.dayBasis === "active"
          ? "Days with massages"
          : "Calendar days",
        "Avg. hours / day",
        ...(imported
          ? [
              "Imported treatments",
              "Imported visits",
              "Imported hours",
              "Imported source net sales",
              "Overlapping history excluded",
            ]
          : []),
        ...(bonus
          ? combined
            ? ["Rei regular bonus", "Rei requested bonus", "Rei total bonus"]
            : ["Regular bonus", "Requested bonus", "Total bonus"]
          : []),
      ];
      rows = report.groups.map((r) => cells(summary(r)));
      footer = `<tfoot><tr>${cells(summary({ ...t, label: "TOTAL" }))}</tr></tfoot>`;
    }
    $("report-table").innerHTML =
      `<p class="hint">${report.details.length} records in this report. Scroll the table sideways to see every column.</p><div class="table-wrap report-table" tabindex="0" role="region" aria-label="${details ? "Appointment list" : "Summary report"}"><table><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r}</tr>`).join("") || `<tr><td colspan="${heads.length}">No appointments match this period and filters.</td></tr>`}</tbody>${footer}</table></div>`;
    $("report-export").disabled = false;
  }
  async function load() {
    const seq = ++sequence;
    report = null;
    if (dashboard) $("open-reports").disabled = true;
    $("report-error").hidden = true;
    $("report-history-dates").hidden = true;
    $("report-metrics").innerHTML = "";
    $("report-period").textContent = "Loading report…";
    if (!dashboard) {
      $("report-export").disabled = true;
      $("report-table").textContent = "";
    }
    const values = Object.fromEntries(new FormData(filter));
    if (dashboard) {
      dashboardPreset = values.preset;
      dashboardSource = values.source;
    } else Object.assign(viewState, values);
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
      refreshCatalogues();
      renderData();
      if (dashboard) $("open-reports").disabled = false;
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
    $("report-history-dates").hidden = true;
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
  if (dashboard) $("open-reports").onclick = () => openDashboardDetails();
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
      '<button class="btn" data-monthly>Monthly reports</button><button class="btn" data-schedule>Save filters as monthly schedule</button>' +
      (ctx.openReportAccess
        ? '<button class="btn" id="report-access-open" type="button">Google Sheets / API</button>'
        : "");
    root.prepend(toolbar);
    toolbar.querySelector("[data-monthly]").onclick = () => ctx.openMonthly();
    if (ctx.openReportAccess)
      toolbar.querySelector("#report-access-open").onclick = () =>
        ctx.openReportAccess();
    toolbar.querySelector("[data-schedule]").onclick = () =>
      ctx.openMonthly({
        ...Object.fromEntries(new FormData(filter)),
        bonuses: viewState.bonuses,
      });
  }
  await load();
}
