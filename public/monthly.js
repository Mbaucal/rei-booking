import { renderReports } from "./reports.js";
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
export async function renderMonthly(
  ctx,
  initialFilters = null,
  initialId = null,
) {
  const {
    root,
    api,
    esc,
    money,
    stamp,
    catalogue,
    isCurrent,
    download,
    openReports,
  } = ctx;
  root.innerHTML =
    '<p>Loading monthly reports…</p><p class="error" id="monthly-error" role="alert" hidden></p>';
  let config,
    seq = 0,
    archive = [],
    offset = null;
  const $ = (s) => root.querySelector(s);
  const lastMonth = () => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const d = new Date(p.slice(0, 7) + "-01T12:00:00Z");
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };
  const select = (name, label, options, value) =>
    `<label><span>${label}</span><select name="${name}">${Object.entries(
      options,
    )
      .map(
        ([k, v]) =>
          `<option value="${esc(k)}" ${String(value) === k ? "selected" : ""}>${esc(v)}</option>`,
      )
      .join("")}</select></label>`;
  const status = (s) =>
    ({
      queued: "Queued",
      accepted: "Accepted by email provider",
      delivered: "Delivered",
      delayed: "Delivery delayed",
      retry: "Waiting to retry",
      sending: "Sending",
      failed: "Failed",
      uncertain: "Check delivery in Resend",
      cancelled: "Notification cancelled",
      expired: "Verification expired",
      suppressed: "Address blocked",
      bounced: "Bounced",
      complained: "Complaint received",
    })[s] || "No email notification";
  function error(e) {
    if (isCurrent() && $("#monthly-error")) {
      $("#monthly-error").hidden = false;
      $("#monthly-error").textContent = e.message;
    }
  }
  async function action(button, fn) {
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      error(e);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }
  async function load() {
    const version = ++seq;
    const [settings, list] = await Promise.all([
      api("/reports/monthly"),
      api("/reports/archive"),
    ]);
    if (!isCurrent() || version !== seq) return;
    config = settings;
    archive = list.snapshots;
    offset = list.nextOffset;
    root.innerHTML = `<div class="toolbar"><button class="btn" id="live-reports">Live reports</button><button class="btn primary" id="new-monthly">New monthly schedule</button></div><p class="hint">Reports close on the first day of each month, Europe/Belgrade. Saved versions and CSV files keep the values recorded at generation time.</p><p class="error" id="monthly-error" role="alert" hidden></p><section id="monthly-editor"></section><section class="monthly-section"><h2>Monthly schedules</h2><div id="monthly-schedules"></div></section><details class="monthly-section" id="email-options"><summary>Email notifications</summary><p class="hint">${config.emailReady ? "Verify a recipient before selecting it in a schedule. Emails contain a sign-in link, without financial values or client details." : "Sending is not configured yet. Monthly reports still save to the archive. Sender verification and email settings are required before notifications can be enabled."}</p><form id="recipient-form" class="report-controls"><label><span>Notification email</span><input type="email" name="email" value="${esc(config.accountEmail)}" required></label><button class="btn" type="submit" ${config.emailReady ? "" : "disabled"}>Send verification code</button></form><form id="confirm-recipient" class="report-controls"><label><span>Email to verify</span><input type="email" name="email" required></label><label><span>Verification code</span><input name="code" minlength="10" maxlength="10" autocomplete="one-time-code" required></label><button class="btn" type="submit">Verify email</button></form><p class="hint" id="recipient-result" role="status"></p><p class="hint">Verified: ${config.recipients.map((r) => esc(r.email)).join(", ") || "None yet"}</p>${config.verificationJobs.map((j) => `<p class="hint">${esc(j.recipient)}: ${esc(status(j.status))}${j.errorCode ? " (" + esc(j.errorCode) + ")" : ""}</p>`).join("")}</details><section class="monthly-section"><h2>Saved report archive</h2><div id="monthly-archive"></div><button class="btn" id="archive-more" ${offset === null ? "hidden" : ""}>Load older reports</button></section>`;
    $("#live-reports").onclick = openReports;
    $("#new-monthly").onclick = () => editor();
    $("#monthly-schedules").innerHTML =
      config.schedules
        .map(
          (s) =>
            `<article class="monthly-card"><div><h3>${esc(s.name)}</h3><p>${s.paused ? "Paused" : "Active"} · ${esc(String(Math.floor(s.minute / 60)).padStart(2, "0") + ":" + String(s.minute % 60).padStart(2, "0"))} on the 1st · Europe/Belgrade</p><p class="hint">${s.paused ? "Resuming will catch up on missed months." : `Next pending month: ${esc(s.nextMonth)}. Due: ${esc(stamp(s.nextRunAt))}.`} ${s.lastRunAt ? "Last saved: " + esc(stamp(s.lastRunAt)) : ""}</p><p class="hint">${s.notifications ? "Notify: " + esc(s.recipient) : "Archive only; email notifications off"}</p>${s.error ? `<p class="error" role="status">${esc(s.error === "incomplete_data" ? "The saved report has incomplete data. Open it for details." : s.error)}</p>` : ""}</div><div class="toolbar"><button class="btn" data-edit="${s.id}">Edit</button><button class="btn" data-pause="${s.id}">${s.paused ? "Resume" : "Pause"}</button><button class="btn" data-generate="${s.id}">Save a month now</button></div></article>`,
        )
        .join("") ||
      "<p>No monthly schedules yet. Create one using the filters you want to receive.</p>";
    root
      .querySelectorAll("[data-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            editor(config.schedules.find((s) => s.id === b.dataset.edit))),
      );
    root.querySelectorAll("[data-pause]").forEach(
      (b) =>
        (b.onclick = () =>
          action(b, async () => {
            const s = config.schedules.find((s) => s.id === b.dataset.pause);
            await api("/reports/monthly/" + s.id, {
              method: "PUT",
              body: { ...s, paused: !s.paused },
            });
            if (isCurrent()) await load();
          })),
    );
    root
      .querySelectorAll("[data-generate]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            generateForm(
              config.schedules.find((s) => s.id === b.dataset.generate),
            )),
      );
    $("#recipient-form").onsubmit = (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        to = form.elements.email.value;
      action(form.querySelector("button"), async () => {
        const r = await api("/reports/recipients/request", {
          method: "POST",
          body: { email: to },
        });
        if (!isCurrent() || !form.isConnected) return;
        $("#confirm-recipient").elements.email.value = to;
        $("#recipient-result").textContent =
          status(r.job.status) + ". Enter the code from the email below.";
      });
    };
    $("#confirm-recipient").onsubmit = (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        body = Object.fromEntries(new FormData(form));
      action(form.querySelector("button"), async () => {
        await api("/reports/recipients/confirm", { method: "POST", body });
        if (isCurrent()) await load();
      });
    };
    renderArchive();
    $("#archive-more").onclick = (e) =>
      action(e.currentTarget, async () => {
        const r = await api("/reports/archive?offset=" + offset);
        if (!isCurrent()) return;
        archive.push(...r.snapshots);
        offset = r.nextOffset;
        renderArchive();
        $("#archive-more").hidden = offset === null;
      });
  }
  function renderArchive() {
    $("#monthly-archive").innerHTML = archive.length
      ? `<div class="table-wrap"><table><thead><tr><th>Report</th><th>Month</th><th>Version</th><th>Saved</th><th>Status</th><th>Email</th><th></th></tr></thead><tbody>${archive.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.period)}</td><td>${r.version}</td><td>${esc(stamp(r.generated_at))}</td><td>${r.incomplete ? "Needs review" : "Ready"}</td><td>${esc(status(r.email_status))}${r.email_error ? "<br>" + esc(r.email_error) : ""}</td><td><button class="btn" data-snapshot="${r.id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
      : "<p>No saved monthly reports yet. Save a completed month from a schedule, or wait for its next scheduled run.</p>";
    root
      .querySelectorAll("[data-snapshot]")
      .forEach(
        (b) =>
          (b.onclick = () => action(b, () => openSnapshot(b.dataset.snapshot))),
      );
  }
  function editor(old) {
    const f = old?.filters ||
      initialFilters || {
        group: "therapist",
        dayBasis: "active",
        status: "all",
        requested: "all",
        therapist: "",
        service: "",
        bonuses: true,
      };
    const minutes = old?.minute ?? 540;
    $("#monthly-editor").innerHTML =
      `<form id="schedule-form" class="monthly-card"><h2>${old ? "Edit monthly schedule" : "New monthly schedule"}</h2><div class="report-controls"><label><span>Report name</span><input name="name" maxlength="80" value="${esc(old?.name || "Monthly therapist report")}" required></label><label><span>Time on the 1st (Belgrade)</span><input type="time" name="time" step="900" value="${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}" required></label>${select("therapist", "Therapist", Object.fromEntries([["", "All therapists"], ...catalogue.therapists.map((t) => [t.id, t.name])]), f.therapist)}${select("service", "Treatment", Object.fromEntries([["", "All treatments"], ...catalogue.services.map((s) => [s.id, s.name + " · " + s.duration + " min"])]), f.service)}${select("status", "Status", { all: "All statuses", booked: "Booked", confirmed: "Confirmed", done: "Completed", cancelled: "Cancelled", no_show: "No-show" }, f.status)}${select("requested", "Client request", { all: "All appointments", yes: "Requested", no: "Not requested" }, f.requested)}${select("group", "Group by", groups, f.group)}${select("dayBasis", "Average hours per day", { active: "Days with completed massages", calendar: "All calendar days" }, f.dayBasis)}${select("recipient", "Verified notification email", Object.fromEntries([["", "Choose a verified email"], ...config.recipients.map((r) => [r.email, r.email])]), old?.recipient || "")}</div><div class="toolbar"><label class="check"><input type="checkbox" name="bonuses" ${f.bonuses !== false ? "checked" : ""}>Include bonus columns</label><label class="check"><input type="checkbox" name="notifications" ${old?.notifications ? "checked" : ""} ${config.emailReady || old?.notifications ? "" : "disabled"}>Email me when ready</label><label class="check"><input type="checkbox" name="paused" ${old?.paused ? "checked" : ""}>Pause schedule</label></div><p class="hint">${old ? "Filter changes apply from the current month onward. Previously saved reports remain unchanged." : "The first automatic report covers the current month and saves on the 1st of next month. You can save last month manually now."} Pausing stops automatic generation and notifications.</p><div class="toolbar"><button class="btn primary" type="submit">Save schedule</button><button class="btn" type="button" id="cancel-schedule">Cancel</button></div></form>`;
    $("#monthly-editor").scrollIntoView({ block: "start" });
    $("#cancel-schedule").onclick = () =>
      $("#monthly-editor").replaceChildren();
    $("#schedule-form").onsubmit = (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        values = Object.fromEntries(new FormData(form)),
        [h, m] = values.time.split(":").map(Number);
      const body = {
        name: values.name,
        minute: h * 60 + m,
        filters: Object.fromEntries(
          ["therapist", "service", "status", "requested", "group", "dayBasis"]
            .map((k) => [k, values[k]])
            .concat([["bonuses", form.elements.bonuses.checked]]),
        ),
        paused: form.elements.paused.checked,
        notifications: form.elements.notifications.checked,
        recipient: values.recipient,
        revision: old?.revision,
      };
      action(form.querySelector('[type="submit"]'), async () => {
        await api("/reports/monthly" + (old ? "/" + old.id : ""), {
          method: old ? "PUT" : "POST",
          body,
        });
        if (isCurrent() && form.isConnected) await load();
      });
    };
  }
  function generateForm(s) {
    $("#monthly-editor").innerHTML =
      `<form id="generate-month" class="monthly-card"><h2>Save ${esc(s.name)}</h2><label><span>Completed month</span><input type="month" name="period" max="${lastMonth()}" value="${lastMonth()}" required></label><p class="hint">Uses the saved filters that applied to this month. If it is already archived, the existing version opens. ${s.notifications && !s.paused ? "A notification will be queued for the verified recipient." : "No email will be sent."}</p><div class="toolbar"><button type="submit" class="btn primary">Save report</button><button type="button" class="btn" id="cancel-generate">Cancel</button></div></form>`;
    $("#cancel-generate").onclick = () =>
      $("#monthly-editor").replaceChildren();
    $("#generate-month").onsubmit = (e) => {
      e.preventDefault();
      const form = e.currentTarget,
        period = form.elements.period.value;
      action(form.querySelector('[type="submit"]'), async () => {
        const r = await api("/reports/monthly/" + s.id + "/generate", {
          method: "POST",
          body: { period },
        });
        if (isCurrent() && form.isConnected) await openSnapshot(r.id);
      });
    };
  }
  async function openSnapshot(id) {
    const version = ++seq,
      r = await api("/reports/archive/" + encodeURIComponent(id));
    if (!isCurrent() || seq !== version) return;
    history.replaceState(null, "", "#report=" + encodeURIComponent(id));
    root.innerHTML = `<div class="toolbar"><button class="btn" id="back-archive">Monthly reports</button><button class="btn" id="revise-report">Create corrected version</button></div><h2>${esc(r.name)} · ${esc(r.period)} · Version ${r.version}</h2><p class="hint">Saved ${esc(stamp(r.generated_at))}. Data captured ${esc(stamp(r.cutoff_at))}. Template version ${r.template_revision}. ${r.supersedes_id ? "Replaces an earlier version; both remain in the archive." : ""}</p>${r.reason ? `<p>Correction reason: ${esc(r.reason)}</p>` : ""}<p>${esc(status(r.email_status))}${r.email_error ? " (" + esc(r.email_error) + ")" : ""}</p>${r.job_id && ["queued", "retry", "sending"].includes(r.email_status) ? `<button class="btn" id="retry-notification">Retry notification</button>` : ""}<p class="error" id="monthly-error" role="alert" hidden></p>${r.report.warnings.map((w) => `<p class="notice" role="status">${esc(w)}</p>`).join("")}<div class="toolbar" id="saved-exports">${["summary", "details", "comparison"].map((v) => `<button class="btn" data-csv="${v}">${v === "summary" ? "Summary" : v === "details" ? "Appointment list" : "Comparison"} CSV</button>`).join("")}</div><section id="revision-form"></section><section id="saved-report"></section>`;
    $("#back-archive").onclick = () => {
      history.replaceState(null, "", location.pathname);
      load().catch(error);
    };
    $("#revise-report").onclick = () => {
      $("#revision-form").innerHTML =
        `<form id="correct-month" class="monthly-card"><label><span>Reason for new version</span><input name="reason" maxlength="300" required></label><p class="hint">Recalculate this month using the same saved report filters and today's corrected source records. The old version remains available.</p><button class="btn primary">Save corrected version</button></form>`;
      const key = crypto.randomUUID();
      $("#correct-month").onsubmit = (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          reason = form.elements.reason.value;
        action(form.querySelector("button"), async () => {
          const next = await api("/reports/archive/" + id + "/revise", {
            method: "POST",
            body: { key, reason },
          });
          if (isCurrent() && form.isConnected) await openSnapshot(next.id);
        });
      };
    };
    if ($("#retry-notification"))
      $("#retry-notification").onclick = (e) =>
        action(e.currentTarget, async () => {
          await api("/reports/notifications/" + r.job_id + "/retry", {
            method: "POST",
            body: {},
          });
          if (isCurrent()) await openSnapshot(id);
        });
    root
      .querySelectorAll("[data-csv]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            action(b, () =>
              download(
                "view=" + b.dataset.csv,
                "/api/reports/archive/" + id + ".csv?",
              ),
            )),
      );
    if (r.report.error) $("#saved-report").textContent = r.report.error;
    else
      await renderReports(
        {
          ...ctx,
          root: $("#saved-report"),
          isCurrent: () => isCurrent() && version === seq,
          download: (q) => download(q, "/api/reports/archive/" + id + ".csv?"),
        },
        false,
        r.report,
      );
  }
  try {
    await load();
    if (!isCurrent()) return;
    if (initialId) await openSnapshot(initialId);
    else if (initialFilters) editor();
  } catch (e) {
    error(e);
  }
}
