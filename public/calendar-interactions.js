import {
  START,
  END,
  SCALE,
  BAND,
  clamp,
  calendarBandStart,
  calendarTime as time,
  calendarSlotAtPoint as geometrySlotAtPoint,
} from "./calendar-geometry.js";

// Room columns are visual resources, not physical table selectors. A booking
// fixes the room while the form chooses a table for the complete treatment.
export function calendarSlotAtPoint(rect, point) {
  const { start, bandStart } = geometrySlotAtPoint(rect, point);
  return { start, bandStart };
}

export function calendarSelectionDefaults(date, slot, resource) {
  return {
    date,
    start: slot.start,
    ...(resource.kind === "therapist"
      ? { therapistId: resource.id }
      : { roomId: resource.id }),
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
  onAddBlock,
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
    '<div class="slot-menu-heading"><div><strong id="calendar-slot-menu-time"></strong><span id="calendar-slot-menu-resource"></span></div><button type="button" id="calendar-slot-close" aria-label="Close quick actions">×</button></div><button type="button" id="calendar-slot-add"><span aria-hidden="true">＋</span>Add appointment</button>' +
    (onAddBlock
      ? '<button type="button" id="calendar-slot-add-block"><span aria-hidden="true">▧</span>Add blocked time</button>'
      : "");
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
  const scrollPositionsAtAnchor = new Map();
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
    keyboardScroll = null;
    scrollPositionsAtAnchor.clear();
    hint.remove();
    if (suppress) blockClick = true;
    if (restoreFocus && previous?.isConnected)
      previous.focus({ preventScroll: true });
  }
  function rememberScrollPositions() {
    scrollPositionsAtAnchor.clear();
    for (let node = root; node; node = node.parentElement)
      scrollPositionsAtAnchor.set(node, {
        top: node.scrollTop,
        left: node.scrollLeft,
      });
  }
  function showHint(column, slot) {
    remembered.set(column, slot);
    hint.dataset.start = String(slot.start);
    hint.dataset.bandStart = String(slot.bandStart);
    hint.style.top = `${(slot.bandStart - START) * SCALE}px`;
    hint.style.left = "0%";
    hint.style.width = "100%";
    hint.style.height = `${BAND * SCALE}px`;
    marker.style.top = `${(slot.start - slot.bandStart) * SCALE}px`;
    marker.textContent = time(slot.start);
    column.append(hint);
    // A mode switch can queue a scroll event before this hint is displayed.
    // Its geometry already uses the current offsets, so that old notification
    // must not dismiss the new selection when no later movement has occurred.
    rememberScrollPositions();
  }
  function open(column, slot, anchor) {
    if (!isCurrent()) return;
    dismiss();
    const r = resource(column);
    selected = calendarSelectionDefaults(date, slot, r);
    menuColumn = column;
    showHint(column, slot);
    menu.querySelector("#calendar-slot-menu-time").textContent = time(
      slot.start,
    );
    menu.querySelector("#calendar-slot-menu-resource").textContent = r.name;
    const visible = viewport();
    menu.style.maxWidth = `${Math.max(1, visible.width - 16)}px`;
    menu.style.maxHeight = `${Math.max(1, visible.height - 16)}px`;
    menu.hidden = false;
    const box = menu.getBoundingClientRect(),
      position = calendarMenuPosition(anchor, box, visible);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    // Focus and keyboard navigation can queue scroll events. Layout already
    // reflects those offsets when the menu is anchored; only a later movement
    // should dismiss it, not notification of an earlier scroll.
    rememberScrollPositions();
    add.focus({ preventScroll: true });
  }
  function fromPointer(column, event) {
    return calendarSlotAtPoint(column.getBoundingClientRect(), {
      x: event.clientX,
      y: event.clientY,
    });
  }
  function initialKeyboardSlot(column) {
    const box = column.getBoundingClientRect();
    const top = Math.max(box.top, visibleGridBounds().top);
    return calendarSlotAtPoint(box, { x: box.left + 8, y: top + 10 });
  }
  function visibleGridBounds() {
    const frame = root.getBoundingClientRect(),
      header = root.querySelector(".calendar-headers")?.getBoundingClientRect(),
      visible = viewport();
    return {
      top: Math.max(frame.top, header?.bottom ?? frame.top, visible.top),
      bottom: Math.min(frame.bottom, visible.top + visible.height),
    };
  }
  for (const column of columns) {
    column.tabIndex = 0;
    column.setAttribute(
      "aria-label",
      `${resource(column).name}. Use up and down arrows to choose a time in 15-minute steps, then Enter for booking options.`,
    );
    listen(column, "pointerdown", (event) => {
      if (
        event.target.closest("[data-appointment], [data-calendar-block]") ||
        event.button !== 0
      )
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
      if (event.target.closest("[data-appointment], [data-calendar-block]")) {
        hint.remove();
        return;
      }
      showHint(column, fromPointer(column, event));
    });
    listen(column, "pointerleave", () => {
      if (menu.hidden) hint.remove();
    });
    listen(column, "click", (event) => {
      if (
        blockClick ||
        event.target.closest("[data-appointment], [data-calendar-block]")
      )
        return;
      if (!isCurrent()) return;
      const slot = fromPointer(column, event);
      open(column, slot, { x: event.clientX, y: event.clientY });
    });
    listen(column, "keydown", (event) => {
      if (event.target !== column || !isCurrent()) return;
      let slot = remembered.get(column) || initialKeyboardSlot(column);
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        const rect = column.getBoundingClientRect();
        open(column, slot, {
          x: rect.left + rect.width / 2,
          y: rect.top + (slot.start - START) * SCALE,
        });
      } else if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(
          event.key,
        )
      ) {
        event.preventDefault();
        const delta =
          {
            ArrowUp: -BAND,
            ArrowDown: BAND,
            PageUp: -2 * BAND,
            PageDown: 2 * BAND,
          }[event.key] || 0;
        const start =
          event.key === "Home"
            ? START
            : event.key === "End"
              ? END - BAND
              : clamp(slot.start + delta, START, END - BAND);
        slot = {
          start,
          bandStart: calendarBandStart(start),
        };
        showHint(column, slot);
        const bandTop =
          column.getBoundingClientRect().top + (start - START) * SCALE;
        const frame = visibleGridBounds();
        const previousScroll = root.scrollTop;
        if (bandTop < frame.top + 6) root.scrollTop -= frame.top + 6 - bandTop;
        else if (bandTop + BAND * SCALE > frame.bottom)
          root.scrollTop += bandTop + BAND * SCALE - frame.bottom;
        if (previousScroll !== root.scrollTop)
          keyboardScroll = {
            column,
            top: root.scrollTop,
            left: root.scrollLeft,
          };
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
      const scroller =
        event.target === doc ? doc.scrollingElement : event.target;
      const atAnchor = scrollPositionsAtAnchor.get(scroller);
      if (
        (!menu.hidden || hint.isConnected) &&
        atAnchor &&
        atAnchor.top === scroller.scrollTop &&
        atAnchor.left === scroller.scrollLeft
      ) {
        if (scroller === root) keyboardScroll = null;
        return;
      }
      const movedByKeyboard = keyboardScroll;
      keyboardScroll = null;
      if (
        event.target === root &&
        movedByKeyboard?.top === root.scrollTop &&
        movedByKeyboard.left === root.scrollLeft
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
  if (onAddBlock)
    listen(menu.querySelector("#calendar-slot-add-block"), "click", () => {
      if (!selected || !isCurrent()) {
        dismiss();
        return;
      }
      const defaults = selected;
      dismiss();
      onAddBlock(defaults);
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
