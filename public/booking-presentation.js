const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clock = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const integer = (value) => {
  if (
    !["string", "number"].includes(typeof value) ||
    String(value).trim() === ""
  )
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const named = (items, id) =>
  (Array.isArray(items) ? items : []).find((item) => item.id === id);
const name = (item, fallback) =>
  typeof item?.name === "string" && item.name.trim() ? item.name : fallback;

// Presentation only: describes the current form values, without claiming that
// a booking is saved or available. Client identities and prices are not read.
export function bookingSummary(selection, catalogue = {}) {
  let date = "Choose a date";
  if (
    typeof selection.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(selection.date)
  ) {
    const parsed = new Date(selection.date + "T12:00:00Z");
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === selection.date
    )
      date = new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed);
  }
  const match =
    typeof selection.start === "string" &&
    /^(\d{2}):(\d{2})$/.exec(selection.start);
  const start =
    match && Number(match[1]) < 24 && Number(match[2]) < 60
      ? Number(match[1]) * 60 + Number(match[2])
      : null;
  const validStart = start !== null && start % 5 === 0;
  const duration = integer(selection.duration);
  const validDuration =
    duration !== null && duration >= 5 && duration <= 720 && duration % 5 === 0;
  let time = "Choose a start time";
  if (validStart) {
    time = validDuration
      ? start + duration <= 1440
        ? `${clock(start)}–${clock(start + duration)}`
        : `${clock(start)} · end time exceeds this day`
      : `${clock(start)} · choose a duration`;
  }
  const selectedRoom = named(catalogue.rooms, selection.roomId),
    bed = integer(selection.bed);
  const table =
    selectedRoom &&
    Number.isInteger(selectedRoom.capacity) &&
    bed !== null &&
    bed >= 0 &&
    bed < selectedRoom.capacity
      ? `Table ${bed + 1}`
      : "Choose a table";
  return {
    date,
    time,
    duration: validDuration ? `${duration} min` : "Choose a duration",
    treatment: name(
      named(catalogue.services, selection.serviceId),
      "Choose a treatment",
    ),
    therapist: name(
      named(catalogue.therapists, selection.therapistId),
      "Choose a therapist",
    ),
    room: name(selectedRoom, "Choose a room"),
    table,
  };
}

export function bookingSummaryHTML(selection, catalogue) {
  const summary = bookingSummary(selection, catalogue);
  return `<p class="booking-summary-label">Current selection</p><p class="booking-summary-date">${escape(summary.date)}</p><div class="booking-summary-when"><strong class="booking-summary-time">${escape(summary.time)}</strong><span class="booking-summary-duration">${escape(summary.duration)}</span></div><p class="booking-summary-treatment">${escape(summary.treatment)}</p><p class="booking-summary-resources">${escape(summary.therapist)} · ${escape(summary.room)} · ${escape(summary.table)}</p>`;
}
