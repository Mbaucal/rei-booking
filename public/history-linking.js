/** Owner-reviewed links from immutable imported visits to existing clients. */
export function renderHistoryLinking({
  root,
  api,
  esc,
  isCurrent,
  back,
  openProfile,
}) {
  let disposed = false,
    busy = false,
    groupsOffset = 0,
    review = null;
  let selectedClient = null,
    pending = null,
    stale = false,
    uncertain = false;
  let searchSequence = 0,
    loadSequence = 0;
  const selectedRows = new Set();
  const live = () => !disposed && isCurrent();
  const $ = (id) => root.querySelector(`#${id}`);
  const safe = (value) => esc(String(value ?? ""));
  const clock = (value) =>
    Number.isInteger(value)
      ? `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
      : "Time unknown";
  root.innerHTML = `<section class="history-preview history-salon history-linking">
    <div class="history-topline"><button class="btn" id="links-back">← Back to history</button><span class="history-badge">Saved visits</span></div>
    <h2>Link imported clients</h2><p class="history-lead">Choose saved visits and the existing client they belong to. Original report details stay unchanged.</p>
    <p class="error" id="links-error" role="alert" hidden></p><div id="links-content"><p role="status">Reading saved visits…</p></div>
  </section>`;
  $("links-back").onclick = () => {
    if (!busy) back();
  };
  const clearError = () => {
    $("links-error").hidden = true;
  };
  const showError = (error) => {
    if (!live()) return;
    $("links-error").textContent =
      error.message || "The request could not be completed.";
    $("links-error").hidden = false;
  };
  function lock(value) {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    root.querySelectorAll("input,select,button").forEach((el) => {
      el.disabled =
        value ||
        el.dataset.locked === "true" ||
        (uncertain && !["links-apply", "links-back"].includes(el.id));
    });
  }
  function changed() {
    pending = null;
    if ($("links-ack")) $("links-ack").checked = false;
    selectionSummary();
  }
  async function loadGroups() {
    const sequence = ++loadSequence;
    searchSequence++;
    clearError();
    uncertain = false;
    lock(true);
    try {
      const data = await api(
        `/history/links/groups?offset=${groupsOffset}&limit=30`,
      );
      if (!live() || sequence !== loadSequence) return;
      review = null;
      pending = null;
      selectedRows.clear();
      selectedClient = null;
      $("links-content").innerHTML = `<section class="history-card">
        <h3>${data.unlinkedRows ? `${safe(data.unlinkedRows)} visits to link` : "All saved visits are linked"}</h3>
        ${data.unlinkedRows ? '<p class="hint">Groups use the client details in the source report. Review the visits before choosing a client.</p>' : "<p>There are no imported visits waiting for a client link.</p>"}
        <div id="links-groups">${data.groups.map((group, index) => `<article class="salon-candidate"><header><strong>${safe(group.label || "Unknown client")}</strong><small>${safe(group.source)} · ${safe(group.count)} visits</small></header><p class="hint">${safe(group.from)} – ${safe(group.to)}</p><button class="btn" data-link-group="${index}">Review visits</button></article>`).join("")}</div>
        <div class="history-pagination"><button class="btn" id="links-groups-prev" ${groupsOffset === 0 ? 'disabled data-locked="true"' : ""}>Previous</button><span role="status">${data.total ? `${groupsOffset + 1}–${Math.min(groupsOffset + data.groups.length, data.total)} of ${data.total} groups` : "0 groups"}</span><button class="btn" id="links-groups-next" ${groupsOffset + data.groups.length >= data.total ? 'disabled data-locked="true"' : ""}>Next</button></div>
      </section>`;
      root.querySelectorAll("[data-link-group]").forEach((button) => {
        button.onclick = () =>
          loadReview(data.groups[Number(button.dataset.linkGroup)].key, 0);
      });
      $("links-groups-prev").onclick = () => {
        groupsOffset = Math.max(0, groupsOffset - 30);
        loadGroups();
      };
      $("links-groups-next").onclick = () => {
        groupsOffset += 30;
        loadGroups();
      };
    } catch (error) {
      if (live() && sequence === loadSequence) {
        showError(error);
        $("links-content").innerHTML =
          '<button class="btn" id="links-load-retry">Try again</button>';
        $("links-load-retry").onclick = loadGroups;
      }
    } finally {
      if (live() && sequence === loadSequence) lock(false);
    }
  }
  async function loadReview(groupKey, offset, preserve = false) {
    const sequence = ++loadSequence;
    searchSequence++;
    clearError();
    uncertain = false;
    lock(true);
    try {
      const next = await api(
        `/history/links/review?groupKey=${encodeURIComponent(groupKey)}&offset=${offset}`,
      );
      if (!live() || sequence !== loadSequence) return;
      review = next;
      stale = false;
      pending = null;
      if (!preserve) {
        selectedRows.clear();
        selectedClient = null;
      }
      for (const id of selectedRows)
        if (!next.rows.some((row) => row.id === id)) selectedRows.delete(id);
      // Refresh the selected identity only when this review supplies its current version.
      if (selectedClient)
        selectedClient =
          next.candidates.find((client) => client.id === selectedClient.id) ||
          null;
      renderReview();
    } catch (error) {
      if (live() && sequence === loadSequence) {
        showError(error);
        if (!review) {
          $("links-content").innerHTML =
            '<button class="btn" id="links-review-retry">Try again</button><button class="btn" id="links-review-groups">Back to groups</button>';
          $("links-review-retry").onclick = () => loadReview(groupKey, offset);
          $("links-review-groups").onclick = loadGroups;
        }
      }
    } finally {
      if (live() && sequence === loadSequence) lock(false);
    }
  }
  function renderReview() {
    $("links-content").innerHTML = `<form id="links-form">
      <section class="history-card"><div class="history-actions"><button class="btn" type="button" id="links-all-groups">All groups</button><button class="btn" type="button" id="links-refresh">Refresh review</button></div>
        <h3>${safe(review.group.label || "Unknown client")}</h3><p class="hint">${safe(review.group.source)} · ${safe(review.total)} unlinked visits. Select visits shown on this page.</p>
        ${review.ambiguous ? '<p class="hint">This source name may refer to more than one client. Check each visit and its source contact details.</p>' : ""}
        <label class="check"><input type="checkbox" id="links-select-page">Select all visits on this page</label>
        <div id="links-rows">${review.rows.map((row, index) => `<article class="salon-candidate"><label class="check"><input type="checkbox" data-link-row="${index}" ${selectedRows.has(row.id) ? "checked" : ""}><strong>${safe(row.date)} · ${safe(clock(row.startMinute))} · ${safe(row.duration)} min</strong></label><p>${safe(row.serviceName || "Treatment unknown")} · ${safe(row.therapistName || "Therapist unknown")}</p><p class="hint">${safe(row.clientLabel || "Unknown client")} · ${safe(row.status)}${row.sourceClientId ? ` · Source client ID: ${safe(row.sourceClientId)}` : ""}${row.phone ? ` · ${safe(row.phone)}` : ""}${row.email ? ` · ${safe(row.email)}` : ""}${row.instagram ? ` · ${safe(row.instagram)}` : ""}</p></article>`).join("") || "<p>No unlinked visits remain on this page.</p>"}</div>
        <div class="history-pagination"><button class="btn" type="button" id="links-rows-prev" ${review.offset === 0 ? 'disabled data-locked="true"' : ""}>Previous visits</button><span>${review.rows.length ? `${review.offset + 1}–${review.offset + review.rows.length} of ${review.total}` : "0 visits"}</span><button class="btn" type="button" id="links-rows-next" ${!review.hasMore ? 'disabled data-locked="true"' : ""}>Next visits</button></div>
      </section>
      <section class="history-card"><h3>Choose an existing client</h3><p class="hint">A matching name is a suggestion. Check the contact details before selecting.</p>
        <label>Search clients<input id="links-search" type="search" maxlength="100" placeholder="Name, phone or email"></label><button class="btn" type="button" id="links-search-button">Search</button>
        <p id="links-search-status" class="hint" role="status"></p><div id="links-clients"></div><p id="links-chosen" role="status"></p>
      </section>
      <section class="history-card"><p id="links-selection" role="status"></p><label class="check"><input type="checkbox" id="links-ack">I checked that the selected visits belong to this client.</label><div class="history-actions"><button class="btn primary" id="links-apply" type="submit">Link selected visits</button><button class="btn" type="button" id="links-cancel">Cancel</button></div><p id="links-retry-note" class="hint" hidden></p></section>
    </form>`;
    $("links-all-groups").onclick = loadGroups;
    $("links-cancel").onclick = loadGroups;
    $("links-refresh").onclick = () =>
      loadReview(review.group.key, review.offset, true);
    $("links-rows-prev").onclick = () =>
      loadReview(review.group.key, Math.max(0, review.offset - 100));
    $("links-rows-next").onclick = () =>
      loadReview(review.group.key, review.offset + review.rows.length);
    root.querySelectorAll("[data-link-row]").forEach((input) => {
      input.onchange = () => {
        const id = review.rows[Number(input.dataset.linkRow)].id;
        input.checked ? selectedRows.add(id) : selectedRows.delete(id);
        changed();
      };
    });
    $("links-select-page").onchange = (event) => {
      review.rows.forEach((row) =>
        event.target.checked
          ? selectedRows.add(row.id)
          : selectedRows.delete(row.id),
      );
      root.querySelectorAll("[data-link-row]").forEach((input) => {
        input.checked = event.target.checked;
      });
      changed();
    };
    $("links-search-button").onclick = searchClients;
    $("links-search").onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        searchClients();
      }
    };
    $("links-form").onsubmit = apply;
    showClients(review.candidates);
    selectionSummary();
  }
  function showClients(clients) {
    $("links-clients").innerHTML =
      clients
        .map(
          (client, index) =>
            `<article class="salon-candidate"><strong>${safe(client.name)}</strong><p class="hint">${safe(client.phone || "No phone")} · ${safe(client.email || "No email")}</p><button class="btn" type="button" data-link-client="${index}">${selectedClient?.id === client.id ? "Selected" : "Select client"}</button></article>`,
        )
        .join("") ||
      '<p class="hint">No matching clients. Search for an existing client above.</p>';
    root.querySelectorAll("[data-link-client]").forEach((button) => {
      button.onclick = () => {
        if (busy || uncertain) return;
        selectedClient = clients[Number(button.dataset.linkClient)];
        changed();
        showClients(clients);
      };
    });
  }
  function selectionSummary() {
    if (!$("links-selection")) return;
    $("links-selection").textContent =
      `${selectedRows.size} visits selected${selectedClient ? ` → ${selectedClient.name}` : " · No client selected"}`;
    $("links-chosen").textContent = selectedClient
      ? `Selected: ${selectedClient.name} · ${selectedClient.phone || selectedClient.email || "No contact details"}`
      : "No client selected.";
    $("links-select-page").checked =
      review.rows.length > 0 && selectedRows.size === review.rows.length;
    $("links-select-page").indeterminate =
      selectedRows.size > 0 && selectedRows.size < review.rows.length;
  }
  async function searchClients() {
    if (busy || uncertain) return;
    const sequence = ++searchSequence,
      currentReview = review.reviewId;
    $("links-search-status").textContent = "Searching…";
    clearError();
    try {
      const data = await api(
        `/clients?q=${encodeURIComponent($("links-search").value.trim())}`,
      );
      if (
        !live() ||
        sequence !== searchSequence ||
        review?.reviewId !== currentReview ||
        uncertain
      )
        return;
      showClients(data.clients || []);
      $("links-search-status").textContent =
        `${(data.clients || []).length} clients found`;
    } catch (error) {
      if (
        live() &&
        sequence === searchSequence &&
        review?.reviewId === currentReview
      ) {
        showError(error);
        $("links-search-status").textContent =
          "Search failed. Your selection is unchanged.";
      }
    }
  }
  async function apply(event) {
    event.preventDefault();
    if (busy || !review) return;
    clearError();
    try {
      if (!pending) {
        if (stale)
          throw new Error("Refresh this review before linking visits.");
        if (!selectedRows.size || !selectedClient)
          throw new Error("Select visits and an existing client first.");
        if (!$("links-ack").checked)
          throw new Error(
            "Confirm that you checked the selected visits and client.",
          );
        pending = {
          reviewId: review.reviewId,
          token: review.token,
          fingerprint: review.fingerprint,
          requestId: crypto.randomUUID(),
          clientId: selectedClient.id,
          clientVersion: selectedClient.version,
          archiveIds: [...selectedRows].sort(),
          acknowledgeReview: true,
        };
      }
      searchSequence++;
      lock(true);
      const result = await api("/history/links/apply", {
        method: "POST",
        body: pending,
      });
      if (!live()) return;
      uncertain = false;
      pending = null;
      $("links-content").innerHTML =
        `<section class="history-card" role="status"><h3>Visits linked</h3><p>${safe(result.linked)} visits linked to ${safe(result.client.name)}. ${safe(result.remaining)} visits remain in this source group.</p><div class="history-actions">${openProfile ? '<button class="btn primary" id="links-open-profile">Open client profile</button>' : ""}<button class="btn" id="links-continue">Continue linking</button></div></section>`;
      if (openProfile)
        $("links-open-profile").onclick = () => openProfile(result.client.id);
      $("links-continue").onclick = () => {
        groupsOffset = 0;
        loadGroups();
      };
    } catch (error) {
      if (!live()) return;
      showError(error);
      if (pending) {
        if (error.status && error.status < 500) {
          pending = null;
          uncertain = false;
          stale = [409, 410].includes(error.status);
          $("links-ack").checked = false;
          $("links-apply").textContent = "Link selected visits";
        } else {
          uncertain = true;
          $("links-apply").textContent = "Check result / retry";
          $("links-retry-note").textContent =
            "The confirmation did not arrive. Retry checks the same request; it will not link visits twice.";
          $("links-retry-note").hidden = false;
        }
      }
    } finally {
      if (live()) lock(false);
    }
  }
  loadGroups();
  return () => {
    disposed = true;
    searchSequence++;
    loadSequence++;
  };
}
