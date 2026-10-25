import {
  calendarTop,
  calendarHeight,
  calendarTime,
} from "./calendar-geometry.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const operator = (role) => ["owner", "reception"].includes(role);
const color = (value) =>
  /^#[\da-f]{6}$/i.test(value || "") ? value : "#708f89";
const released = (a) => ["cancelled", "no_show"].includes(a.status);
export const isImportedAppointment = (a) => a?.imported === true;

// These resources are for the calendar only. Historical identities never enter
// the catalogue or become eligible booking/move targets through this helper.
export function calendarHistoryTherapists(current = [], historical = []) {
  const result = new Map(current.map((t) => [t.id, { ...t }]));
  for (const t of historical) {
    if (!result.has(t.id))
      result.set(t.id, {
        id: t.id,
        name: t.name,
        active: false,
        historyOnly: true,
        weekly: [],
        timeOff: [],
      });
  }
  return [...result.values()];
}

export function calendarAppointmentCounts(native = [], historical = []) {
  return {
    appointments: [...native, ...historical].filter((a) => !released(a)).length,
    imported: historical.length,
  };
}

export function calendarHistoryEventHTML(a, role, layout = {}) {
  const left = layout.left ?? 0,
    width = layout.width ?? 100,
    title = operator(role)
      ? a.clientName || "Client not recorded"
      : a.serviceName,
    status = a.sourceStatus || "Status not recorded",
    time = `${calendarTime(a.start)}–${calendarTime(a.start + a.duration)}`;
  return `<div class="calendar-event is-imported ${released(a) ? "is-released" : ""} ${width < 100 ? "is-overlapping" : ""} ${a.duration <= 30 ? "short" : ""} ${a.duration <= 15 ? "very-short" : ""}" role="button" tabindex="0" data-appointment="${esc(a.id)}" data-imported="true" style="top:${calendarTop(a.start)}px;height:${calendarHeight(a.duration, 3)}px;left:calc(${left}% + 3px);width:calc(${width}% - 6px);--service:${color(a.color)}" aria-label="${esc(`Imported appointment · ${title} · ${a.serviceName} · ${time} · ${a.duration} minutes · ${status}`)}"><span class="event-time"><span class="event-start">${calendarTime(a.start)}</span><span class="event-time-separator">–</span><span class="event-end">${calendarTime(a.start + a.duration)}</span></span><strong>${esc(title)}</strong><span class="event-service">${esc(operator(role) ? a.serviceName : a.duration + " minutes")}</span>${released(a) ? `<span class="event-history-status">${esc(status)}</span>` : ""}<span class="event-origin" title="Imported history · read-only">Imported</span>${a.requestState === "yes" ? '<span class="request-heart" title="Requested therapist">♥</span>' : ""}</div>`;
}

export function calendarHistoryDetailsHTML(a, { role, variant = "summary" }) {
  const preview = variant === "preview",
    clientName = a.clientName || "Client not recorded",
    status = a.sourceStatus || "Status not recorded",
    date = new Date(a.date + "T12:00:00Z"),
    dateLabel = Number.isNaN(date.getTime())
      ? "Imported appointment"
      : new Intl.DateTimeFormat("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(date),
    field = (label, value) =>
      `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`,
    request =
      a.requestState === "yes"
        ? '<p class="appointment-request is-fulfilled"><span aria-hidden="true">♥</span><span>Requested therapist</span></p>'
        : `<p class="appointment-no-request">${a.requestState === "no" ? "No specific therapist request" : "Request not recorded"}</p>`;
  // Render a deliberately small projection, even if the caller accidentally
  // passes private owner data to a therapist view. No notes or financial data.
  return `<article class="appointment-summary is-imported-summary${preview ? " is-preview" : ""}" style="--service:${color(a.color)}"><header class="appointment-summary-heading"><p class="appointment-summary-date">${esc(dateLabel)}</p><div><h2>${calendarTime(a.start)}<span>–</span>${calendarTime(a.start + a.duration)}</h2><span class="appointment-status ${released(a) ? "status-" + a.status : "status-unknown"}">${esc(status)}</span></div></header><p class="history-calendar-label">Imported history · read-only</p>${operator(role) ? `<section class="appointment-summary-client"><span class="appointment-client-symbol" aria-hidden="true">${esc(clientName.trim().slice(0, 1).toUpperCase())}</span><div><span class="appointment-detail-label">Client</span><h3>${esc(clientName)}</h3></div></section>` : ""}<section class="appointment-summary-treatment"><span class="appointment-detail-label">Treatment</span><h3>${esc(a.serviceName || "Treatment not recorded")}</h3><div class="appointment-treatment-meta"><span>${esc(a.duration)} minutes</span></div></section><dl class="appointment-summary-resources">${field("Therapist (source)", a.therapistName || "Not recorded")}${field("Room (source)", a.roomName || "Not recorded")}</dl>${request}${!preview && operator(role) && a.clientId ? '<div class="appointment-summary-actions"><button class="btn appointment-profile-action" type="button" id="appointment-summary-client">Open client profile</button></div>' : ""}</article>`;
}
