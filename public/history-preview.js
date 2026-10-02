import {
  HISTORY_COLUMNS,
  HISTORY_PREVIEW_LIMITS,
  parseHistoryCSV,
  freshaHistoryPreset,
  validateHistoryMapping,
  historySourceValues,
  historyFileDigest,
  historyChunk,
  historyDispositionLabel,
  historyTime,
} from "./history-preview-helpers.js";

const BASE = "/history/previews";
const primaryFields = [
  "clientName",
  "serviceName",
  "scheduledDate",
  "slot",
  "duration",
  "status",
  "appointmentRef",
];
const formatOptions = {
  dateTimeFormat: [
    ["fresha-en", "04 Jan 2026, 9:00pm"],
    ["iso-local", "2026-01-04 21:00"],
    ["iso-date", "2026-01-04"],
    ["dmy-date", "04/01/2026 · day first"],
    ["mdy-date", "01/04/2026 · month first"],
  ],
  slotFormat: [
    ["HH:mm:ss-HH:mm:ss", "21:00:00–22:00:00"],
    ["HH:mm-HH:mm", "21:00–22:00"],
    ["HH:mm", "21:00"],
  ],
  durationFormat: [
    ["hours-minutes", "1h 0min / 30min"],
    ["minutes", "60 / 30 · minutes"],
  ],
};

/** Owner-only preview surface. The caller enforces owner navigation and session lifetime. */
export function renderHistoryPreview({
  root,
  api,
  esc,
  isCurrent,
  back,
  openProfile,
}) {
  let generation = 0,
    disposed = false,
    busy = false,
    parsed = null,
    fileInfo = null;
  let draft = null,
    resume = null,
    config = null,
    pageData = null,
    page = 0,
    retry = null;
  let selected = new Map(),
    searchGeneration = 0,
    selectedClient = null,
    choiceRequest = null,
    pendingUpload = null,
    importReview = null,
    importReviewRequest = null,
    importConfirmRequest = null,
    importPending = false;
  const live = (version = generation) =>
    !disposed && isCurrent() && version === generation;
  const $ = (id) => root.querySelector(`#${id}`);
  const safe = (value) => esc(String(value ?? ""));
  const route = (suffix = "") =>
    `${BASE}/${encodeURIComponent(draft.id)}${suffix}`;
  const number = (value) => Number(value || 0).toLocaleString("en-GB");
  const assertCurrent = (version) => {
    if (!live(version)) throw new Error("Preview preparation stopped.");
  };
  const setBusy = (value) => {
    busy = value;
    root.querySelectorAll("[data-history-busy]").forEach((control) => {
      control.disabled =
        value ||
        control.dataset.unavailable === "true" ||
        (importPending && !control.hasAttribute("data-history-import-retry"));
    });
    root.setAttribute("aria-busy", String(value));
  };
  const clearError = () => {
    $("history-error").hidden = true;
    $("history-retry").hidden = true;
    retry = null;
  };
  const showError = (error, action = null, label = "Try again") => {
    if (!live()) return;
    $("history-error-text").textContent =
      error.message || "The preview could not be prepared. Please try again.";
    $("history-error").hidden = false;
    retry = action;
    $("history-retry").hidden = !action;
    $("history-retry").textContent = label;
  };
  root.innerHTML = `<section class="history-preview">
    <div class="history-topline"><button class="btn" id="history-back">← Back to clients</button><span class="history-badge">Review before import</span></div>
    <p class="history-lead">Match clients, review original statuses, then confirm an import. Imported history is kept permanently; temporary previews expire after 24 hours.</p>
    <section class="history-card" id="history-file-card"><h2>Choose appointment history</h2><p class="hint" id="history-file-note">One UTF-8 CSV · up to 50,000 rows / 25 MiB. No manual splitting.</p>
      <form id="history-file-form"><div class="fields">
        <label class="wide"><span>Appointment CSV</span><input type="file" id="history-csv" accept=".csv,.tsv,text/csv,text/tab-separated-values" required data-history-busy></label>
        <label><span>File source</span><input id="history-source" value="fresha" maxlength="100" required data-history-busy><small class="history-sample">Use the same source label for exports from the same system.</small></label>
        <label><span>Separator</span><select id="history-delimiter" data-history-busy><option value="auto">Detect automatically</option><option value=",">Comma</option><option value=";">Semicolon</option><option value="tab">Tab</option></select></label>
      </div><div class="history-actions"><button class="btn primary" id="history-read-columns" type="submit" data-history-busy>Read columns</button><button class="btn" id="history-cancel-resume" type="button" data-history-busy hidden>Choose another file</button></div></form>
    </section><section id="history-recent" class="history-card" aria-label="Recent history previews"><h3>Recent previews</h3><p class="hint" role="status">Loading saved previews…</p></section>
    <div id="history-error" class="history-error" role="alert" hidden><p id="history-error-text"></p><button class="btn" id="history-retry" type="button" hidden>Try again</button></div>
    <div id="history-import-result"></div>
    <div id="history-work"></div></section>`;
  $("history-back").onclick = () => {
    generation++;
    back();
  };
  $("history-retry").onclick = () => {
    if (!busy && retry) {
      const action = retry;
      clearError();
      action();
    }
  };
  $("history-file-form").onsubmit = readFile;
  $("history-cancel-resume").onclick = reset;
  loadRecent();

  async function loadRecent() {
    const version = generation;
    try {
      const result = await api(BASE);
      if (!live(version)) return;
      $("history-recent").innerHTML =
        `<h3>Recent previews</h3>${result.previews?.length ? `<p class="hint">Continue a saved review. Draft client choices are kept until the preview expires.</p>${result.previews.map((item) => `<div class="history-candidate"><strong>${safe(item.source)} · ${number(item.total)} rows</strong><p>${item.phase === "ready" ? "Ready to review" : `${number(item.uploaded)} rows prepared`} · expires ${safe(expiry(item.expiresAt))}</p><button class="btn" data-history-open="${safe(item.id)}" data-history-busy>${item.phase === "ready" ? "Open preview" : "Continue preparation"}</button></div>`).join("")}` : `<p class="hint">No saved previews yet.</p>`}`;
      $("history-recent")
        .querySelectorAll("[data-history-open]")
        .forEach((button) => {
          button.onclick = () => openRecent(button.dataset.historyOpen);
        });
    } catch (error) {
      if (live(version))
        $("history-recent").innerHTML =
          `<h3>Recent previews</h3><p class="hint">Saved previews could not be loaded. You can still choose a CSV.</p><button class="btn" id="history-reload-recent">Try again</button>`;
      if (live(version)) $("history-reload-recent").onclick = loadRecent;
    }
  }
  function expiry(value) {
    const date = new Date(value);
    return Number.isFinite(date.valueOf())
      ? date.toLocaleString("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "at the time shown by the server";
  }
  async function openRecent(id) {
    if (busy) return;
    const version = ++generation;
    clearError();
    setBusy(true);
    try {
      const meta = await api(`${BASE}/${encodeURIComponent(id)}`);
      if (!live(version)) return;
      draft = meta;
      selected.clear();
      config = meta.config;
      page = 0;
      if (meta.phase === "ready") await loadPage(0, version);
      else if (meta.uploaded >= meta.total) {
        parsed = null;
        await prepare(version);
      } else {
        resume = meta;
        $("history-work").innerHTML = "";
        $("history-file-card").hidden = false;
        $("history-recent").hidden = true;
        $("history-file-note").textContent =
          "Select the original CSV to continue this saved upload. Your column choices are retained.";
        $("history-source").value = meta.source;
        $("history-source").readOnly = true;
        $("history-read-columns").textContent = "Read and resume";
        $("history-cancel-resume").hidden = false;
        $("history-csv").focus();
      }
    } catch (error) {
      if (live(version)) showError(error, () => openRecent(id));
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  async function readFile(event) {
    event.preventDefault();
    if (busy || importPending) return;
    const file = $("history-csv").files[0];
    if (!file) return;
    $("history-import-result").innerHTML = "";
    const version = ++generation;
    clearError();
    setBusy(true);
    try {
      if (file.size > HISTORY_PREVIEW_LIMITS.bytes)
        throw new Error("Choose a CSV file of 25 MiB or smaller.");
      const bytes = await file.arrayBuffer();
      assertCurrent(version);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save this file as UTF-8 CSV, then choose it again.");
      }
      const data = parseHistoryCSV(
        text,
        $("history-delimiter").value === "tab"
          ? "\t"
          : $("history-delimiter").value,
      );
      const fileDigest = await historyFileDigest(bytes);
      assertCurrent(version);
      if (
        resume &&
        (fileDigest !== resume.fileDigest || data.rows.length !== resume.total)
      )
        throw new Error(
          "This is a different file. Choose the original CSV to resume this preview.",
        );
      if (
        resume &&
        JSON.stringify(data.headers) !== JSON.stringify(resume.config.headers)
      )
        throw new Error(
          "These columns differ from the saved preview. Use the original file and separator.",
        );
      parsed = data;
      fileInfo = {
        name: file.name,
        fileBytes: file.size,
        fileDigest,
        source: $("history-source").value.trim(),
      };
      selected.clear();
      pageData = null;
      $("history-file-card").hidden = true;
      $("history-recent").hidden = true;
      if (resume) {
        draft = resume;
        config = resume.config;
        resume = null;
        await prepare(version);
      } else {
        draft = null;
        config = null;
        mappingView();
      }
    } catch (error) {
      if (live(version)) showError(error);
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  function columnControl(key, mapping) {
    return `<label><span>${HISTORY_COLUMNS[key]}${["scheduledDate", "duration"].includes(key) ? " *" : ""}</span><select name="${key}" data-history-column="${key}" data-history-busy><option value="">Not supplied</option>${parsed.headers.map((header, index) => `<option value="${index}" ${mapping[key] === index ? "selected" : ""}>${index + 1}. ${safe(header)}</option>`).join("")}</select><small class="history-sample" data-history-sample="${key}"></small></label>`;
  }
  function formatControl(name, title, value) {
    return `<label><span>${title}</span><select id="history-${name}" data-history-busy><option value="">Choose format</option>${formatOptions[name].map(([key, label]) => `<option value="${key}" ${value === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
  }
  function mappingView(preset = null) {
    const suggestion = preset || freshaHistoryPreset(parsed.headers);
    const mapping = config?.mapping || suggestion.mapping;
    const hasFresha = ["scheduledDate", "duration", "appointmentRef"].every(
      (field) => suggestion.mapping[field] != null,
    );
    const formats = config?.format || (hasFresha ? suggestion.format : {});
    $("history-work").innerHTML =
      `<section class="history-card"><h2>Review columns</h2><p class="hint">${safe(fileInfo.name)} · ${number(parsed.rows.length)} appointment rows. Check each match against its example.</p>
      <div class="history-actions"><button class="btn" id="history-use-fresha" data-history-busy>Use Fresha column preset</button><button class="btn" id="history-change-file" data-history-busy>Choose another file</button></div>
      <form id="history-map"><div class="fields">${primaryFields.map((key) => columnControl(key, mapping)).join("")}</div>
      <details class="history-advanced" id="history-advanced"><summary>Advanced · formats, identity and source evidence</summary><div>
        <section class="history-section"><h3>Date and time formats</h3><div class="fields">${formatControl("dateTimeFormat", "Date format", formats.dateTimeFormat)}${formatControl("slotFormat", "Appointment time format", formats.slotFormat)}${formatControl("durationFormat", "Duration format", formats.durationFormat)}
        <label><span>Source timezone</span><select id="history-timezone" data-history-busy><option value="">Not confirmed</option><option value="Europe/Belgrade">Europe/Belgrade · confirmed</option><option value="UTC">UTC · confirmed</option><option value="custom">Another confirmed timezone</option></select></label><label id="history-timezone-other-label" hidden><span>Timezone name</span><input id="history-timezone-other" placeholder="Europe/London" maxlength="100" data-history-busy></label></div><p class="hint">The salon timezone does not prove the export timezone. Leave it unconfirmed if you do not know.</p></section>
        <section class="history-section"><h3>Optional columns</h3><div class="fields">${Object.keys(
          HISTORY_COLUMNS,
        )
          .filter((key) => !primaryFields.includes(key))
          .map((key) => columnControl(key, mapping))
          .join("")}</div></section>
        <section class="history-section"><h3>Status meaning</h3><p class="hint">Past dates, New, Confirmed and Started do not prove completion. Only choose Completed when you have verified what that source status means.</p><div class="fields" id="history-status-map"></div><div class="fields" id="history-request-map"></div></section>
        <section class="history-section"><h3>Source amounts</h3><p class="hint">Net sales are preserved separately. They do not establish the full price, payment received or a therapist bonus.</p><div class="fields">
          <label><span>Source currency</span><select id="history-currency" data-history-busy><option value="">Not confirmed</option><option value="RSD">RSD · confirmed</option><option value="EUR">EUR · confirmed</option><option value="custom">Another confirmed currency</option></select></label><label id="history-currency-other-label" hidden><span>Three-letter currency</span><input id="history-currency-other" maxlength="3" placeholder="USD" data-history-busy></label>
          <label><span>Currency decimal places</span><select id="history-minor-units" data-history-busy><option value="">Not confirmed</option>${[0, 1, 2, 3, 4].map((value) => `<option value="${value}">${value}</option>`).join("")}</select></label>
          <label><span>Decimal separator</span><select id="history-decimal" data-history-busy><option value=".">Dot · 4700.00</option><option value=",">Comma · 4700,00</option></select></label><label><span>Thousands separator</span><select id="history-group" data-history-busy><option value="">None</option><option value=",">Comma</option><option value=".">Dot</option><option value=" ">Space</option></select></label></div></section>
        <section class="history-section"><h3>Reference meaning</h3><label><span>How does the source identify each service?</span><select id="history-reference-mode" data-history-busy><option value="unverified">Not verified · review overlapping exports</option><option value="verified-appointment">Verified: one service per appointment reference</option><option value="service-line">Verified: appointment + unique service-line reference</option></select></label><p class="hint">A reference appearing once in this file is not proof that it always identifies one service.</p></section>
      </div></details><p class="history-format-note">Missing values stay unknown. Names are suggestions and never link history automatically.</p><div class="history-actions"><button class="btn primary" id="history-build-preview" type="submit" data-history-busy>Prepare preview</button></div></form></section>`;
    $("history-change-file").onclick = reset;
    $("history-use-fresha").onclick = () => {
      config = null;
      mappingView(freshaHistoryPreset(parsed.headers));
    };
    $("history-timezone").onchange = () => {
      $("history-timezone-other-label").hidden =
        $("history-timezone").value !== "custom";
    };
    $("history-currency").onchange = () => {
      $("history-currency-other-label").hidden =
        $("history-currency").value !== "custom";
    };
    const format = formats;
    for (const [id, value] of [
      ["history-timezone", format.sourceTimeZone],
      ["history-currency", format.money?.currency],
    ])
      if (value) {
        const select = $(id);
        select.value = [...select.options].some(
          (option) => option.value === value,
        )
          ? value
          : "custom";
        if (select.value === "custom") {
          $(`${id}-other`).value = value;
          $(`${id}-other-label`).hidden = false;
        }
      }
    if (format.money?.minorUnitDigits != null)
      $("history-minor-units").value = String(format.money.minorUnitDigits);
    $("history-decimal").value = format.money?.decimalSeparator || ".";
    $("history-group").value = format.money?.groupSeparator || "";
    $("history-reference-mode").value = config?.referenceMode || "unverified";
    function samples() {
      root.querySelectorAll("[data-history-column]").forEach((control) => {
        const sample = root.querySelector(
          `[data-history-sample="${control.dataset.historyColumn}"]`,
        );
        sample.textContent =
          control.value === ""
            ? ""
            : `Example: ${parsed.rows[0]?.[Number(control.value)] || "(empty)"}`;
      });
    }
    function sourceChoices(field, target, choices, initial = {}) {
      const control = root.querySelector(`[data-history-column="${field}"]`);
      const old = Object.fromEntries(
        [...$(target).querySelectorAll("select")].map((select) => [
          select.dataset.sourceValue,
          select.value,
        ]),
      );
      const values = historySourceValues(
        parsed,
        control.value === "" ? null : Number(control.value),
      );
      $(target).innerHTML = values.length
        ? values
            .map(
              (value) =>
                `<label><span>${safe(value)}</span><select data-source-value="${safe(value)}" data-history-busy>${choices.map(([key, label]) => `<option value="${key}" ${(old[value] ?? initial[value] ?? (field === "status" && ["Cancelled", "No Show"].includes(value) ? "not_completed" : "unknown")) === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>`,
            )
            .join("")
        : `<p class="hint">${field === "status" ? "Status" : "Requested therapist"} is not supplied.</p>`;
    }
    const meanings = () => {
      sourceChoices(
        "status",
        "history-status-map",
        [
          ["unknown", "Completion unknown"],
          ["not_completed", "Not completed"],
          ["completed", "Completed · verified meaning"],
        ],
        formats.completionMap,
      );
      sourceChoices(
        "requested",
        "history-request-map",
        [
          ["unknown", "Request unknown"],
          ["yes", "Yes · requested"],
          ["no", "No · not requested"],
        ],
        formats.requestMap,
      );
    };
    root.querySelectorAll("[data-history-column]").forEach((control) => {
      control.onchange = () => {
        clearError();
        try {
          samples();
          meanings();
        } catch (error) {
          showError(error);
        }
      };
    });
    samples();
    try {
      meanings();
    } catch (error) {
      showError(error);
    }
    $("history-map").onsubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      clearError();
      try {
        const mapping = validateHistoryMapping(
          Object.fromEntries(
            [...root.querySelectorAll("[data-history-column]")]
              .filter((control) => control.value !== "")
              .map((control) => [
                control.dataset.historyColumn,
                Number(control.value),
              ]),
          ),
          parsed.headers.length,
        );
        const format = {};
        for (const key of Object.keys(formatOptions))
          if ($(`history-${key}`).value)
            format[key] = $(`history-${key}`).value;
        if (
          !format.dateTimeFormat ||
          !format.durationFormat ||
          (mapping.slot != null && !format.slotFormat)
        )
          throw new Error(
            "Choose the date, time and duration formats in Advanced.",
          );
        const chosen = (id) =>
          $(id).value === "custom"
            ? $(`${id}-other`).value.trim()
            : $(id).value;
        format.sourceTimeZone = chosen("history-timezone") || null;
        format.money = {
          currency: chosen("history-currency").toUpperCase() || null,
          minorUnitDigits:
            $("history-minor-units").value === ""
              ? null
              : Number($("history-minor-units").value),
          decimalSeparator: $("history-decimal").value,
          groupSeparator: $("history-group").value || null,
        };
        format.completionMap = Object.fromEntries(
          [...$("history-status-map").querySelectorAll("select")].map(
            (control) => [control.dataset.sourceValue, control.value],
          ),
        );
        format.requestMap = Object.fromEntries(
          [...$("history-request-map").querySelectorAll("select")].map(
            (control) => [control.dataset.sourceValue, control.value],
          ),
        );
        config = {
          headers: parsed.headers,
          mapping,
          format,
          referenceMode: $("history-reference-mode").value,
        };
        draft = null;
        await prepare(++generation);
      } catch (error) {
        if (live()) {
          $("history-advanced") && ($("history-advanced").open = true);
          showError(error);
        }
      }
    };
  }

  async function prepare(version = ++generation) {
    clearError();
    setBusy(true);
    $("history-file-card").hidden = true;
    $("history-recent").hidden = true;
    $("history-work").innerHTML =
      `<section class="history-card"><h2>Preparing your preview</h2><p class="hint">Keep this page open. No appointments are being imported.</p><progress id="history-progress" class="history-progress" max="${draft?.total || parsed?.rows.length || 1}" value="${draft?.uploaded || 0}"></progress><p id="history-progress-text" class="history-progress-text" role="status">Starting…</p><div class="history-actions"><button class="btn" id="history-cancel-upload">Cancel preparation</button>${parsed ? `<button class="btn" id="history-back-columns">Back to columns</button>` : ""}<button class="btn" id="history-preparation-files">Choose another file</button></div></section>`;
    $("history-preparation-files").onclick = reset;
    if ($("history-back-columns"))
      $("history-back-columns").onclick = () => {
        generation++;
        setBusy(false);
        clearError();
        draft = null;
        mappingView();
      };
    $("history-cancel-upload").onclick = () => {
      generation++;
      setBusy(false);
      $("history-progress-text").textContent =
        "Preparation stopped. Your saved preview can be resumed.";
      $("history-cancel-upload").disabled = true;
      showError(
        new Error("Nothing was imported. Resume when you are ready."),
        () => prepare(++generation),
        "Resume preparation",
      );
    };
    try {
      if (!draft) {
        const created = await api(`${BASE}/start`, {
          method: "POST",
          body: {
            ...config,
            source: fileInfo.source,
            fileDigest: fileInfo.fileDigest,
            fileBytes: fileInfo.fileBytes,
            total: parsed.rows.length,
          },
        });
        assertCurrent(version);
        draft = created;
      }
      while (draft.uploaded < draft.total) {
        assertCurrent(version);
        if (!parsed)
          throw new Error("Choose the original CSV to continue this upload.");
        if (
          !pendingUpload ||
          pendingUpload.id !== draft.id ||
          pendingUpload.offset !== draft.uploaded
        )
          pendingUpload = {
            id: draft.id,
            offset: draft.uploaded,
            rows: historyChunk(parsed, config.mapping, draft.uploaded, 100),
          };
        const rows = pendingUpload.rows;
        $("history-progress-text").textContent =
          `Preparing rows ${number(draft.uploaded)} of ${number(draft.total)}…`;
        let updated;
        try {
          updated = await api(route("/upload"), {
            method: "POST",
            body: { offset: pendingUpload.offset, rows },
          });
        } catch (error) {
          assertCurrent(version);
          if (error.status === 413 && rows.length > 1) {
            pendingUpload.rows = rows.slice(
              0,
              Math.max(1, Math.floor(rows.length / 2)),
            );
            continue;
          }
          throw error;
        }
        assertCurrent(version);
        if (
          !Number.isInteger(updated.uploaded) ||
          updated.uploaded < draft.uploaded + rows.length ||
          updated.uploaded > draft.total
        )
          throw new Error(
            "The upload did not confirm this group of rows. Retry preparation safely.",
          );
        draft = { ...draft, ...updated };
        pendingUpload = null;
        $("history-progress").value = draft.uploaded;
      }
      for (let attempt = 0; draft.phase !== "ready"; attempt++) {
        assertCurrent(version);
        if (attempt >= 1000)
          throw new Error(
            "Preparation is taking longer than expected. Resume to continue safely.",
          );
        $("history-progress-text").textContent =
          draft.phase === "indexing"
            ? `Checking current client matches… ${number(draft.indexedClients)} profiles checked.`
            : "Checking source rows and possible client matches…";
        const updated = await api(route("/finalize"), {
          method: "POST",
          body: {},
        });
        assertCurrent(version);
        draft = { ...draft, ...updated };
      }
      await loadPage(0, version);
    } catch (error) {
      if (live(version)) {
        showError(error, () => prepare(++generation), "Retry preparation");
      }
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  async function loadPage(next, version = ++generation, afterImport = false) {
    clearError();
    setBusy(true);
    try {
      const data = await api(route(`/page?page=${next}`));
      assertCurrent(version);
      draft = { ...draft, ...data };
      pageData = data;
      page = data.page ?? next;
      selectedClient = null;
      choiceRequest = null;
      searchGeneration++;
      $("history-file-card").hidden = true;
      $("history-recent").hidden = true;
      previewView();
    } catch (error) {
      if (live(version)) {
        if (afterImport && [404, 410].includes(error.status)) {
          $("history-work").innerHTML =
            `<section class="history-card"><h2>History is saved</h2><p>The temporary preview has expired or was removed. Imported records are still saved in each client’s history.</p><button class="btn" id="history-after-import-new-file" data-history-busy>Choose another file</button></section>`;
          $("history-after-import-new-file").onclick = reset;
        } else {
          showError(
            afterImport
              ? new Error(
                  `Import completed. The remaining preview could not be refreshed. ${error.message || "Please try again."}`,
                )
              : error,
            error.status === 409
              ? rebuild
              : () => loadPage(next, ++generation, afterImport),
            error.status === 409 ? "Rebuild preview" : "Try again",
          );
        }
      }
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  function facts(items) {
    return `<dl class="history-facts">${items.map(([key, value]) => `<dt>${safe(key)}</dt><dd>${safe(value ?? "Unknown")}</dd>`).join("")}</dl>`;
  }
  function contacts(client) {
    return (
      [
        client.phone,
        client.email,
        client.instagram ? `@${client.instagram.replace(/^@/, "")}` : null,
      ]
        .filter(Boolean)
        .map(safe)
        .join(" · ") || "No contact details supplied"
    );
  }
  function sourceAmount(record) {
    const digits = record.interpretation?.money?.minorUnitDigits;
    return Number.isSafeInteger(record.sourceNetSalesMinor) &&
      record.currency &&
      Number.isInteger(digits)
      ? `${record.currency} ${(record.sourceNetSalesMinor / 10 ** digits).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
      : "Unknown";
  }
  function detailHTML(entry) {
    const record = entry.record;
    const overlapCount = new Set([
      ...(entry.nativeOverlapIds || []),
      ...(entry.draftChoice?.nativeOverlapIds || []),
    ]).size;
    return `<div class="history-row-detail" id="history-row-detail-${entry.row}" hidden>
      ${entry.draftChoice ? `<p class="history-format-note">Draft match: <strong>${safe(entry.draftChoice.name)}</strong>${entry.draftChoice.stale ? " · This profile changed. Choose it again after reviewing its current details." : ". This choice does not create a permanent link."}</p>` : ""}
      ${entry.draftChoice?.client ? `<p class="hint">${contacts(entry.draftChoice.client)}</p>` : ""}
      ${overlapCount ? `<p class="history-format-note">Possible overlap with ${number(overlapCount)} existing appointment(s). Review it before combining this history.</p>` : ""}
      <div class="history-detail-grid"><section><h3>Source appointment</h3>${facts(
        [
          ["Date", record.scheduledLocalDate],
          ["Time", historyTime(record.startMinute, record.durationMinutes)],
          [
            "Duration",
            record.durationMinutes == null
              ? null
              : `${record.durationMinutes} min`,
          ],
          ["Treatment", record.sourceServiceLabel],
          ["Therapist", record.sourceTherapistLabel],
          ["Room", record.sourceRoomLabel],
          ["Source status", record.sourceStatus],
          [
            "Completion",
            {
              completed: "Completed",
              not_completed: "Not completed",
              unknown: "Unknown",
            }[record.completionState],
          ],
          [
            "Requested therapist",
            { yes: "Yes", no: "No", unknown: "Unknown" }[record.requestState],
          ],
          ["Source timezone", record.sourceTimeZone],
          ["Source net sales", sourceAmount(record)],
          [
            "Full price / payment / bonus",
            "Unavailable unless established separately",
          ],
        ],
      )}</section>
      <section><h3>Client matches to review</h3><p class="hint">A matching name alone does not identify a client.</p>${entry.candidates?.length ? entry.candidates.map((candidate) => `<div class="history-candidate"><strong>${safe(candidate.name)}</strong><p>${contacts(candidate)}</p><div class="history-actions"><button class="btn" data-history-profile="${safe(candidate.id)}" data-history-busy>Open profile</button><button class="btn" data-history-use-candidate="${safe(candidate.id)}" data-history-candidate-row="${entry.row}" data-history-busy>Choose for selected rows</button></div></div>`).join("") : `<p class="hint">No unique candidate is available. Search current clients to make an explicit draft choice.</p>`}</section></div>
      ${entry.issues?.length ? `<h3>Review notes</h3><ul class="history-issues">${entry.issues.map((issue) => `<li>${safe(issue.message)}</li>`).join("")}</ul>` : ""}
      ${entry.duplicateOf ? `<p class="hint">This source row repeats content already represented in the ${entry.duplicateOf.kind === "preview-row" ? "preview" : "historical archive"}. It will not be counted twice.</p>` : ""}
      <details><summary>Original source values</summary>${facts(Object.entries(record.raw || {}).map(([key, value]) => [HISTORY_COLUMNS[key] || key, value == null ? "Not supplied" : value === "" ? "(empty)" : value]))}</details></div>`;
  }
  function previewView() {
    const rows = pageData.rows || [];
    const summary = pageData.summary || {};
    const pages = Math.max(
      1,
      Math.ceil(draft.total / (pageData.pageSize || 50)),
    );
    const counts = Object.fromEntries(
      ["ready", "unresolved", "conflict", "duplicate", "invalid"].map(
        (status) => [
          status,
          rows.filter((entry) => entry.disposition === status).length,
        ],
      ),
    );
    $("history-work").innerHTML =
      `<section class="history-card"><h2>Review appointment history</h2><p class="hint">${number(draft.total)} source rows · ${number(summary.draftChoices)} draft client choices · expires ${safe(expiry(draft.expiresAt))}</p>
      <div class="history-actions"><button class="btn" id="history-new-file" data-history-busy>Choose another file</button><button class="btn" id="history-refresh" data-history-busy>Refresh review</button><button class="btn" id="history-discard" data-history-busy>Discard preview</button></div>
      <div id="history-summary"><p class="history-readiness">On this page</p><div class="history-counts">${Object.entries(
        counts,
      )
        .map(
          ([key, value]) =>
            `<div class="history-count"><strong>${number(value)}</strong><span>${historyDispositionLabel(key)}</span></div>`,
        )
        .join("")}</div>
      <p class="hint">Across the file: ${number(summary.invalidRows)} invalid rows, ${number(summary.sourceConflictRows)} source conflicts and ${number(summary.duplicateRows)} duplicate rows.</p>
      <details><summary>Unknown values on this page</summary>${facts(Object.entries(pageData.pageSummary?.unknown || {}).map(([key, value]) => [{ completion: "Completion", request: "Requested therapist", sourceTimeZone: "Timezone", sourceNetSales: "Source net sales", currency: "Currency", fullPrice: "Full price", paidAmount: "Payment", bonusRule: "Bonus rule", bonusAmount: "Bonus amount" }[key] || key, `${number(value)} rows`]))}</details></div>
      <div class="history-selection"><strong id="history-selected-count">0 rows selected</strong><button class="btn" id="history-select-page" data-history-busy>Select this page</button><button class="btn" id="history-clear-selection" data-history-busy>Clear selection</button><button class="btn" id="history-choose-client" data-history-busy>Choose client</button><button class="btn" id="history-clear-choices" data-history-busy>Clear draft matches</button><button class="btn primary" id="history-review-import" data-history-busy>Review import</button><p id="history-selected-dates">Select up to 50 rows to review a client choice or import together.</p></div>
      <div id="history-choice-panel" hidden></div><div id="history-import-review" hidden></div><div id="history-rows">${rows.map((entry) => `<article class="history-record" data-history-row="${entry.row}"><div class="history-record-head"><label class="history-row-check"><input type="checkbox" data-history-select="${entry.row}" aria-label="Select history row ${entry.row}: ${safe(entry.record.sourceClientLabel || "Unknown client")}" ${selected.has(entry.row) ? "checked" : ""} data-history-busy></label><div class="history-record-title"><strong>${safe(entry.record.sourceClientLabel || "Client unknown")}</strong><small>Row ${entry.row} · ${safe(entry.record.scheduledLocalDate || "Date unknown")} · ${safe(historyTime(entry.record.startMinute, entry.record.durationMinutes))}</small>${entry.draftChoice ? `<small>Draft match: ${safe(entry.draftChoice.name)}${entry.draftChoice.stale ? " · review changed profile" : ""}</small>` : ""}</div><div class="history-record-treatment"><strong>${safe(entry.record.sourceServiceLabel || "Treatment unknown")}</strong><small>${safe(entry.record.sourceTherapistLabel || "Therapist unknown")}</small><small class="history-original-status">Original status: ${safe(entry.record.sourceStatus ?? "Unknown")}</small></div><span class="history-result" data-result="${safe(entry.disposition)}">${historyDispositionLabel(entry.disposition)}</span><button class="btn history-record-action" data-history-details="${entry.row}" aria-expanded="false" aria-controls="history-row-detail-${entry.row}">Details</button></div>${detailHTML(entry)}</article>`).join("") || `<p class="history-empty">No source rows on this page.</p>`}</div>
      <div class="history-pagination"><button class="btn" id="history-prev" data-history-busy data-unavailable="${page === 0}" ${page === 0 ? "disabled" : ""}>Previous</button><span>Page ${page + 1} of ${pages} · ${number(rows.length)} rows</span><button class="btn" id="history-next" data-history-busy data-unavailable="${page + 1 >= pages}" ${page + 1 >= pages ? "disabled" : ""}>Next</button></div><p class="history-readiness">Draft matches stay in this preview. Review import is a separate step before any records are saved.</p></section>`;
    $("history-new-file").onclick = reset;
    $("history-refresh").onclick = () => {
      if (!busy) loadPage(page);
    };
    $("history-discard").onclick = discard;
    $("history-prev").onclick = () => {
      if (!busy) loadPage(page - 1);
    };
    $("history-next").onclick = () => {
      if (!busy) loadPage(page + 1);
    };
    $("history-select-page").onclick = () => {
      const next = new Map([
        ...selected,
        ...rows.map((entry) => [entry.row, entry.record.scheduledLocalDate]),
      ]);
      if (next.size > 50) {
        showError(
          new Error(
            "Select up to 50 rows at a time. Clear the earlier selection to choose this page.",
          ),
        );
        return;
      }
      selected = next;
      updateSelection();
    };
    $("history-clear-selection").onclick = () => {
      selected.clear();
      updateSelection();
    };
    $("history-choose-client").onclick = () => {
      if (selected.size) choicePanel();
    };
    $("history-clear-choices").onclick = () => {
      if (selected.size) saveChoices(null);
    };
    $("history-review-import").onclick = reviewImport;
    root.querySelectorAll("[data-history-select]").forEach((control) => {
      control.onchange = () => {
        const row = Number(control.dataset.historySelect);
        if (control.checked && selected.size >= 50) {
          control.checked = false;
          showError(
            new Error(
              "Select up to 50 rows at a time. Review this group, then continue.",
            ),
          );
          return;
        }
        control.checked
          ? selected.set(
              row,
              rows.find((entry) => entry.row === row).record.scheduledLocalDate,
            )
          : selected.delete(row);
        updateSelection();
      };
    });
    root.querySelectorAll("[data-history-details]").forEach((button) => {
      button.onclick = () => {
        const detail = $(`history-row-detail-${button.dataset.historyDetails}`);
        detail.hidden = !detail.hidden;
        button.setAttribute("aria-expanded", String(!detail.hidden));
      };
    });
    root.querySelectorAll("[data-history-profile]").forEach((button) => {
      button.onclick = () => {
        if (busy) return;
        generation++;
        openProfile(button.dataset.historyProfile);
      };
    });
    root.querySelectorAll("[data-history-use-candidate]").forEach((button) => {
      button.onclick = () => {
        const entry = rows.find(
          (item) => item.row === Number(button.dataset.historyCandidateRow),
        );
        if (!selected.size)
          selected.set(entry.row, entry.record.scheduledLocalDate);
        updateSelection();
        choicePanel(
          entry.candidates.find(
            (candidate) => candidate.id === button.dataset.historyUseCandidate,
          ),
        );
      };
    });
    updateSelection();
  }
  function updateSelection() {
    selectedClient = null;
    choiceRequest = null;
    searchGeneration++;
    clearImportReview();
    if ($("history-choice-panel")) $("history-choice-panel").hidden = true;
    $("history-selected-count").textContent =
      `${number(selected.size)} rows selected`;
    const dates = [...new Set(selected.values())].filter(Boolean).sort();
    $("history-selected-dates").textContent = selected.size
      ? `Selected dates: ${dates[0] || "unknown"}${dates.length > 1 ? ` to ${dates.at(-1)}` : ""}. Choices apply only to these ${number(selected.size)} rows.`
      : "Select up to 50 rows to review a client choice together.";
    root.querySelectorAll("[data-history-select]").forEach((control) => {
      control.checked = selected.has(Number(control.dataset.historySelect));
    });
    for (const id of [
      "history-choose-client",
      "history-clear-choices",
      "history-clear-selection",
      "history-review-import",
    ]) {
      $(id).dataset.unavailable = String(!selected.size);
      $(id).disabled = busy || !selected.size;
    }
  }
  function choicePanel(candidate = null) {
    clearError();
    selectedClient = candidate;
    choiceRequest = null;
    const panel = $("history-choice-panel");
    panel.hidden = false;
    panel.className = "history-choice-panel";
    panel.innerHTML = `<h3>Choose a client for ${number(selected.size)} selected rows</h3><p class="hint">Check the name and contact details. This saves a choice in this preview only.</p><form id="history-client-search-form"><div class="fields"><label class="wide"><span>Find a current client</span><input type="search" id="history-client-search" placeholder="Name, phone, email or Instagram" maxlength="100" data-history-busy></label></div><button class="btn" id="history-client-search-button" data-history-busy>Search clients</button></form><div id="history-client-results" class="history-choice-list"></div><p id="history-choice-summary" class="history-format-note" hidden></p><div class="history-actions"><button class="btn primary" id="history-apply-choice" data-history-busy data-unavailable="true" disabled>Save draft match</button><button class="btn" id="history-cancel-choice" data-history-busy>Cancel</button></div>`;
    const selectClient = (client) => {
      selectedClient = client;
      choiceRequest = null;
      $("history-choice-summary").hidden = false;
      $("history-choice-summary").textContent =
        `Apply ${client.name} to these ${selected.size} selected rows. No permanent client link or appointment will be created.`;
      $("history-apply-choice").dataset.unavailable = "false";
      $("history-apply-choice").disabled = busy;
    };
    let searchPage = 0,
      searchQuery = "";
    const renderClients = (clients, hasMore, append = false) => {
      const content = clients
        .map(
          (client, index) =>
            `<label class="history-choice-option"><input type="radio" name="history-client-choice" value="${index}" data-history-client-id="${safe(client.id)}" data-history-busy ${selectedClient?.id === client.id ? "checked" : ""}><span><strong>${safe(client.name)}</strong><small>${contacts(client)}</small></span></label>`,
        )
        .join("");
      $("history-client-results")
        .querySelector("#history-more-clients")
        ?.remove();
      if (append)
        $("history-client-results").insertAdjacentHTML("beforeend", content);
      else
        $("history-client-results").innerHTML =
          content ||
          `<p class="hint">No matching clients. Try a different name or contact.</p>`;
      if (hasMore)
        $("history-client-results").insertAdjacentHTML(
          "beforeend",
          `<button class="btn" id="history-more-clients" type="button">More clients</button>`,
        );
      for (const client of clients) {
        const radio = [
          ...$("history-client-results").querySelectorAll(
            "[data-history-client-id]",
          ),
        ].find((input) => input.dataset.historyClientId === client.id);
        if (radio) radio.onchange = () => selectClient(client);
      }
      if (hasMore)
        $("history-more-clients").onclick = () =>
          searchClients(searchPage + 1, true);
    };
    const searchClients = async (next = 0, append = false) => {
      const search = ++searchGeneration,
        version = generation;
      if (!append) {
        searchQuery = $("history-client-search").value.trim();
        selectedClient = null;
        $("history-choice-summary").hidden = true;
        $("history-apply-choice").disabled = true;
        $("history-apply-choice").dataset.unavailable = "true";
      }
      $("history-client-search-button").disabled = true;
      try {
        const result = await api(
          route(`/clients?q=${encodeURIComponent(searchQuery)}&page=${next}`),
        );
        if (!live(version) || search !== searchGeneration || panel.hidden)
          return;
        searchPage = next;
        renderClients(result.clients, result.hasMore, append);
      } catch (error) {
        if (live(version) && search === searchGeneration)
          showError(
            error,
            () => searchClients(next, append),
            "Retry client search",
          );
      } finally {
        if (
          live(version) &&
          search === searchGeneration &&
          $("history-client-search-button")
        )
          $("history-client-search-button").disabled = false;
      }
    };
    $("history-client-search-form").onsubmit = (event) => {
      event.preventDefault();
      searchClients();
    };
    $("history-cancel-choice").onclick = () => {
      searchGeneration++;
      panel.hidden = true;
    };
    $("history-apply-choice").onclick = () => {
      if (selectedClient && !busy) saveChoices(selectedClient);
    };
    if (candidate) {
      renderClients([candidate], false);
      selectClient(candidate);
    }
    $("history-client-search").focus({ preventScroll: true });
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async function saveChoices(client) {
    if (busy || !selected.size) return;
    const version = generation;
    const choices = [...selected.keys()]
      .sort((a, b) => a - b)
      .map((row) => ({
        row,
        clientId: client?.id ?? null,
        clientVersion: client?.version ?? null,
      }));
    const signature = JSON.stringify(choices);
    if (choiceRequest?.signature !== signature)
      choiceRequest = {
        signature,
        body: {
          version: draft.version,
          requestId: crypto.randomUUID(),
          choices,
        },
      };
    clearError();
    setBusy(true);
    searchGeneration++;
    try {
      const result = await api(route("/choices"), {
        method: "POST",
        body: choiceRequest.body,
      });
      assertCurrent(version);
      draft = { ...draft, ...result };
      choiceRequest = null;
      await loadPage(page, version);
    } catch (error) {
      if (live(version))
        showError(
          error,
          error.status === 409
            ? () => loadPage(page)
            : () => saveChoices(client),
          error.status === 409 ? "Refresh review" : "Retry draft choice",
        );
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  function clearImportReview() {
    if (importPending) return;
    importReview = null;
    importReviewRequest = null;
    importConfirmRequest = null;
    if ($("history-import-review")) $("history-import-review").hidden = true;
  }
  function statusCountsHTML(counts) {
    return `<div class="history-status-counts">${(counts || []).map((item) => `<span><strong>${number(item.count)}</strong> ${safe(item.status ?? "Unknown status")}</span>`).join("") || `<span>Original statuses unavailable</span>`}</div>`;
  }
  async function reviewImport() {
    if (busy || importPending || !selected.size) return;
    $("history-import-result").innerHTML = "";
    const version = generation;
    const selection = {
      previewId: draft.id,
      version: draft.version,
      rows: [...selected.keys()].sort((a, b) => a - b),
    };
    const signature = JSON.stringify(selection);
    if (importReviewRequest?.signature !== signature)
      importReviewRequest = {
        signature,
        body: { ...selection, requestId: crypto.randomUUID() },
      };
    clearError();
    setBusy(true);
    searchGeneration++;
    $("history-choice-panel").hidden = true;
    importReview = null;
    importConfirmRequest = null;
    $("history-import-review").hidden = true;
    try {
      const result = await api("/history/imports/review", {
        method: "POST",
        body: importReviewRequest.body,
      });
      assertCurrent(version);
      if (
        result.previewId !== draft.id ||
        result.requestId !== importReviewRequest.body.requestId
      )
        throw new Error(
          "This import review could not be verified. Refresh the preview and try again.",
        );
      importReview = result;
      importConfirmRequest = null;
      renderImportReview();
    } catch (error) {
      if (live(version)) {
        const stale = [409, 410].includes(error.status);
        if (stale) clearImportReview();
        showError(
          error,
          stale ? () => loadPage(page) : reviewImport,
          stale ? "Refresh review" : "Retry import review",
        );
      }
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  function renderImportReview() {
    const review = importReview,
      counts = review.counts;
    const panel = $("history-import-review");
    panel.hidden = false;
    panel.className = "history-import-review";
    const groups = [
      ["importable", "New records"],
      ["duplicates", "Already imported"],
      ["blocked", "Blocked"],
    ];
    for (const [key, label] of [
      ["unmatched", "Without a saved match"],
      ["conflicts", "Conflicts"],
      ["invalid", "Invalid"],
    ])
      if (Number.isInteger(counts[key])) groups.push([key, label]);
    panel.innerHTML = `<h3>Review import</h3><p class="hint">${number(counts.selected)} selected rows. Original statuses and unknown values will be preserved in imported history.</p>
      <div id="history-import-counts" class="history-counts">${groups.map(([key, label]) => `<div class="history-count"><strong>${number(counts[key])}</strong><span>${label}</span></div>`).join("")}</div>
      <section id="history-import-status-counts"><h4>Original statuses in this selection</h4>${statusCountsHTML(review.statusCounts)}</section>
      ${review.warnings?.length ? `<ul class="history-import-warnings">${review.warnings.map((message) => `<li>${safe(message)}</li>`).join("")}</ul>` : ""}
      <p class="history-format-note">${review.canConfirm ? "New records will be saved permanently to the matched clients’ imported history. Already imported rows will be skipped. Calendar bookings and financial reports are unchanged." : "This selection cannot be imported yet. Save current client matches and fix or remove blocked rows, then review again."}</p>
      <div id="history-import-rows" class="history-import-rows">${review.rows.map((item) => `<article class="history-import-row" data-history-import-row="${item.row}"><div><strong>Row ${item.row} · ${safe(item.client?.name || "No saved client match")}</strong><span class="history-result" data-result="${item.disposition === "blocked" ? "conflict" : item.disposition === "duplicate" ? "duplicate" : "ready"}">${{ import: "New record", duplicate: "Already imported", blocked: "Blocked" }[item.disposition] || "Blocked"}</span></div><p>${safe(item.date || "Date unknown")} · ${safe(historyTime(item.start, item.duration))} · ${safe(item.serviceName || "Treatment unknown")}</p><p class="hint">Original status: <strong>${safe(item.sourceStatus ?? "Unknown")}</strong> · ${safe(item.therapistName || "Therapist unknown")}</p>${item.issues?.length ? `<ul class="history-issues">${item.issues.map((issue) => `<li>${safe(issue.message)}</li>`).join("")}</ul>` : ""}${item.nativeOverlapIds?.length ? `<p class="hint">Possible overlap with ${number(item.nativeOverlapIds.length)} existing appointments. Review it before importing.</p>` : ""}</article>`).join("")}</div>
      ${review.canConfirm ? `<label class="history-import-ack"><input id="history-import-ack" type="checkbox" data-history-busy><span>I have reviewed these records and client matches. Save the new rows with their original statuses; leave unknown values unknown.</span></label>` : ""}
      <div class="history-actions"><button class="btn primary" id="history-confirm-import" data-history-busy data-history-import-retry data-unavailable="true" disabled>Confirm import</button><button class="btn" id="history-cancel-import-review" data-history-busy>Back to rows</button></div><p class="history-readiness">Review expires ${safe(expiry(review.expiresAt))}. Nothing is imported until you confirm.</p>`;
    if ($("history-import-ack"))
      $("history-import-ack").onchange = () => {
        const allowed = review.canConfirm && $("history-import-ack").checked;
        $("history-confirm-import").dataset.unavailable = String(!allowed);
        $("history-confirm-import").disabled = busy || !allowed;
      };
    $("history-confirm-import").onclick = confirmImport;
    $("history-cancel-import-review").onclick = () => {
      if (!busy && !importPending) {
        clearImportReview();
        $("history-review-import").focus({ preventScroll: true });
      }
    };
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async function confirmImport() {
    if (busy || !importReview) return;
    if (!importConfirmRequest) {
      if (!importReview.canConfirm || !$("history-import-ack")?.checked) return;
      importConfirmRequest = {
        ...importReviewRequest.body,
        rows: [...importReviewRequest.body.rows],
        confirmationToken: importReview.confirmationToken,
        acknowledgeReview: true,
      };
    }
    const version = generation;
    clearError();
    importPending = true;
    setBusy(true);
    try {
      const receipt = await api("/history/imports/confirm", {
        method: "POST",
        body: importConfirmRequest,
      });
      assertCurrent(version);
      importPending = false;
      showImportReceipt(receipt);
      selected.clear();
      clearImportReview();
      await loadPage(page, version, true);
    } catch (error) {
      if (!live(version)) return;
      if ([400, 403, 404, 409, 410, 413, 422].includes(error.status)) {
        importPending = false;
        clearImportReview();
        showError(error, () => loadPage(page), "Refresh review");
      } else {
        $("history-confirm-import").textContent = "Check import result";
        showError(
          new Error(
            "The confirmation response was interrupted. This import may already be complete. Check its result to retrieve the saved receipt safely.",
          ),
          confirmImport,
          "Check import result",
        );
      }
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  function showImportReceipt(receipt) {
    const clients = [
      ...new Map(
        (importReview?.rows || [])
          .filter((item) => item.client)
          .map((item) => [item.client.id, item.client]),
      ).values(),
    ];
    $("history-import-result").innerHTML =
      `<section id="history-import-receipt" class="history-card history-import-receipt" role="status"><h2>${receipt.repeated ? "Import receipt recovered" : "Import completed"}</h2><p><strong>${number(receipt.created)} imported</strong> · ${number(receipt.duplicates)} already imported and skipped.</p><p class="hint">Imported history is saved permanently. Repeating this request does not add the same source records again.</p><p class="history-receipt-id">Receipt: <strong>${safe(receipt.importId)}</strong></p><h3>Original statuses in this batch</h3>${statusCountsHTML(receipt.statusCounts)}<div class="history-actions">${clients.map((client) => `<button class="btn" data-history-receipt-client="${safe(client.id)}" data-history-busy>Open ${safe(client.name)}</button>`).join("")}<button class="btn" id="history-dismiss-receipt" data-history-busy>Close receipt</button></div></section>`;
    $("history-import-result")
      .querySelectorAll("[data-history-receipt-client]")
      .forEach((button) => {
        button.onclick = () => {
          if (busy) return;
          generation++;
          openProfile(button.dataset.historyReceiptClient);
        };
      });
    $("history-dismiss-receipt").onclick = () => {
      if (!busy) $("history-import-result").innerHTML = "";
    };
    $("history-import-receipt").scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }
  async function discard() {
    if (busy) return;
    const version = generation;
    clearError();
    setBusy(true);
    try {
      await api(route(), {
        method: "DELETE",
        body: { version: draft.version },
      });
      assertCurrent(version);
      reset();
    } catch (error) {
      if (live(version))
        showError(
          error,
          error.status === 409 ? () => loadPage(page) : discard,
          error.status === 409 ? "Refresh review" : "Retry discard",
        );
    } finally {
      if (live(version)) setBusy(false);
    }
  }
  function rebuild() {
    if (busy) return;
    draft = { ...draft, phase: "indexing" };
    prepare(++generation);
  }
  function reset() {
    if (importPending) return;
    $("history-import-result").innerHTML = "";
    generation++;
    searchGeneration++;
    draft = null;
    resume = null;
    parsed = null;
    fileInfo = null;
    config = null;
    pageData = null;
    selected.clear();
    choiceRequest = null;
    pendingUpload = null;
    importPending = false;
    clearImportReview();
    clearError();
    setBusy(false);
    $("history-work").innerHTML = "";
    $("history-file-card").hidden = false;
    $("history-recent").hidden = false;
    $("history-file-note").textContent =
      "One UTF-8 CSV · up to 50,000 rows / 25 MiB. No manual splitting.";
    $("history-csv").value = "";
    $("history-source").readOnly = false;
    $("history-read-columns").textContent = "Read columns";
    $("history-cancel-resume").hidden = true;
    loadRecent();
  }
  return () => {
    disposed = true;
    generation++;
    searchGeneration++;
    parsed = null;
    pendingUpload = null;
    selected.clear();
  };
}
