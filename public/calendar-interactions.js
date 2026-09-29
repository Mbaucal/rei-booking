const START = 600,
  END = 1320,
  SCALE = 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const time = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function calendarSlotAtPoint(rect, point, capacity = 1) {
  const start = clamp(
    Math.round(((point.y - rect.top) / SCALE + START) / 5) * 5,
    START,
    END - 5,
  );
  return {
    start,
    bandStart: Math.floor(start / 30) * 30,
    bed: clamp(
      Math.floor(((point.x - rect.left) / rect.width) * capacity),
      0,
      capacity - 1,
    ),
  };
}

export function calendarMenuPosition(anchor, size, viewport) {
  const margin = 8,
    gap = 12;
  const minX = (viewport.left || 0) + margin,
    minY = (viewport.top || 0) + margin;
  const maxX = Math.max(
    minX,
    (viewport.left || 0) + viewport.width - size.width - margin,
  );
  const maxY = Math.max(
    minY,
    (viewport.top || 0) + viewport.height - size.height - margin,
  );
  return {
    left: clamp(
      anchor.x + gap <= maxX ? anchor.x + gap : anchor.x - size.width - gap,
      minX,
      maxX,
    ),
    top: clamp(
      anchor.y + gap <= maxY ? anchor.y + gap : anchor.y - size.height - gap,
      minY,
      maxY,
    ),
  };
}

export function mountCalendarInteractions({
  root,
  resources,
  date,
  onAdd,
  isCurrent,
}) {
  const doc = root.ownerDocument,
    win = doc.defaultView;
  const controller = new AbortController();
  const listen = (target, name, fn, options = {}) =>
    target.addEventListener(name, fn, {
      ...options,
      signal: controller.signal,
    });
  const menu = doc.createElement("div");
  menu.id = "calendar-slot-menu";
  menu.className = "calendar-slot-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Calendar quick actions");
  menu.hidden = true;
  menu.innerHTML =
    '<div class="slot-menu-heading"><div><strong id="calendar-slot-menu-time"></strong><span id="calendar-slot-menu-resource"></span></div><button type="button" id="calendar-slot-close" aria-label="Close quick actions">×</button></div><button type="button" id="calendar-slot-add"><span aria-hidden="true">＋</span>Add appointment</button>';
  doc.body.append(menu);
  const add = menu.querySelector("#calendar-slot-add");
  const hint = doc.createElement("div");
  hint.className = "calendar-slot-hint";
  hint.setAttribute("aria-hidden", "true");
  const marker = doc.createElement("span");
  marker.className = "calendar-slot-time";
  hint.append(marker);
  let selected = null,
    menuColumn = null,
    gesture = null,
    blockClick = false,
    keyboardScroll = null;
  const remembered = new WeakMap();
  const columns = [...root.querySelectorAll("[data-resource]")];
  const resource = (column) =>
    resources.find(
      (r) => r.id === column.dataset.resource && r.kind === column.dataset.kind,
    );
  const viewport = () => ({
    left: win.visualViewport?.offsetLeft || 0,
    top: win.visualViewport?.offsetTop || 0,
    width: win.visualViewport?.width || doc.documentElement.clientWidth,
    height: win.visualViewport?.height || win.innerHeight,
  });
  function dismiss({
    restoreFocus = false,
    blockClick: suppress = false,
  } = {}) {
    const previous = menuColumn;
    menu.hidden = true;
    selected = null;
    menuColumn = null;
    hint.remove();
    if (suppress) blockClick = true;
    if (restoreFocus && previous?.isConnected)
      previous.focus({ preventScroll: true });
  }
  function showHint(column, slot) {
    const r = resource(column);
    remembered.set(column, slot);
    hint.dataset.start = String(slot.start);
    hint.dataset.bandStart = String(slot.bandStart);
    hint.dataset.bed = String(slot.bed);
    hint.style.top = `${(slot.bandStart - START) * SCALE}px`;
    hint.style.left = `${(slot.bed / r.capacity) * 100}%`;
    hint.style.width = `${100 / r.capacity}%`;
    marker.style.top = `${(slot.start - slot.bandStart) * SCALE}px`;
    marker.textContent = time(slot.start);
    column.append(hint);
  }
  function open(column, slot, anchor) {
    if (!isCurrent()) return;
    dismiss();
    const r = resource(column);
    selected = {
      date,
      start: slot.start,
      ...(r.kind === "therapist"
        ? { therapistId: r.id }
        : { roomId: r.id, bed: slot.bed }),
    };
    menuColumn = column;
    showHint(column, slot);
    menu.querySelector("#calendar-slot-menu-time").textContent = time(
      slot.start,
    );
    menu.querySelector("#calendar-slot-menu-resource").textContent =
      r.name + (r.kind === "room" ? ` · Table ${slot.bed + 1}` : "");
    const visible = viewport();
    menu.style.maxWidth = `${Math.max(1, visible.width - 16)}px`;
    menu.style.maxHeight = `${Math.max(1, visible.height - 16)}px`;
    menu.hidden = false;
    const box = menu.getBoundingClientRect(),
      position = calendarMenuPosition(anchor, box, visible);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    add.focus({ preventScroll: true });
  }
  function fromPointer(column, event) {
    return calendarSlotAtPoint(
      column.getBoundingClientRect(),
      { x: event.clientX, y: event.clientY },
      resource(column).capacity,
    );
  }
  function initialKeyboardSlot(column) {
    const box = column.getBoundingClientRect(),
      scrollBox = root.getBoundingClientRect();
    const top = Math.max(box.top, scrollBox.top + 76, 0);
    return calendarSlotAtPoint(
      box,
      { x: box.left + 8, y: top + 10 },
      resource(column).capacity,
    );
  }
  for (const column of columns) {
    column.tabIndex = 0;
    column.setAttribute(
      "aria-label",
      `${resource(column).name}. Use up and down arrows to choose a time, then Enter for booking options.`,
    );
    listen(column, "pointerdown", (event) => {
      if (event.target.closest("[data-appointment]") || event.button !== 0)
        return;
      blockClick = false;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
    });
    listen(column, "pointermove", (event) => {
      if (
        gesture?.id === event.pointerId &&
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8
      )
        gesture.moved = true;
      if (
        !menu.hidden ||
        event.pointerType === "touch" ||
        event.buttons ||
        !isCurrent()
      )
        return;
      if (event.target.closest("[data-appointment]")) {
        hint.remove();
        return;
      }
      showHint(column, fromPointer(column, event));
    });
    listen(column, "pointerleave", () => {
      if (menu.hidden) hint.remove();
    });
    listen(column, "click", (event) => {
      if (blockClick || event.target.closest("[data-appointment]")) return;
      if (!isCurrent()) return;
      const slot = fromPointer(column, event);
      open(column, slot, { x: event.clientX, y: event.clientY });
    });
    listen(column, "keydown", (event) => {
      if (event.target !== column || !isCurrent()) return;
      let slot = remembered.get(column) || initialKeyboardSlot(column);
      const r = resource(column);
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        const rect = column.getBoundingClientRect();
        open(column, slot, {
          x: rect.left + (rect.width * (slot.bed + 0.5)) / r.capacity,
          y: rect.top + (slot.start - START) * SCALE,
        });
      } else if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          ...(r.capacity > 1 ? ["ArrowLeft", "ArrowRight"] : []),
        ].includes(event.key)
      ) {
        event.preventDefault();
        const delta =
          { ArrowUp: -5, ArrowDown: 5, PageUp: -30, PageDown: 30 }[event.key] ||
          0;
        const start =
          event.key === "Home"
            ? START
            : event.key === "End"
              ? END - 5
              : clamp(slot.start + delta, START, END - 5);
        slot = {
          start,
          bandStart: Math.floor(start / 30) * 30,
          bed:
            event.key === "ArrowLeft"
              ? 0
              : event.key === "ArrowRight"
                ? r.capacity - 1
                : slot.bed,
        };
        showHint(column, slot);
        const bandTop =
          column.getBoundingClientRect().top + (start - START) * SCALE;
        const frame = root.getBoundingClientRect();
        const previousScroll = root.scrollTop;
        if (bandTop < frame.top + 82)
          root.scrollTop -= frame.top + 82 - bandTop;
        else if (bandTop > frame.bottom - 28)
          root.scrollTop += bandTop - frame.bottom + 28;
        if (previousScroll !== root.scrollTop)
          keyboardScroll = { column, top: root.scrollTop };
      } else if (event.key === "Escape") {
        dismiss();
      }
    });
  }
  listen(doc, "pointerup", (event) => {
    if (gesture?.id === event.pointerId) {
      blockClick = gesture.moved;
      gesture = null;
    }
  });
  listen(doc, "pointercancel", () => {
    blockClick = true;
    gesture = null;
    hint.remove();
  });
  listen(
    doc,
    "pointerdown",
    (event) => {
      if (!menu.hidden && !menu.contains(event.target)) dismiss();
    },
    { capture: true },
  );
  listen(doc, "focusin", (event) => {
    if (
      !menu.hidden &&
      !menu.contains(event.target) &&
      event.target !== menuColumn
    )
      dismiss();
  });
  listen(doc, "keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      dismiss({ restoreFocus: true });
    }
  });
  listen(
    doc,
    "scroll",
    (event) => {
      if (menu.contains(event.target)) return;
      const movedByKeyboard = keyboardScroll;
      keyboardScroll = null;
      if (
        event.target === root &&
        movedByKeyboard?.top === root.scrollTop &&
        menu.hidden
      ) {
        showHint(
          movedByKeyboard.column,
          remembered.get(movedByKeyboard.column),
        );
        return;
      }
      dismiss();
    },
    { capture: true, passive: true },
  );
  listen(win, "resize", () => dismiss());
  if (win.visualViewport) {
    listen(win.visualViewport, "resize", () => dismiss());
    listen(win.visualViewport, "scroll", () => dismiss());
  }
  listen(menu.querySelector("#calendar-slot-close"), "click", () =>
    dismiss({ restoreFocus: true }),
  );
  listen(add, "click", () => {
    if (!selected || !isCurrent()) {
      dismiss();
      return;
    }
    const defaults = selected;
    dismiss();
    onAdd(defaults);
  });
  return {
    dismiss,
    dispose() {
      dismiss();
      controller.abort();
      menu.remove();
    },
  };
}
