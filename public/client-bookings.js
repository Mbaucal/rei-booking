const count = (value) =>
  Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-GB")
    : "0";
const statuses = new Set([
  "booked",
  "confirmed",
  "done",
  "cancelled",
  "no_show",
]);

/** Native booking counts are lifetime totals, never inferred from page rows. */
export function renderClientBookings(
  data,
  { esc, prettyDate, clock, statusName, therapistName, roomName },
) {
  const safe = (value) => esc(String(value ?? "")),
    summary = data.appointmentSummary,
    pagination = data.appointmentPagination;
  return `<section aria-label="Bookings in Rei">
    <h3 class="form-section">Bookings in Rei</h3>
    <strong>${count(summary.completed)} completed ${summary.completed === 1 ? "visit" : "visits"}</strong>
    <p class="hint">${count(summary.total)} ${summary.total === 1 ? "booking" : "bookings"} · ${count(summary.cancelled)} cancelled · ${count(summary.noShow)} no-shows</p>
    <p id="client-bookings-loading" class="hint" role="status" hidden>Loading bookings…</p>
    <div id="client-bookings-error" class="client-history-error" role="alert" hidden></div>
    <div class="history">${
      data.appointments
        .map(
          (a) =>
            `<article data-client-booking="${safe(a.id)}"><strong>${safe(prettyDate(a.date))} · ${safe(clock(a.start))}</strong><p>${safe(a.serviceName)} · ${safe(a.duration)} min</p><p>${safe(therapistName(a.therapistId) || "Therapist unknown")} · ${safe(roomName(a.roomId) || "Room unknown")}</p><p><span class="status ${statuses.has(a.status) ? a.status : ""}">${safe(statusName(a.status))}</span>${a.requestedTherapistId ? " · ♥ Requested" : ""}</p></article>`,
        )
        .join("") || '<p class="hint">No appointments yet.</p>'
    }</div>
    ${
      pagination.totalPages > 1
        ? `<div class="client-history-pagination" aria-label="Booking pages"><button type="button" class="btn" id="client-bookings-prev" ${pagination.page <= 0 ? "disabled" : ""}>Previous</button><span>Page ${pagination.page + 1} of ${pagination.totalPages}</span><button type="button" class="btn" id="client-bookings-next" ${pagination.page + 1 >= pagination.totalPages ? "disabled" : ""}>Next</button></div>`
        : ""
    }
  </section>`;
}

export function mountClientBookings({
  root,
  api,
  esc,
  prettyDate,
  clock,
  statusName,
  therapistName,
  roomName,
  clientId,
  initialData,
  isCurrent,
}) {
  let generation = 0,
    disposed = false,
    busy = false,
    lastData = initialData;
  const display = {
      esc,
      prettyDate,
      clock,
      statusName,
      therapistName,
      roomName,
    },
    current = (version) => !disposed && isCurrent() && version === generation,
    $ = (id) => root.querySelector(`#${id}`);

  function render(data) {
    root.innerHTML = renderClientBookings(data, display);
    const previous = $("client-bookings-prev"),
      next = $("client-bookings-next");
    if (previous)
      previous.onclick = () => load(data.appointmentPagination.page - 1);
    if (next) next.onclick = () => load(data.appointmentPagination.page + 1);
  }

  async function load(page) {
    if (busy || disposed || !isCurrent()) return;
    const version = ++generation;
    busy = true;
    root.setAttribute("aria-busy", "true");
    $("client-bookings-loading").hidden = false;
    $("client-bookings-error").hidden = true;
    for (const id of ["client-bookings-prev", "client-bookings-next"])
      if ($(id)) $(id).disabled = true;
    try {
      const data = await api(
        `/clients/${encodeURIComponent(clientId)}?appointments_page=${page}`,
      );
      if (!current(version)) return;
      if (data.client?.id !== clientId)
        throw new Error(
          "These bookings could not be verified for the current client. Try again.",
        );
      render(data);
      lastData = data;
    } catch (error) {
      if (!current(version)) return;
      render(lastData);
      $("client-bookings-error").innerHTML =
        `<p>${esc(String(error.message || "Bookings could not be loaded."))}</p><button type="button" class="btn" id="client-bookings-retry">Try again</button>`;
      $("client-bookings-error").hidden = false;
      $("client-bookings-retry").onclick = () => load(page);
    } finally {
      if (current(version)) {
        busy = false;
        root.setAttribute("aria-busy", "false");
        $("client-bookings-loading").hidden = true;
      }
    }
  }

  render(initialData);
  return () => {
    disposed = true;
    generation++;
    for (const id of [
      "client-bookings-prev",
      "client-bookings-next",
      "client-bookings-retry",
    ])
      if ($(id)) $(id).onclick = null;
  };
}
