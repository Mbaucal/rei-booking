const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const statuses = {
  booked: "Booked",
  confirmed: "Confirmed",
  done: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};
const clock = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const money = (cents) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "RSD" }).format(
    cents / 100,
  );
const dateLabel = (date) => {
  const parsed = new Date(date + "T12:00:00Z");
  return Number.isNaN(parsed.getTime())
    ? "Appointment"
    : new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed);
};

// Whitelist again at rendering time, including when a caller accidentally passes
// an owner-shaped object to a therapist or reception view. No client fetches.
export function appointmentDetailsHTML(
  appointment,
  { role, catalogue, variant = "summary" },
) {
  const a = appointment,
    preview = variant === "preview";
  const operator = role === "owner" || role === "reception";
  const therapist =
    catalogue.therapists.find((t) => t.id === a.therapistId)?.name ||
    "Therapist unavailable";
  const room =
    catalogue.rooms.find((r) => r.id === a.roomId)?.name || "Room unavailable";
  const requestedName =
    catalogue.therapists.find((t) => t.id === a.requestedTherapistId)?.name ||
    "Requested therapist";
  const requested = Boolean(a.requestedTherapistId);
  const fulfilled = a.requestedTherapistId === a.therapistId;
  const color = /^#[\da-f]{6}$/i.test(a.color || "") ? a.color : "#a8863d";
  const status = statuses[a.status] || "Appointment";
  const clientName =
    a.clientName || (a.clientId ? "Client name unavailable" : "Walk-in");
  const price =
    role === "owner" && Number.isSafeInteger(a.netCents) && a.netCents >= 0;
  const fullPrice =
    price && Number.isSafeInteger(a.grossCents) && a.grossCents > a.netCents;
  const field = (name, value) =>
    `<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`;
  return `<article class="appointment-summary${preview ? " is-preview" : ""}" style="--service:${color}">
    <header class="appointment-summary-heading"><p class="appointment-summary-date">${escape(dateLabel(a.date))}</p><div><h2>${escape(clock(a.start))}<span>–</span>${escape(clock(a.start + a.duration))}</h2><span class="appointment-status status-${Object.hasOwn(statuses, a.status) ? a.status : "unknown"}">${escape(status)}</span></div></header>
    ${operator ? `<section class="appointment-summary-client"><span class="appointment-client-symbol" aria-hidden="true">${a.clientId ? escape(clientName.trim().slice(0, 1).toUpperCase()) : "◇"}</span><div><span class="appointment-detail-label">Client</span><h3>${escape(clientName)}</h3></div></section>` : ""}
    <section class="appointment-summary-treatment"><span class="appointment-detail-label">Treatment</span><h3>${escape(a.serviceName)}</h3><div class="appointment-treatment-meta"><span>${escape(a.duration)} minutes</span>${price ? `<span class="appointment-treatment-price">${escape(money(a.netCents))}${fullPrice ? `<small>Full price ${escape(money(a.grossCents))}</small>` : ""}</span>` : ""}</div></section>
    <dl class="appointment-summary-resources">${field("Therapist", therapist)}${field("Room", room + ` · Table ${a.bed + 1}`)}</dl>
    ${requested ? `<p class="appointment-request ${fulfilled ? "is-fulfilled" : "is-reassigned"}"><span aria-hidden="true">♥</span><span><strong>${escape(requestedName)} requested</strong>${!fulfilled ? `<small>Assigned to ${escape(therapist)}</small>` : ""}</span></p>` : '<p class="appointment-no-request">No specific therapist request</p>'}
    ${!preview && operator && a.note ? `<section class="appointment-summary-note"><span class="appointment-detail-label">Appointment note</span><p>${escape(a.note)}</p></section>` : ""}
    ${!preview && operator && a.createdAt && !Number.isNaN(Date.parse(a.createdAt)) ? `<p class="appointment-created">Booked on ${escape(new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Belgrade" }).format(new Date(a.createdAt)))}</p>` : ""}
    ${!preview && operator ? `<div class="appointment-summary-actions"><button class="btn primary" type="button" id="appointment-summary-edit">Edit appointment</button>${["booked", "confirmed"].includes(a.status) ? '<button class="btn" type="button" id="appointment-summary-reschedule">Reschedule</button>' : ""}${a.clientId ? '<button class="btn appointment-profile-action" type="button" id="appointment-summary-client">Open client profile</button>' : ""}</div>` : ""}
  </article>`;
}

export function appointmentPreviewPosition(anchor, size, viewport) {
  const margin = 10,
    gap = 10;
  const left = viewport.left || 0,
    top = viewport.top || 0;
  const minX = left + margin,
    minY = top + margin;
  const maxX = Math.max(minX, left + viewport.width - size.width - margin);
  const maxY = Math.max(minY, top + viewport.height - size.height - margin);
  const preferredX =
    anchor.right + gap <= maxX
      ? anchor.right + gap
      : anchor.left - size.width - gap;
  return {
    left: Math.max(minX, Math.min(maxX, preferredX)),
    top: Math.max(minY, Math.min(maxY, anchor.top)),
  };
}

export function mountAppointmentPreview({
  root,
  appointments,
  role,
  catalogue,
  isCurrent,
  isBusy = () => false,
}) {
  const doc = root.ownerDocument,
    win = doc.defaultView,
    lifecycle = new AbortController();
  const listen = (el, name, fn, options = {}) =>
    el.addEventListener(name, fn, { ...options, signal: lifecycle.signal });
  const card = doc.createElement("aside");
  card.id = "appointment-hover";
  card.className = "appointment-hover";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  doc.body.append(card);
  let anchor = null,
    showTimer,
    hideTimer,
    suppressed = null,
    inputModality = "keyboard";
  const hoverCapability = win.matchMedia?.("(any-hover: hover)");
  const scrollPositionsAtShow = new Map();
  const available = () => isCurrent() && !isBusy();
  function dismiss() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (anchor?.getAttribute("aria-describedby") === card.id)
      anchor.removeAttribute("aria-describedby");
    anchor = null;
    scrollPositionsAtShow.clear();
    card.hidden = true;
    card.innerHTML = "";
  }
  function show(eventElement) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (
      !eventElement?.isConnected ||
      !available() ||
      suppressed === eventElement
    )
      return;
    const appointment = appointments.find(
      (a) => a.id === eventElement.dataset.appointment,
    );
    if (!appointment) return;
    if (anchor !== eventElement) dismiss();
    anchor = eventElement;
    card.innerHTML = appointmentDetailsHTML(appointment, {
      role,
      catalogue,
      variant: "preview",
    });
    const viewport = {
      left: win.visualViewport?.offsetLeft || 0,
      top: win.visualViewport?.offsetTop || 0,
      width: win.visualViewport?.width || doc.documentElement.clientWidth,
      height: win.visualViewport?.height || win.innerHeight,
    };
    card.style.maxWidth = `${Math.max(1, viewport.width - 20)}px`;
    card.style.maxHeight = `${Math.max(1, viewport.height - 20)}px`;
    card.hidden = false;
    const position = appointmentPreviewPosition(
      anchor.getBoundingClientRect(),
      card.getBoundingClientRect(),
      viewport,
    );
    card.style.left = `${position.left}px`;
    card.style.top = `${position.top}px`;
    for (let node = root; node; node = node.parentElement)
      scrollPositionsAtShow.set(node, {
        top: node.scrollTop,
        left: node.scrollLeft,
      });
    anchor.setAttribute("aria-describedby", card.id);
  }
  function leave() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, 180);
  }
  const eventAt = (target) => target?.closest?.("[data-appointment]");
  listen(root, "pointerover", (event) => {
    if (
      event.pointerType === "touch" ||
      event.buttons ||
      hoverCapability?.matches === false
    )
      return;
    const item = eventAt(event.target);
    if (!item || eventAt(event.relatedTarget) === item) return;
    suppressed = null;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (item === anchor) return;
    if (anchor) dismiss();
    showTimer = setTimeout(() => show(item), 110);
  });
  listen(root, "pointerout", (event) => {
    // Touch leaves the element when the finger lifts, before compatibility
    // focus/click events. Keep the tap dismissed through that whole sequence.
    if (event.pointerType === "touch") return;
    const item = eventAt(event.target);
    if (!item || eventAt(event.relatedTarget) === item) return;
    if (suppressed === item) suppressed = null;
    if (card.contains(event.relatedTarget)) {
      clearTimeout(hideTimer);
      return;
    }
    leave();
  });
  listen(card, "pointerenter", () => clearTimeout(hideTimer));
  listen(card, "pointerleave", (event) => {
    if (!anchor?.contains(event.relatedTarget)) leave();
  });
  listen(root, "focusin", (event) => {
    // A tap can focus a card before its click. Showing a clamped tooltip here
    // would cover the finger and may steal that click from the appointment.
    if (
      inputModality === "touch" ||
      (hoverCapability?.matches === false && inputModality !== "keyboard")
    )
      return;
    const item = eventAt(event.target);
    if (item) show(item);
  });
  listen(root, "focusout", (event) => {
    const item = eventAt(event.target);
    // Dismissal suppresses only the current interaction. A fresh keyboard visit
    // must show details again, just as leaving and re-entering with a pointer.
    if (item && eventAt(event.relatedTarget) !== item && suppressed === item)
      suppressed = null;
    if (item && !card.contains(event.relatedTarget)) leave();
  });
  listen(
    doc,
    "pointerdown",
    (event) => {
      inputModality = event.pointerType === "touch" ? "touch" : "pointer";
      if (card.contains(event.target)) return;
      suppressed = eventAt(event.target);
      dismiss();
    },
    { capture: true },
  );
  listen(
    root,
    "keydown",
    (event) => {
      if (["Enter", " "].includes(event.key) && eventAt(event.target)) {
        suppressed = eventAt(event.target);
        dismiss();
      }
    },
    { capture: true },
  );
  listen(
    doc,
    "keydown",
    (event) => {
      inputModality = "keyboard";
      if (event.key === "Escape") {
        suppressed = anchor;
        dismiss();
      }
    },
    { capture: true },
  );
  listen(
    doc,
    "scroll",
    (event) => {
      if (card.contains(event.target)) return;
      const scroller =
        event.target === doc ? doc.scrollingElement : event.target;
      const previous = scrollPositionsAtShow.get(scroller);
      if (
        !card.hidden &&
        previous &&
        previous.top === scroller.scrollTop &&
        previous.left === scroller.scrollLeft
      )
        return;
      dismiss();
    },
    { capture: true, passive: true },
  );
  listen(win, "resize", dismiss);
  if (win.visualViewport) {
    listen(win.visualViewport, "resize", dismiss);
    listen(win.visualViewport, "scroll", dismiss);
  }
  return {
    dismiss,
    dispose() {
      dismiss();
      lifecycle.abort();
      card.remove();
    },
  };
}
