const labels = {
  name: "Full name",
  firstName: "First name",
  lastName: "Last name",
  phone: "Phone",
  email: "Email",
  note: "Client note",
  sourceId: "Source client ID",
};
const aliases = {
  name: ["full name", "client name", "name"],
  firstName: ["first name", "firstname"],
  lastName: ["last name", "lastname", "surname"],
  phone: ["phone", "phone number", "mobile", "mobile number"],
  email: ["email", "email address"],
  note: ["note", "notes", "client note"],
  sourceId: ["rei client id", "client id", "customer id"],
};
export function renderClientTransfer({ root, api, esc, isCurrent, back }) {
  let csv = "",
    inspected = null,
    preview = null,
    page = 0,
    selected = new Set(),
    generation = 0;
  root.innerHTML = `<div class="toolbar"><button class="btn" id="transfer-back">← Back to clients</button></div>
    <section class="transfer-card"><p class="eyebrow">CLIENT TRANSFER</p><h2>Import clients</h2>
    <p>Upload a CSV, match its columns, then review the clients before adding them.</p>
    <p class="hint">Client profiles only. Photos and appointment history are not imported. Existing profiles are never overwritten.</p>
    <form id="transfer-file"><div class="fields">
      <label class="wide"><span>CSV file · UTF-8 · up to 1 MiB / 1,000 clients</span><input id="transfer-csv" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" required></label>
      <label><span>File source</span><select id="transfer-source"><option value="fresha">Fresha</option><option value="rei">Rei Booking</option><option value="other">Other</option></select></label>
      <label><span>Separator</span><select id="transfer-delimiter"><option value="auto">Detect automatically</option><option value=",">Comma</option><option value=";">Semicolon</option><option value="tab">Tab</option></select></label>
    </div><button class="btn primary" type="submit">Read columns</button></form></section>
    <p id="transfer-error" class="error" role="alert" hidden></p><div id="transfer-work"></div>`;
  const $ = (id) => root.querySelector("#" + id),
    current = (v) => isCurrent() && v === generation,
    error = (e) => {
      if (isCurrent()) {
        $("transfer-error").textContent = e.message;
        $("transfer-error").hidden = false;
      }
    },
    clearError = () => {
      $("transfer-error").hidden = true;
    },
    invalidate = () => {
      generation++;
      inspected = null;
      preview = null;
      csv = "";
      $("transfer-work").innerHTML = "";
      clearError();
    };
  $("transfer-back").onclick = back;
  for (const id of ["transfer-csv", "transfer-source", "transfer-delimiter"])
    $(id).onchange = invalidate;
  $("transfer-file").onsubmit = async (event) => {
    event.preventDefault();
    invalidate();
    const version = generation,
      button = event.submitter,
      file = $("transfer-csv").files[0];
    if (!file) return;
    button.disabled = true;
    clearError();
    try {
      if (file.size > 1048576)
        throw new Error("Choose a CSV file of 1 MiB or smaller.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!current(version)) return;
      const separator = $("transfer-delimiter").value;
      const data = await api("/clients/import/inspect", {
        method: "POST",
        body: { csv: text, delimiter: separator === "tab" ? "\t" : separator },
      });
      if (!current(version)) return;
      csv = text;
      inspected = data;
      if (data.reiExport) $("transfer-source").value = "rei";
      mappingView();
    } catch (e) {
      if (current(version))
        error(
          e instanceof TypeError
            ? new Error(
                "Read failed. Check the connection and save the file as UTF-8 CSV.",
              )
            : e,
        );
    } finally {
      if (isCurrent()) button.disabled = false;
    }
  };
  function mappingView() {
    preview = null;
    selected.clear();
    const defaults = {},
      used = new Set();
    for (const [field, options] of Object.entries(aliases)) {
      const candidates = inspected.headers
        .map((h, i) => (options.includes(h.trim().toLowerCase()) ? i : -1))
        .filter((i) => i >= 0);
      if (candidates.length === 1 && !used.has(candidates[0])) {
        defaults[field] = candidates[0];
        used.add(candidates[0]);
      }
    }
    if (defaults.name !== undefined) {
      delete defaults.firstName;
      delete defaults.lastName;
    }
    $("transfer-work").innerHTML =
      `<section class="transfer-card"><h3>Match columns</h3><p>${inspected.total} client rows found. Check the suggested matches.</p>
      <p class="hint">Use Full name or First name + Last name. Other fields are optional. Phone numbers starting with 0 use Serbia (+381); use + or 00 for other countries. Use a stable source client ID when available.</p>
      <form id="transfer-map"><div class="fields">${Object.entries(labels)
        .map(
          ([field, label]) =>
            `<label><span>${label}</span><select name="${field}"><option value="">Do not import</option>${inspected.headers.map((h, i) => `<option value="${i}" ${defaults[field] === i ? "selected" : ""}>${i + 1}. ${esc(h)}</option>`).join("")}</select><small data-sample="${field}" class="hint"></small></label>`,
        )
        .join("")}</div>
      <button type="submit" class="btn primary">Preview import</button></form></section>`;
    const form = $("transfer-map");
    const sample = () =>
      form.querySelectorAll("select").forEach((select) => {
        form.querySelector(`[data-sample="${select.name}"]`).textContent =
          select.value === ""
            ? ""
            : "Example: " +
              (inspected.sample[0]?.[Number(select.value)] || "(empty)");
      });
    form.onchange = sample;
    sample();
    form.onsubmit = async (event) => {
      event.preventDefault();
      clearError();
      const version = ++generation,
        button = event.submitter,
        mapping = {};
      for (const [key, value] of new FormData(form))
        if (value !== "") mapping[key] = Number(value);
      button.disabled = true;
      try {
        const data = await api("/clients/import/preview", {
          method: "POST",
          body: {
            csv,
            delimiter: inspected.delimiter,
            source: $("transfer-source").value,
            mapping,
          },
        });
        if (!current(version)) return;
        preview = data;
        selected = new Set(
          data.rows.filter((r) => r.selected).map((r) => r.row),
        );
        page = 0;
        previewView();
      } catch (e) {
        if (current(version)) error(e);
      } finally {
        if (isCurrent()) button.disabled = false;
      }
    };
  }
  function previewView() {
    const counts = {};
    for (const r of preview.rows)
      counts[r.status] = (counts[r.status] || 0) + 1;
    const pages = Math.ceil(preview.rows.length / 50);
    const names = {
      new: "Ready",
      review: "Check identity",
      existing: "Existing",
      conflict: "Conflict",
      invalid: "Invalid",
      duplicate: "Duplicate row",
    };
    $("transfer-work").innerHTML =
      `<section class="transfer-card"><h3>Review before importing</h3>
      <div class="transfer-counts">${Object.entries(counts)
        .map(([s, n]) => `<span><strong>${n}</strong> ${names[s]}</span>`)
        .join("")}</div>
      <p class="hint">Nothing has been added yet. Existing, invalid, duplicate and conflicting rows are skipped. Check identity rows start unselected. Correct problems in the CSV and create a new preview. Preview expires in one hour.</p>
      <div class="toolbar"><button class="btn" id="transfer-remap">Back to columns</button><button class="btn" id="transfer-ready">Select ready rows</button><button class="btn" id="transfer-clear">Clear selection</button></div>
      <div class="table-wrap"><table class="transfer-table"><caption class="hint">Showing rows ${page * 50 + 1}–${Math.min((page + 1) * 50, preview.rows.length)} of ${preview.rows.length}</caption><thead><tr><th>Select</th><th>Row</th><th>Client</th><th>Phone / email</th><th>Result</th></tr></thead><tbody>${preview.rows
        .slice(page * 50, (page + 1) * 50)
        .map(
          (r) =>
            `<tr><td>${["new", "review"].includes(r.status) ? `<input type="checkbox" data-row="${r.row}" aria-label="Import row ${r.row}: ${esc(r.client.name)}" ${selected.has(r.row) ? "checked" : ""}>` : "—"}</td><td>${r.row}</td><td><strong>${esc(r.client.name)}</strong>${r.client.note ? `<details><summary>Client note</summary><p>${esc(r.client.note)}</p></details>` : ""}</td><td>${esc(r.client.phone)}<br>${esc(r.client.email)}</td><td><strong>${names[r.status]}</strong><p class="hint">${esc(r.message)}</p></td></tr>`,
        )
        .join("")}</tbody></table></div>
      <div class="toolbar"><button class="btn" id="transfer-prev" ${page === 0 ? "disabled" : ""}>Previous</button><span>Page ${page + 1} of ${pages}</span><button class="btn" id="transfer-next" ${page + 1 === pages ? "disabled" : ""}>Next</button></div>
      <form id="transfer-confirm"><label class="check"><input type="checkbox" id="transfer-checked" required> I have reviewed the selected clients and want to add them.</label><button class="btn primary" id="transfer-commit" type="submit"></button><p class="hint" id="transfer-selected" aria-live="polite"></p></form></section>`;
    const update = () => {
      $("transfer-commit").textContent = `Import ${selected.size} clients`;
      $("transfer-commit").disabled = !selected.size;
      $("transfer-selected").textContent =
        `${selected.size} selected across all pages. ${preview.total - selected.size} will be skipped.`;
      $("transfer-checked").checked = false;
    };
    update();
    root.querySelectorAll("[data-row]").forEach(
      (el) =>
        (el.onchange = () => {
          el.checked
            ? selected.add(Number(el.dataset.row))
            : selected.delete(Number(el.dataset.row));
          update();
        }),
    );
    $("transfer-remap").onclick = () => {
      generation++;
      clearError();
      mappingView();
    };
    $("transfer-ready").onclick = () => {
      selected = new Set(
        preview.rows.filter((r) => r.status === "new").map((r) => r.row),
      );
      previewView();
    };
    $("transfer-clear").onclick = () => {
      selected.clear();
      previewView();
    };
    $("transfer-prev").onclick = () => {
      page--;
      previewView();
    };
    $("transfer-next").onclick = () => {
      page++;
      previewView();
    };
    $("transfer-confirm").onsubmit = async (event) => {
      event.preventDefault();
      clearError();
      const version = ++generation,
        snapshot = [...selected],
        id = preview.id;
      root.querySelectorAll("button,input,select").forEach((el) => {
        el.disabled = true;
      });
      try {
        const result = await api("/clients/import/" + id + "/commit", {
          method: "POST",
          body: { rows: snapshot },
        });
        if (!current(version)) return;
        csv = "";
        inspected = null;
        preview = null;
        root.innerHTML = `<section class="transfer-card" role="status"><h2>Import complete</h2><p><strong>${result.created}</strong> clients added. <strong>${result.skipped}</strong> rows skipped.</p>${result.repeated ? "<p>This import was already saved. No duplicate clients were added.</p>" : ""}<p class="hint">Existing clients were kept unchanged.</p><button class="btn primary" id="transfer-done">View clients</button></section>`;
        $("transfer-done").onclick = back;
      } catch (e) {
        if (!current(version)) return;
        // Keep the exact preview and selection so a lost response can be retried safely.
        root.querySelectorAll("button,input,select").forEach((el) => {
          el.disabled = false;
        });
        previewView();
        error(e);
      }
    };
  }
}
