import {
  START,
  END,
  SCALE,
  STEP,
  clamp,
  calendarTop,
  calendarHeight,
  calendarTime,
  calendarStartAtY,
  calendarBedAtX,
} from "./calendar-geometry.js";

export const MOVE_THRESHOLD = 5;
export const TOUCH_TOLERANCE = 8;
export const LONG_PRESS_MS = 450;

// Moving keeps the complete appointment snapshot, including its original
// requested therapist, client, duration, prices, notes and version.
export function calendarMovedAppointment(
  original,
  candidate,
  resource,
  rect,
  point,
  offset = 0,
) {
  const moved = {
    ...original,
    start: calendarStartAtY(rect, point.y, original.duration, offset),
    therapistId: candidate.therapistId,
    roomId: candidate.roomId,
    bed: candidate.bed,
  };
  if (resource.kind === "therapist") moved.therapistId = resource.id;
  else {
    moved.roomId = resource.id;
    moved.bed = calendarBedAtX(rect, point.x, resource.capacity);
  }
  return moved;
}

export function sameCalendarPosition(a, b) {
  return ["date", "start", "therapistId", "roomId", "bed"].every(
    (key) => a[key] === b[key],
  );
}

// A save/confirmation can outlive its view. Callers receive a stale result
// instead of updating another calendar; concurrent clicks never duplicate PUTs.
export function createCalendarMoveSaver({
  onSave,
  isCurrent,
  confirmTherapistChange,
}) {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async save(original, candidate) {
      if (busy) return "busy";
      if (!isCurrent()) return "stale";
      if (sameCalendarPosition(original, candidate)) return "unchanged";
      busy = true;
      try {
        if (
          original.requestedTherapistId &&
          original.therapistId !== candidate.therapistId
        ) {
          const accepted = await confirmTherapistChange(original, candidate);
          if (!isCurrent()) return "stale";
          if (!accepted) return "cancelled";
        }
        if (!isCurrent()) return "stale";
        await onSave(
          { ...candidate, requestedTherapistId: original.requestedTherapistId },
          { ...original },
        );
        return isCurrent() ? "saved" : "stale";
      } catch (error) {
        if (!isCurrent()) return "stale";
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}

export function mountCalendarReschedule({
  root,
  getContext,
  isCurrent,
  onSave,
  onRefresh = () => {},
  onError = () => {},
  onModeChange = () => {},
  confirmTherapistChange,
}) {
  const doc = root.ownerDocument,
    win = doc.defaultView;
  const controller = new AbortController();
  const listen = (target, name, fn, options = {}) =>
    target.addEventListener(name, fn, {
      ...options,
      signal: controller.signal,
    });
  const confirmMove =
    confirmTherapistChange ||
    (() =>
      win.confirm(
        "Move this requested appointment to another therapist? The original request will stay recorded.",
      ));
  let disposed = false,
    generation = 0,
    draft = null,
    gesture = null,
    longPress = null,
    suppressUntil = 0,
    saving = false,
    pendingCommit = false;
  const current = () => !disposed && root.isConnected && isCurrent();
  const cards = () => [...root.querySelectorAll("[data-appointment]")];
  const columns = () => [...root.querySelectorAll("[data-resource]")];
  const byResource = (column) =>
    getContext().resources.find(
      (r) => r.id === column.dataset.resource && r.kind === column.dataset.kind,
    );
  const selectedCard = (target) => target?.closest?.("[data-appointment]");
  const activeCard = (target) => {
    const card = selectedCard(target);
    return card && root.contains(card) ? card : null;
  };
  const suppressClick = () => {
    suppressUntil = Date.now() + 750;
  };
  const stopTimer = () => {
    if (longPress !== null) win.clearTimeout(longPress);
    longPress = null;
  };
  function releaseGesture() {
    stopTimer();
    const previous = gesture;
    gesture = null;
    if (previous && root.hasPointerCapture?.(previous.id))
      root.releasePointerCapture(previous.id);
  }
  function capture(id) {
    try {
      root.setPointerCapture?.(id);
    } catch {
      /* Pointer may already have ended. */
    }
  }
  function clearDraft() {
    if (!draft) return;
    for (const preview of draft.previews) preview.remove();
    for (const [card, visibility] of draft.originals) {
      card.style.visibility = visibility;
      card.classList.remove("is-reschedule-source", "is-reschedule-selected");
    }
    draft.bar.remove();
    draft = null;
    root.classList.remove("is-rescheduling");
    if (current()) onModeChange(false);
  }
  function cancel() {
    ++generation;
    releaseGesture();
    if (draft) suppressClick();
    clearDraft();
    saving = false;
  }
  function button(label, id, action) {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = "btn";
    el.id = id;
    el.textContent = label;
    el.addEventListener("click", action);
    return el;
  }
  function setBusy(busy) {
    saving = busy;
    if (!draft) return;
    draft.bar.classList.toggle("is-saving", busy);
    draft.bar.setAttribute("aria-busy", String(busy));
    for (const control of draft.bar.querySelectorAll("button"))
      control.disabled = busy;
    draft.save.textContent = busy ? "Saving…" : "Save move";
    if (!busy) {
      draft.earlier.disabled = draft.candidate.start <= START;
      draft.later.disabled =
        draft.candidate.start + draft.candidate.duration >= END;
    }
  }
  function redraw() {
    if (!draft || !current()) return;
    const a = draft.candidate;
    for (const preview of draft.previews) preview.remove();
    draft.previews = [];
    for (const column of columns()) {
      const r = byResource(column);
      if (
        !r ||
        (r.kind === "therapist" ? r.id !== a.therapistId : r.id !== a.roomId)
      )
        continue;
      const template =
        draft.originals.find(
          ([card]) => card.closest("[data-resource]")?.dataset.kind === r.kind,
        )?.[0] || draft.originals[0]?.[0];
      if (!template) continue;
      const preview = template.cloneNode(true);
      preview.removeAttribute("id");
      preview.classList.remove("is-reschedule-source");
      preview.classList.add(
        "calendar-reschedule-preview",
        "is-reschedule-selected",
      );
      preview.style.visibility = "";
      preview.style.touchAction = "none";
      preview.style.top = `${calendarTop(a.start)}px`;
      preview.style.height = `${calendarHeight(a.duration, 3)}px`;
      const lane = r.kind === "room" ? a.bed : 0;
      preview.style.left = `calc(${(lane / r.capacity) * 100}% + 3px)`;
      preview.style.width = `calc(${100 / r.capacity}% - 6px)`;
      const time = preview.querySelector(".event-time");
      if (time)
        time.textContent = `${calendarTime(a.start)}–${calendarTime(a.start + a.duration)}`;
      const label = preview.querySelector(".event-room");
      const context = getContext();
      const related = context.resources.find((resource) =>
        r.kind === "room"
          ? resource.kind === "therapist" && resource.id === a.therapistId
          : resource.kind === "room" && resource.id === a.roomId,
      );
      if (label && related)
        label.textContent =
          related.name +
          (r.kind === "therapist" ? ` · table ${a.bed + 1}` : "");
      preview.setAttribute(
        "aria-label",
        `${a.serviceName}. Move draft ${calendarTime(a.start)} to ${calendarTime(a.start + a.duration)}. ${r.name}.`,
      );
      column.append(preview);
      draft.previews.push(preview);
    }
    const context = getContext(),
      therapist = context.resources.find(
        (r) => r.kind === "therapist" && r.id === a.therapistId,
      ),
      room = context.resources.find(
        (r) => r.kind === "room" && r.id === a.roomId,
      );
    draft.time.textContent = `${calendarTime(a.start)}–${calendarTime(a.start + a.duration)} · ${a.duration} min`;
    draft.resource.textContent = [
      therapist?.name,
      room?.name,
      `Table ${a.bed + 1}`,
    ]
      .filter(Boolean)
      .join(" · ");
    setBusy(saving);
  }
  function start(id, { touch = true, focus = true } = {}) {
    if (!current() || saving || pendingCommit) return false;
    const original = getContext().appointments.find((a) => a.id === id);
    const originals = cards().filter(
      (card) =>
        card.dataset.appointment === id &&
        !card.classList.contains("calendar-reschedule-preview"),
    );
    if (!original || !originals.length) return false;
    cancel();
    const token = ++generation;
    const bar = doc.createElement("section");
    bar.id = "calendar-reschedule-bar";
    bar.className = "calendar-reschedule-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Reschedule appointment");
    const time = doc.createElement("strong"),
      resource = doc.createElement("p"),
      instruction = doc.createElement("p"),
      error = doc.createElement("p");
    time.id = "calendar-reschedule-time";
    time.setAttribute("aria-live", "polite");
    resource.id = "calendar-reschedule-resource";
    instruction.id = "calendar-reschedule-instruction";
    instruction.textContent = touch
      ? "Lift your finger, then drag the selected appointment, or use the time buttons. Save move to confirm."
      : "Drag the selected appointment to another time, therapist or room.";
    error.id = "calendar-reschedule-error";
    error.className = "error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    const shift = (delta) => {
      if (!draft || saving || !current()) return;
      draft.candidate.start = clamp(
        draft.candidate.start + delta,
        START,
        END - draft.candidate.duration,
      );
      draft.error.hidden = true;
      redraw();
    };
    const earlier = button("−5 min", "calendar-reschedule-earlier", () =>
      shift(-STEP),
    );
    const later = button("+5 min", "calendar-reschedule-later", () =>
      shift(STEP),
    );
    const cancelButton = button("Cancel", "calendar-reschedule-cancel", () => {
      if (!saving) cancel();
    });
    const save = button(
      "Save move",
      "calendar-reschedule-save",
      () => void commit(),
    );
    save.classList.add("primary");
    bar.append(
      time,
      resource,
      instruction,
      error,
      earlier,
      later,
      cancelButton,
      save,
    );
    const writeState = { started: false };
    const saver = createCalendarMoveSaver({
      onSave: async (...args) => {
        writeState.started = true;
        await onSave(...args);
      },
      isCurrent: () => current() && generation === token && !!draft,
      confirmTherapistChange: confirmMove,
    });
    draft = {
      original: { ...original },
      candidate: { ...original },
      touch,
      originals: originals.map((card) => [card, card.style.visibility]),
      previews: [],
      bar,
      time,
      resource,
      error,
      earlier,
      later,
      save,
      saver,
      writeState,
      token,
    };
    for (const card of originals) {
      card.classList.add("is-reschedule-source", "is-reschedule-selected");
      card.style.visibility = "hidden";
    }
    root.classList.add("is-rescheduling");
    doc.body.append(bar);
    onModeChange(true);
    redraw();
    suppressClick();
    if (focus) {
      draft.previews[0]?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
      save.focus({ preventScroll: true });
    }
    return true;
  }
  async function commit() {
    if (!draft || saving || pendingCommit || !current()) return;
    const selected = draft;
    pendingCommit = true;
    selected.error.hidden = true;
    setBusy(true);
    try {
      const result = await selected.saver.save(
        selected.original,
        selected.candidate,
      );
      pendingCommit = false;
      if (!current()) return;
      if (draft !== selected) {
        // Blur cancels the visible draft, not a request already received by the
        // server. Refresh only the same still-current calendar after it settles.
        if (selected.writeState.started) await refreshAfterSave();
        return;
      }
      if (result === "cancelled" || result === "busy") {
        setBusy(false);
        return;
      }
      if (result === "stale") return;
      cancel();
      if (result === "saved") await refreshAfterSave();
    } catch (error) {
      if (!current() || draft !== selected) return;
      selected.error.textContent =
        error.message || "This appointment could not be moved. Try again.";
      selected.error.hidden = false;
      setBusy(false);
      onError(error);
    } finally {
      pendingCommit = false;
    }
  }
  async function refreshAfterSave() {
    if (!current()) return;
    try {
      await onRefresh();
    } catch (error) {
      if (current()) onError(error);
    }
  }
  function updateAt(event) {
    if (!draft || !gesture || !current()) return false;
    const column = doc
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("[data-resource]");
    if (!column || !root.contains(column)) return false;
    const resource = byResource(column);
    if (!resource) return false;
    draft.candidate = calendarMovedAppointment(
      draft.original,
      draft.candidate,
      resource,
      column.getBoundingClientRect(),
      { x: event.clientX, y: event.clientY },
      gesture.offset,
    );
    draft.error.hidden = true;
    redraw();
    return true;
  }
  listen(root, "pointerdown", (event) => {
    if (
      !current() ||
      event.button !== 0 ||
      event.isPrimary === false ||
      saving ||
      pendingCommit
    )
      return;
    // A new deliberate gesture may act immediately; only the synthetic click
    // from the completed move remains suppressed.
    if (!draft) suppressUntil = 0;
    const card = activeCard(event.target);
    if (!card) return;
    if (draft && card.dataset.appointment !== draft.original.id) {
      event.preventDefault();
      return;
    }
    const a =
      draft?.candidate ||
      getContext().appointments.find(
        (item) => item.id === card.dataset.appointment,
      );
    if (!a) return;
    suppressUntil = 0;
    releaseGesture();
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      appointmentId: a.id,
      touch: event.pointerType === "touch",
      moved: false,
      selectedOnly: false,
      offset: (event.clientY - card.getBoundingClientRect().top) / SCALE,
    };
    if (draft) {
      capture(event.pointerId);
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (gesture.touch) {
      const pending = gesture;
      longPress = win.setTimeout(() => {
        longPress = null;
        if (gesture !== pending || !current()) return;
        // touch-action for this gesture was chosen before long-press. Select
        // now; the next drag starts on a touch-action:none preview.
        if (start(pending.appointmentId, { touch: true, focus: false })) {
          gesture = { ...pending, selectedOnly: true };
          suppressClick();
        }
      }, LONG_PRESS_MS);
    }
  });
  listen(
    doc,
    "pointermove",
    (event) => {
      if (!gesture || gesture.id !== event.pointerId || !current()) return;
      const distance = Math.hypot(
        event.clientX - gesture.x,
        event.clientY - gesture.y,
      );
      if (gesture.selectedOnly) return;
      if (!draft && gesture.touch) {
        if (distance > TOUCH_TOLERANCE) {
          suppressClick();
          releaseGesture();
        }
        return;
      }
      if (!gesture.moved && distance < MOVE_THRESHOLD) return;
      if (!draft) {
        const pending = gesture;
        if (!start(pending.appointmentId, { touch: false, focus: false })) {
          releaseGesture();
          return;
        }
        gesture = pending;
        capture(event.pointerId);
      }
      gesture.moved = true;
      if (event.cancelable) event.preventDefault();
      updateAt(event);
    },
    { passive: false },
  );
  listen(doc, "pointerup", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const ended = gesture;
    const droppedInside = ended.moved && draft && current() && updateAt(event);
    releaseGesture();
    if (ended.moved || ended.selectedOnly) suppressClick();
    if (ended.moved && draft && !draft.touch && current()) {
      if (droppedInside) void commit();
      else cancel();
    }
  });
  listen(doc, "pointercancel", (event) => {
    if (gesture?.id === event.pointerId) {
      suppressClick();
      cancel();
    }
  });
  listen(win, "blur", () => cancel());
  listen(doc, "visibilitychange", () => {
    if (doc.hidden) cancel();
  });
  listen(doc, "keydown", (event) => {
    if (event.key === "Escape" && draft && !saving) {
      event.preventDefault();
      cancel();
    }
  });
  listen(root, "contextmenu", (event) => {
    if (gesture?.touch || draft) event.preventDefault();
  });
  const shouldSuppressClick = () =>
    !!draft || pendingCommit || Date.now() < suppressUntil;
  listen(
    doc,
    "click",
    (event) => {
      if (root.contains(event.target) && shouldSuppressClick(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  return {
    start,
    begin: start,
    cancel,
    isActive: () => !!draft || !!gesture || pendingCommit,
    shouldSuppressClick,
    dispose() {
      cancel();
      disposed = true;
      controller.abort();
    },
  };
}
