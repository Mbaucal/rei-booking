/** Owner-managed report credentials. Secrets live only in this page's current view. */
export function renderReportAccess({ root, api, esc, stamp, isCurrent, back }) {
  let disposed = false,
    sequence = 0,
    busy = false,
    loaded = false,
    secret = "",
    confirmation = null,
    needsReload = false,
    credentials = [];
  const $ = (id) => root.querySelector(`#${id}`);
  const current = (version = sequence) =>
    !disposed && root.isConnected && isCurrent() && version === sequence;
  const safe = (value) => esc(String(value ?? ""));
  root.innerHTML = `<div class="toolbar"><button class="btn" id="report-access-back" type="button">Back to Reports</button></div>
    <div class="report-access-intro"><h2>Google Sheets / API</h2><p>Read salon reports automatically with a private access key. Keys can read reports only.</p></div>
    <section class="report-access-panel" aria-labelledby="report-access-create-title">
      <h3 id="report-access-create-title">Create access key</h3>
      <form id="report-access-create" class="report-access-create">
        <label><span>Name</span><input id="report-access-name" name="name" maxlength="80" placeholder="My Google Sheets" autocomplete="off" required></label>
        <label><span>Expires after</span><select id="report-access-expiry" name="expiry"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="none">No expiry</option></select></label>
        <button class="btn primary" id="report-access-submit" type="submit" disabled>Create key</button>
      </form>
      <p class="hint">Keep the key private. It grants access to report totals, including revenue and bonuses, without access to client identities or booking changes.</p>
    </section>
    <section class="report-access-panel report-access-secret" id="report-token-reveal" aria-labelledby="report-token-title" hidden>
      <h3 id="report-token-title">Save your access key</h3><p>This is the only time the full key is shown. Store it in Apps Script Properties or your password manager.</p>
      <label><span>Access key</span><textarea id="report-token-secret" readonly rows="2" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea></label>
      <div class="toolbar"><button class="btn primary" id="report-token-copy" type="button">Copy key</button><button class="btn" id="report-token-dismiss" type="button">Done</button></div>
      <p class="hint" id="report-token-copy-status" role="status" hidden></p>
    </section>
    <p class="error" id="report-access-error" role="alert" hidden></p>
    <p class="hint" id="report-access-result" role="status" hidden></p>
    <section class="report-access-panel" id="report-access-confirmation" aria-labelledby="report-access-confirm-title" hidden>
      <h3 id="report-access-confirm-title"></h3><p id="report-access-confirm-description"></p>
      <div class="toolbar"><button class="btn primary" id="report-access-confirm" type="button"></button><button class="btn" id="report-access-cancel" type="button">Cancel</button></div>
    </section>
    <section class="report-access-panel" aria-labelledby="report-access-list-title">
      <div class="report-access-list-heading"><h3 id="report-access-list-title">Your access keys</h3><button class="btn" id="report-access-reload" type="button">Reload</button></div>
      <div id="report-access-list"><p class="hint" role="status">Loading access keys…</p></div>
    </section>
    <details class="report-access-panel report-access-setup" id="report-access-setup"><summary>Connect Google Sheets</summary>
      <ol>
        <li><a class="btn" id="report-script-download" href="/rei-reports-sync.gs" download="rei-reports-sync.gs">Download Apps Script</a><p>Open a Google spreadsheet, choose <strong>Extensions → Apps Script</strong>, and paste the downloaded script into the editor.</p></li>
        <li><p>In <strong>Project Settings → Script Properties</strong>, add these values. Script editors can read them; do not put the access key in a sheet cell.</p><dl class="report-access-properties"><dt><code>REI_API_BASE</code></dt><dd id="report-access-api-base">Loading…</dd><dt><code>REI_API_TOKEN</code></dt><dd>The private access key shown above.</dd><dt><code>REI_SPREADSHEET_ID</code></dt><dd>The spreadsheet ID from its URL.</dd><dt><code>REI_START_DATE</code></dt><dd>The first treatment date to include, as YYYY-MM-DD.</dd></dl></li>
        <li><p>Run <code>reiSyncReports</code> manually and complete Google's authorization. Check the new report tabs against Reports in this app.</p></li>
        <li><p>After a successful manual sync, run <code>reiInstallDailySync</code> for a daily update around 09:00 Europe/Belgrade. Run <code>reiRemoveDailySync</code> to stop it.</p></li>
      </ol>
      <p class="hint">The script creates separate dated snapshot tabs and keeps existing tabs, formulas and history. Long date ranges are split into periods automatically. Snapshots are alternative views: do not add their totals together. Imported history and Rei revenue stay separate.</p>
      <p class="hint">Creating a key or downloading the script does not connect or change any Google spreadsheet. Revoking or rotating a key stops scripts that still use the old key.</p>
      <details><summary>API details</summary><p>Read-only endpoint: <code>/api/v1/reports/performance</code>. Send the key in the <code>Authorization: Bearer</code> header. Never put it in a URL. Dates use Europe/Belgrade; schema version 1. A response must be complete before it is written to Sheets.</p></details>
    </details>`;

  function error(message) {
    $("report-access-error").textContent = message;
    $("report-access-error").hidden = false;
  }
  function result(message) {
    $("report-access-result").textContent = message;
    $("report-access-result").hidden = !message;
  }
  function controls() {
    const locked = busy || !!secret || !!confirmation || !loaded || needsReload;
    for (const control of $("report-access-create").elements)
      control.disabled = locked;
    $("report-access-reload").disabled = busy || !!secret;
    root
      .querySelectorAll("[data-token-revoke],[data-token-rotate]")
      .forEach((button) => {
        button.disabled = locked;
      });
    $("report-access-confirm").disabled = busy;
    $("report-access-cancel").disabled = busy;
  }
  function clearSecret() {
    secret = "";
    if (!$("report-token-secret")) return;
    $("report-token-secret").value = "";
    $("report-token-reveal").hidden = true;
    $("report-token-copy-status").textContent = "";
    $("report-token-copy-status").hidden = true;
    controls();
  }
  function reveal(value) {
    secret = value;
    $("report-token-secret").value = value;
    $("report-token-reveal").hidden = false;
    controls();
    $("report-token-secret").focus({ preventScroll: true });
    $("report-token-reveal").scrollIntoView({ block: "nearest" });
  }
  const date = (value) => (value ? stamp(value) : "—");
  function renderList() {
    $("report-access-list").innerHTML = credentials.length
      ? `<ul class="report-token-list">${credentials
          .map((item) => {
            const status = item.revokedAt
              ? "Revoked"
              : item.expiresAt && Date.parse(item.expiresAt) <= Date.now()
                ? "Expired"
                : item.active
                  ? "Active"
                  : "Unavailable";
            return `<li class="report-token-card"><div class="report-token-heading"><strong>${safe(item.name)}</strong><span class="badge">${status}</span></div><dl class="report-token-dates"><div><dt>Created</dt><dd>${safe(date(item.createdAt))}</dd></div><div><dt>Expires</dt><dd>${item.expiresAt ? safe(date(item.expiresAt)) : "No expiry"}</dd></div><div><dt>Last used</dt><dd>${safe(date(item.lastUsedAt))}</dd></div></dl>${item.active ? `<div class="toolbar"><button class="btn" type="button" data-token-rotate="${safe(item.id)}">Rotate key</button><button class="btn" type="button" data-token-revoke="${safe(item.id)}">Revoke</button></div>` : ""}</li>`;
          })
          .join("")}</ul>`
      : '<p class="hint">No access keys yet.</p>';
    root.querySelectorAll("[data-token-revoke]").forEach((button) => {
      button.onclick = () => confirm("revoke", button.dataset.tokenRevoke);
    });
    root.querySelectorAll("[data-token-rotate]").forEach((button) => {
      button.onclick = () => confirm("rotate", button.dataset.tokenRotate);
    });
    controls();
  }
  function confirm(action, id) {
    if (!current() || busy || secret || needsReload) return;
    const item = credentials.find((entry) => entry.id === id);
    if (!item?.active) return;
    confirmation = { action, item };
    $("report-access-confirm-title").textContent =
      `${action === "rotate" ? "Rotate" : "Revoke"} “${item.name}”?`;
    $("report-access-confirm-description").textContent =
      action === "rotate"
        ? "The old key will stop working immediately. Save the new key and update your Apps Script Properties."
        : "This key will stop working immediately. Any script using it will no longer be able to read reports.";
    $("report-access-confirm").textContent =
      action === "rotate" ? "Rotate key" : "Revoke key";
    $("report-access-confirmation").hidden = false;
    controls();
    $("report-access-confirm").focus({ preventScroll: true });
    $("report-access-confirmation").scrollIntoView({ block: "nearest" });
  }
  function cancelConfirmation() {
    confirmation = null;
    $("report-access-confirmation").hidden = true;
    controls();
  }
  async function load() {
    if (busy || secret || !current()) return;
    const version = ++sequence;
    busy = true;
    cancelConfirmation();
    $("report-access-error").hidden = true;
    result("Loading access keys…");
    controls();
    try {
      const data = await api("/report-access/tokens");
      if (!current(version)) return;
      credentials = data.tokens;
      loaded = true;
      needsReload = false;
      $("report-access-api-base").textContent = data.apiBase;
      renderList();
      result("");
    } catch (failure) {
      if (!current(version)) return;
      needsReload = true;
      error(failure.message);
      result("");
      if (!loaded)
        $("report-access-list").innerHTML =
          '<p class="hint">Access keys could not be loaded. Use Reload to try again.</p>';
    } finally {
      if (current(version)) {
        busy = false;
        controls();
      }
    }
  }
  async function mutate(path, method, body, action) {
    if (busy || secret || needsReload || !current()) return;
    const version = sequence;
    busy = true;
    $("report-access-error").hidden = true;
    result("");
    controls();
    try {
      const data = await api(path, { method, ...(body ? { body } : {}) });
      if (!current(version)) return;
      const selected = confirmation?.item;
      cancelConfirmation();
      if (action === "revoke") {
        credentials = credentials.map((item) =>
          item.id === selected.id
            ? { ...item, active: false, revokedAt: new Date().toISOString() }
            : item,
        );
        result("Access key revoked.");
      } else {
        if (!data.token || !data.credential)
          throw new Error("The new key was not received.");
        if (selected)
          credentials = credentials.map((item) =>
            item.id === selected.id
              ? { ...item, active: false, revokedAt: new Date().toISOString() }
              : item,
          );
        credentials.unshift(data.credential);
        $("report-access-create").reset();
        reveal(data.token);
      }
      renderList();
    } catch (failure) {
      if (!current(version)) return;
      const uncertain = !failure.status || failure.status >= 500;
      if (uncertain) {
        needsReload = true;
        cancelConfirmation();
      }
      error(
        failure.message +
          (uncertain
            ? " Reload the key list before trying again. If a new key appears but its secret was not received, revoke it and create another."
            : ""),
      );
    } finally {
      if (current(version)) {
        busy = false;
        controls();
      }
    }
  }
  $("report-access-back").onclick = back;
  $("report-access-reload").onclick = load;
  $("report-access-cancel").onclick = cancelConfirmation;
  $("report-access-confirm").onclick = () => {
    if (!confirmation) return;
    const { action, item } = confirmation;
    return mutate(
      `/report-access/tokens/${encodeURIComponent(item.id)}${action === "rotate" ? "/rotate" : ""}`,
      action === "rotate" ? "POST" : "DELETE",
      action === "rotate" ? {} : null,
      action,
    );
  };
  $("report-access-create").onsubmit = (event) => {
    event.preventDefault();
    return mutate(
      "/report-access/tokens",
      "POST",
      {
        name: $("report-access-name").value.trim(),
        expiresInDays:
          $("report-access-expiry").value === "none"
            ? null
            : Number($("report-access-expiry").value),
      },
      "create",
    );
  };
  $("report-token-dismiss").onclick = clearSecret;
  $("report-token-copy").onclick = async () => {
    if (!secret || !current()) return;
    const version = sequence;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(secret);
      if (!current(version) || !secret) return;
      $("report-token-copy-status").textContent =
        "Key copied. Paste it into Script Properties.";
    } catch {
      if (!current(version) || !secret) return;
      $("report-token-secret").focus();
      $("report-token-secret").select();
      $("report-token-copy-status").textContent =
        "Copy is unavailable here. Copy the selected key manually.";
    }
    $("report-token-copy-status").hidden = false;
  };
  window.addEventListener("pagehide", clearSecret);
  void load();
  return () => {
    clearSecret();
    disposed = true;
    sequence++;
    credentials = [];
    confirmation = null;
    window.removeEventListener("pagehide", clearSecret);
  };
}
