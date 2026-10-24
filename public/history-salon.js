/** Reviewed catalogue setup from permanently imported appointment history. */
export function renderHistorySalon({
  root,
  api,
  esc,
  isCurrent,
  back,
  openPage,
}) {
  let disposed = false,
    busy = false,
    preview = null,
    pending = null;
  let kind = "services",
    query = "",
    page = 0;
  const choices = new Map();
  const live = () => !disposed && isCurrent();
  const $ = (id) => root.querySelector(`#${id}`);
  const safe = (value) => esc(String(value ?? ""));
  const priceText = (value) =>
    Number.isSafeInteger(value) ? (value / 100).toFixed(2) : "";
  const label = (item) =>
    `${item.name}${item.duration ? ` · ${item.duration} min` : ""}${item.active === false || item.active === 0 ? " · Inactive" : ""}`;
  root.innerHTML = `<section class="history-preview history-salon">
    <div class="history-topline"><button class="btn" id="salon-back">← Back to history</button><span class="history-badge">Use saved history</span></div>
    <h2>Set up your salon from history</h2><p class="history-lead">Review therapist names and treatment prices, then save once. Your imported visits already appear in Reports. No need to upload the CSV again.</p>
    <p id="salon-error" class="error" role="alert" hidden></p>
    <div id="salon-content"><p role="status">Reading saved history…</p></div>
  </section>`;
  $("salon-back").onclick = () => {
    if (!busy) back();
  };
  const error = (e) => {
    if (live()) {
      $("salon-error").textContent = e.message;
      $("salon-error").hidden = false;
    }
  };
  function lock(value) {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    root.querySelectorAll("input,select,button").forEach((el) => {
      el.disabled = value || el.dataset.locked === "true";
    });
  }
  function draft(candidate) {
    const linked = candidate.existingLink || candidate.match?.id;
    const amount = candidate.latestNet?.amountMinor;
    const usablePrice =
      Number.isSafeInteger(amount) &&
      amount > 0 &&
      candidate.latestNet?.currency === "RSD" &&
      candidate.latestNet?.minorUnitDigits === 2;
    const duration = candidate.duration;
    return {
      key: candidate.key,
      action: linked
        ? "link"
        : candidate.kind === "therapist" || (usablePrice && duration > 0)
          ? "create"
          : "skip",
      entityId: linked || "",
      name: candidate.label,
      duration: duration || "",
      price: usablePrice ? priceText(amount) : "",
      active: true,
    };
  }
  async function load() {
    lock(true);
    $("salon-error").hidden = true;
    try {
      const next = await api(
        "/history/salon/preview?currency=RSD&minorUnitDigits=2&timeZone=Europe%2FBelgrade",
      );
      if (!live()) return;
      preview = next;
      pending = null;
      choices.clear();
      [...preview.therapists, ...preview.services].forEach((c) =>
        choices.set(c.key, draft(c)),
      );
      render();
    } catch (e) {
      error(e);
      if (live()) {
        $("salon-content").innerHTML =
          '<button class="btn" id="salon-reload">Try again</button>';
        $("salon-reload").onclick = load;
      }
    } finally {
      if (live()) lock(false);
    }
  }
  function render() {
    if (!preview.summary.rows) {
      $("salon-content").innerHTML =
        '<section class="history-card"><h3>No saved appointment history yet</h3><p>Finish the import confirmation first. Uploading a CSV or saving a preview alone does not import its rows.</p><button class="btn primary" id="salon-import">Open history import</button></section>';
      $("salon-import").onclick = back;
      return;
    }
    $("salon-content").innerHTML = `<section class="history-card">
      <p><strong>${safe(preview.summary.rows.toLocaleString("en-GB"))} saved rows</strong> · ${safe(preview.summary.from)} – ${safe(preview.summary.to)}</p>
      <p class="hint">Existing profiles and treatments are linked without changing them. New therapist profiles are inactive until you set their working hours in Team.</p>
      <div class="history-actions"><button class="btn" id="salon-reports">View reports</button><button class="btn" id="salon-refresh">Refresh review</button></div>
      ${preview.warnings?.length ? `<ul class="hint">${preview.warnings.map((w) => `<li>${safe(typeof w === "string" ? w : w.message || w.code)}</li>`).join("")}</ul>` : ""}
    </section>
    <form id="salon-form">
      <section class="history-card"><h3>Source amounts and times</h3><p class="hint">Confirm these for source rows that did not specify a currency or time zone. Explicit source values stay unchanged.</p>
        <div class="fields"><label>Currency<select id="salon-currency"><option value="RSD">RSD — Serbian dinar</option></select></label><label>Time zone<select id="salon-zone"><option value="Europe/Belgrade">Europe/Belgrade</option></select></label></div>
        <label class="check"><input type="checkbox" id="salon-source-confirm" required>Missing source currency means RSD, and local appointment times are Belgrade time.</label>
      </section>
      <section class="history-card"><div class="history-actions"><button class="btn" type="button" id="salon-services">Treatments (${preview.services.length})</button><button class="btn" type="button" id="salon-therapists">Therapists (${preview.therapists.length})</button></div>
        <p class="hint">Historical net sales are suggestions only. Review the current price before creating a treatment. Skipped items stay in history and reports.</p>
        <label>Find an item<input id="salon-search" type="search" placeholder="Treatment or therapist name" maxlength="120"></label>
        <div id="salon-items"></div><div class="history-actions"><button class="btn" type="button" id="salon-prev">Previous</button><span id="salon-page" role="status"></span><button class="btn" type="button" id="salon-next">Next</button></div>
      </section>
      <section class="history-card salon-confirmation"><p id="salon-selection" role="status"></p><label class="check"><input type="checkbox" id="salon-review-confirm" required>I reviewed the names, matches and current treatment prices.</label>
        <div class="history-actions"><button class="btn primary" id="salon-save" type="submit">Save setup</button><button class="btn" id="salon-cancel" type="button">Cancel</button></div>
      </section>
    </form>`;
    $("salon-reports").onclick = () => openPage("reports");
    $("salon-refresh").onclick = load;
    $("salon-cancel").onclick = back;
    $("salon-services").onclick = () => {
      kind = "services";
      page = 0;
      items();
    };
    $("salon-therapists").onclick = () => {
      kind = "therapists";
      page = 0;
      items();
    };
    $("salon-search").value = query;
    $("salon-search").oninput = (e) => {
      query = e.target.value;
      page = 0;
      items();
    };
    $("salon-prev").onclick = () => {
      page--;
      items();
    };
    $("salon-next").onclick = () => {
      page++;
      items();
    };
    $("salon-form").onsubmit = apply;
    items();
  }
  function summary() {
    const counts = { create: 0, link: 0, skip: 0 };
    for (const c of choices.values()) counts[c.action]++;
    $("salon-selection").textContent =
      `${counts.create} to create · ${counts.link} to link · ${counts.skip} to skip`;
  }
  function items() {
    const list = preview[kind].filter((c) =>
      c.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
    page = Math.max(0, Math.min(page, Math.ceil(list.length / 30) - 1));
    const visible = list.slice(page * 30, (page + 1) * 30);
    $("salon-items").innerHTML =
      visible
        .map((c, index) => {
          const d = choices.get(c.key),
            service = c.kind === "service";
          const options =
            preview.catalogue[service ? "services" : "therapists"];
          return `<article class="salon-candidate" data-candidate="${index}">
        <header><strong>${safe(c.label)}${service ? ` · ${safe(c.duration || "Unknown")} min` : ""}</strong><small>${safe(c.source)} · ${safe(c.count)} rows</small></header>
        ${service ? `<p class="hint">Latest historical net sale: ${c.latestNet?.amountMinor != null ? `${safe((c.latestNet.amountMinor / 10 ** c.latestNet.minorUnitDigits).toFixed(c.latestNet.minorUnitDigits))} ${safe(c.latestNet.currency || "Currency unknown")}` : safe(c.latestNet?.raw || "Unavailable")}${c.latestNet?.date ? ` · ${safe(c.latestNet.date)}` : ""}</p>` : ""}
        ${c.issues?.length ? `<p class="hint">${c.issues.map((i) => safe(typeof i === "string" ? i : i.message || i.code)).join(" · ")}</p>` : ""}
        <div class="fields"><label>Action<select data-field="action" ${c.existingLink ? 'data-locked="true" disabled' : ""}><option value="create" ${d.action === "create" ? "selected" : ""}>Create ${service ? "treatment" : "inactive profile"}</option><option value="link" ${d.action === "link" ? "selected" : ""}>Link existing</option><option value="skip" ${d.action === "skip" ? "selected" : ""}>Skip</option></select></label>
        ${d.action === "link" ? `<label>Existing ${service ? "treatment" : "therapist"}<select data-field="entityId" ${c.existingLink ? 'data-locked="true" disabled' : ""}><option value="">Choose a match</option>${options.map((v) => `<option value="${safe(v.id)}" ${v.id === d.entityId ? "selected" : ""}>${safe(label(v))}</option>`).join("")}</select></label>` : ""}
        ${d.action === "create" ? `<label>Name<input data-field="name" value="${safe(d.name)}" maxlength="${service ? 120 : 70}" required></label>${service ? `<label>Minutes<input data-field="duration" type="number" min="5" max="720" step="5" value="${safe(d.duration)}" required></label><label>Current price (RSD)<input data-field="price" type="number" min="0.01" max="1000000" step="0.01" value="${safe(d.price)}" required></label><label class="check"><input data-field="active" type="checkbox" ${d.active ? "checked" : ""}>Active treatment</label>` : ""}` : ""}</div>
      </article>`;
        })
        .join("") || '<p class="hint">No matching items.</p>';
    $("salon-items")
      .querySelectorAll("[data-candidate]")
      .forEach((card) => {
        const d = choices.get(visible[Number(card.dataset.candidate)].key);
        card.querySelectorAll("[data-field]").forEach((el) => {
          const update = () => {
            pending = null;
            d[el.dataset.field] =
              el.type === "checkbox" ? el.checked : el.value;
            $("salon-review-confirm").checked = false;
            if (el.dataset.field === "action") items();
            else summary();
          };
          el.addEventListener(
            el.tagName === "SELECT" || el.type === "checkbox"
              ? "change"
              : "input",
            update,
          );
        });
      });
    $("salon-prev").disabled = page === 0;
    $("salon-prev").dataset.locked = String(page === 0);
    $("salon-next").disabled = (page + 1) * 30 >= list.length;
    $("salon-next").dataset.locked = String((page + 1) * 30 >= list.length);
    $("salon-page").textContent = list.length
      ? `${page * 30 + 1}–${Math.min((page + 1) * 30, list.length)} of ${list.length}`
      : "0 items";
    $("salon-services").setAttribute(
      "aria-pressed",
      String(kind === "services"),
    );
    $("salon-therapists").setAttribute(
      "aria-pressed",
      String(kind === "therapists"),
    );
    summary();
  }
  async function apply(event) {
    event.preventDefault();
    if (busy || !preview) return;
    $("salon-error").hidden = true;
    try {
      const selected = [...choices.values()].map((d) => {
        if (d.action === "skip") return { key: d.key, action: d.action };
        if (d.action === "link") {
          if (!d.entityId)
            throw new Error(`Choose an existing match for ${d.name}.`);
          return { key: d.key, action: d.action, entityId: d.entityId };
        }
        const c = [...preview.services, ...preview.therapists].find(
          (v) => v.key === d.key,
        );
        if (!d.name.trim()) throw new Error("Every new item needs a name.");
        if (c.kind === "therapist")
          return { key: d.key, action: d.action, name: d.name.trim() };
        const duration = Number(d.duration),
          priceMinor = /^\d+(?:\.\d{1,2})?$/.test(String(d.price).trim())
            ? Number(String(d.price).split(".")[0]) * 100 +
              Number((String(d.price).split(".")[1] || "").padEnd(2, "0"))
            : NaN;
        if (
          !Number.isInteger(duration) ||
          duration < 5 ||
          duration > 720 ||
          duration % 5 ||
          !Number.isSafeInteger(priceMinor) ||
          priceMinor <= 0 ||
          priceMinor > 100000000
        )
          throw new Error(
            `Review the duration and current price for ${d.name}, or choose Skip.`,
          );
        return {
          key: d.key,
          action: d.action,
          name: d.name.trim(),
          duration,
          priceMinor,
          active: d.active,
        };
      });
      if (
        !$("salon-source-confirm").checked ||
        !$("salon-review-confirm").checked
      )
        throw new Error(
          "Confirm the source settings and reviewed choices before saving.",
        );
      pending ||= {
        previewId: preview.previewId,
        token: preview.token,
        fingerprint: preview.fingerprint,
        requestId: crypto.randomUUID(),
        acknowledgeReview: true,
        settings: {
          currency: $("salon-currency").value,
          minorUnitDigits: 2,
          timeZone: $("salon-zone").value,
        },
        choices: selected,
      };
      lock(true);
      const result = await api("/history/salon/apply", {
        method: "POST",
        body: pending,
      });
      if (!live()) return;
      $("salon-content").innerHTML =
        `<section class="history-card"><h3>Salon setup saved</h3><p>${safe(result.createdServices || 0)} treatments created · ${safe(result.createdTherapists || 0)} therapist profiles created · ${safe(result.skipped || 0)} skipped.</p><p>Set working hours and activate current therapists in Team when you are ready to book them. Skipped items remain in history and reports.</p><div class="history-actions"><button class="btn primary" data-destination="services">Open treatments</button><button class="btn" data-destination="team">Open team</button><button class="btn" data-destination="reports">View reports</button></div></section>`;
      root.querySelectorAll("[data-destination]").forEach((b) => {
        b.onclick = () => openPage(b.dataset.destination);
      });
    } catch (e) {
      error(e);
    } finally {
      if (live()) lock(false);
    }
  }
  load();
  return () => {
    disposed = true;
  };
}
