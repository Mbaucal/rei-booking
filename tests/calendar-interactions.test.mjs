import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarSlotAtPoint,
  calendarMenuPosition,
  calendarSelectionDefaults,
} from "../public/calendar-interactions.js";

test("hover selects the containing quarter-hour start, including a vertically scrolled column", () => {
  const rect = { top: -1360, left: 60, width: 180 };
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 100, y: 350 }), {
    start: 855,
    bandStart: 855,
  });
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 100, y: 364 }), {
    start: 855,
    bandStart: 855,
  });
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 100, y: 380 }), {
    start: 870,
    bandStart: 870,
  });
});

test("every horizontal point in a scrolled room selects the same time without choosing a physical table", () => {
  const rect = { top: 100, left: -75, width: 280 };
  for (const x of [-100, -75, 64, 65, 205, 1000]) {
    const slot = calendarSlotAtPoint(rect, { x, y: 300 });
    assert.deepEqual(slot, { start: 90, bandStart: 90 });
    assert.deepEqual(
      calendarSelectionDefaults("2026-10-02", slot, {
        id: "r1",
        kind: "room",
        capacity: 2,
      }),
      { date: "2026-10-02", start: 90, roomId: "r1" },
    );
  }
});

test("calendar boundaries never produce an off-grid start, and therapist defaults remain independent of rooms", () => {
  const rect = { top: 100, left: 80, width: 280 };
  assert.deepEqual(calendarSlotAtPoint(rect, { x: -100, y: -100 }, 2), {
    start: 0,
    bandStart: 0,
  });
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 1000, y: 4000 }, 2), {
    start: 1425,
    bandStart: 1425,
  });
  assert.deepEqual(
    calendarSelectionDefaults(
      "2026-10-02",
      { start: 0 },
      {
        id: "t1",
        kind: "therapist",
        capacity: 1,
      },
    ),
    { date: "2026-10-02", start: 0, therapistId: "t1" },
  );
});

test("quick actions prefer the pointer's lower-right side and flip beside screen edges", () => {
  const viewport = { width: 1440, height: 900 },
    size = { width: 264, height: 150 };
  assert.deepEqual(calendarMenuPosition({ x: 400, y: 400 }, size, viewport), {
    left: 412,
    top: 412,
  });
  assert.deepEqual(calendarMenuPosition({ x: 1400, y: 860 }, size, viewport), {
    left: 1124,
    top: 698,
  });
});

test("popup stays inside desktop, phone, tablet and offset visual viewports at all four edges", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { left: 20, top: 80, width: 320, height: 300 },
  ]) {
    const size = { width: 264, height: 150 };
    for (const x of [0, viewport.width])
      for (const y of [0, viewport.height]) {
        const position = calendarMenuPosition(
          { x: x + (viewport.left || 0), y: y + (viewport.top || 0) },
          size,
          viewport,
        );
        assert.ok(position.left >= (viewport.left || 0) + 8);
        assert.ok(position.top >= (viewport.top || 0) + 8);
        assert.ok(
          position.left + size.width <=
            (viewport.left || 0) + viewport.width - 8,
        );
        assert.ok(
          position.top + size.height <=
            (viewport.top || 0) + viewport.height - 8,
        );
      }
  }
});

test("hover keeps the final pixels of each quarter in that quarter", () => {
  const rect = { top: -1100, left: 0, width: 180 };
  for (const [y, start, bandStart] of [
    [129.9, 600, 600],
    [130, 615, 615],
    [159.9, 615, 615],
    [160, 630, 630],
    [180, 630, 630], // 10:40 selects 10:30, never 10:40.
    [189.9, 630, 630],
    [190, 645, 645],
    [219.9, 645, 645],
    [220, 660, 660],
  ]) {
    assert.deepEqual(calendarSlotAtPoint(rect, { x: 50, y }), {
      start,
      bandStart,
    });
  }
});
