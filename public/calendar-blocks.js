import {
  calendarTop,
  calendarHeight,
  calendarTime,
} from "./calendar-geometry.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const operator = (role) => role === "owner" || role === "reception";
const overlaps = (a, b) =>
  a.start < b.start + b.duration && b.start < a.start + a.duration;

// Split visual collisions inside each physical table. The column remains the
// original room/therapist geometry, so clicks and drag targets retain their bed.
export function calendarResourceItems(
  resource,
  appointments = [],
  blocks = [],
) {
  const items = [];
  for (let bed = 0; bed < resource.capacity; bed++) {
    const entries = [
      ...appointments
        .filter(
          (a) =>
            !["cancelled", "no_show"].includes(a.status) &&
            (resource.kind === "therapist"
              ? a.therapistId === resource.id
              : a.roomId === resource.id && a.bed === bed),
        )
        .map((record) => ({ kind: "appointment", record, bed })),
      ...blocks
        .filter(
          (b) =>
            b.resourceType === resource.kind &&
            b.resourceId === resource.id &&
            (resource.kind === "therapist" || b.bed === null || b.bed === bed),
        )
        .map((record) => ({ kind: "block", record, bed })),
    ].sort(
      (a, b) =>
        a.record.start - b.record.start ||
        (a.kind === b.kind
          ? String(a.record.id).localeCompare(String(b.record.id))
          : a.kind === "appointment"
            ? -1
            : 1),
    );
    let cluster = [],
      end = -1;
    const finish = () => {
      const lanes = [];
      for (const item of cluster) {
        let lane = lanes.findIndex((last) => !overlaps(last, item.record));
        if (lane < 0) lane = lanes.length;
        lanes[lane] = item.record;
        item.lane = lane;
      }
      for (const item of cluster)
        items.push({
          ...item,
          left: ((bed + item.lane / lanes.length) * 100) / resource.capacity,
          width: 100 / (resource.capacity * lanes.length),
        });
    };
    for (const item of entries) {
      if (cluster.length && item.record.start >= end) {
        finish();
        cluster = [];
      }
      cluster.push(item);
      end = Math.max(
        cluster.length === 1 ? -1 : end,
        item.record.start + item.record.duration,
      );
    }
    if (cluster.length) finish();
  }
  return items;
}

export function calendarBlockLabel(block, role) {
  return operator(role) && block.title
    ? block.title
    : block.blocksAvailability
      ? "Blocked time"
      : "Calendar note";
}

export function calendarBlockHTML(item, role) {
  const b = item.record,
    title = calendarBlockLabel(b, role);
  const short = b.duration <= 15;
  const preview = short && operator(role) && b.note ? b.note : title;
  const time = `${calendarTime(b.start)}–${calendarTime(b.start + b.duration)}`;
  const kind = b.blocksAvailability ? "Blocked time" : "Note only";
  return `<button type="button" class="calendar-block ${b.blocksAvailability ? "is-blocking" : "is-note-only"}${short ? " is-short" : ""}" data-calendar-block="${escape(b.id)}" data-block-bed="${item.bed}" style="top:${calendarTop(b.start)}px;height:${calendarHeight(b.duration, 2)}px;left:calc(${item.left}% + 3px);width:calc(${item.width}% - 6px)" aria-label="${escape(`${kind}: ${title}. ${time}. ${b.duration} minutes.`)}"><span class="block-time">${time}</span><strong>${short ? `<span aria-hidden="true">${b.blocksAvailability ? "▧" : "✎"}</span> ` : ""}${escape(preview)}</strong><span class="block-kind"><span aria-hidden="true">${b.blocksAvailability ? "▧" : "✎"}</span> ${kind}</span>${operator(role) && b.note ? `<span class="block-note">${escape(b.note)}</span>` : ""}</button>`;
}

export function calendarBlockDetailsHTML(block, { role, catalogue }) {
  const resource = (
    block.resourceType === "room" ? catalogue.rooms : catalogue.therapists
  ).find((r) => r.id === block.resourceId);
  const place =
    (resource?.name || "Resource unavailable") +
    (block.resourceType === "room"
      ? block.bed === null
        ? " · All tables"
        : ` · Table ${block.bed + 1}`
      : "");
  return `<article class="calendar-block-details"><p class="block-detail-time">${calendarTime(block.start)}–${calendarTime(block.start + block.duration)} <span>· ${block.duration} minutes</span></p><h3>${escape(calendarBlockLabel(block, role))}</h3><p>${escape(place)}</p><p class="block-detail-kind">${block.blocksAvailability ? "Blocked time · appointments cannot overlap this resource." : "Note only · appointments can still be booked."}</p>${operator(role) && block.note ? `<section><span class="appointment-detail-label">Note</span><p class="client-note">${escape(block.note)}</p></section>` : ""}${operator(role) ? '<div class="calendar-block-actions"><button type="button" class="btn primary" id="calendar-block-edit">Edit blocked time</button><button type="button" class="btn danger" id="calendar-block-remove">Remove</button></div><p class="error" id="calendar-block-error" role="alert" hidden></p>' : ""}</article>`;
}
