import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarSlotAtPoint,
  calendarMenuPosition,
} from "../public/calendar-interactions.js";

test("hover uses exact five-minute start within a fixed quarter-hour band, including a vertically scrolled column", () => {
  const rect = { top: -160, left: 60, width: 180 };
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 100, y: 350 }), {
    start: 855,
    bandStart: 855,
    bed: 0,
  });
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 100, y: 364 }), {
    start: 860,
    bandStart: 855,
    bed: 0,
  });
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 100, y: 380 }), {
    start: 870,
    bandStart: 870,
    bed: 0,
  });
});

test("table halves remain relative to room coordinates during horizontal scrolling", () => {
  const rect = { top: 100, left: -75, width: 280 };
  assert.equal(calendarSlotAtPoint(rect, { x: 64, y: 300 }, 2).bed, 0);
  assert.equal(calendarSlotAtPoint(rect, { x: 65, y: 300 }, 2).bed, 1);
  assert.equal(calendarSlotAtPoint(rect, { x: 205, y: 300 }, 2).bed, 1);
  assert.equal(calendarSlotAtPoint(rect, { x: 205, y: 300 }, 1).bed, 0);
});

test("calendar boundaries never produce an off-grid start or a non-existent table", () => {
  const rect = { top: 100, left: 80, width: 280 };
  assert.deepEqual(calendarSlotAtPoint(rect, { x: -100, y: -100 }, 2), {
    start: 600,
    bandStart: 600,
    bed: 0,
  });
  assert.deepEqual(calendarSlotAtPoint(rect, { x: 1000, y: 2000 }, 2), {
    start: 1315,
    bandStart: 1305,
    bed: 1,
  });
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
  const rect = { top: 100, left: 0, width: 180 };
  for (const [y, start, bandStart] of [
    [129.9, 610, 600],
    [130, 615, 615],
    [159.9, 625, 615],
    [160, 630, 630],
    [219.9, 655, 645],
    [220, 660, 660],
  ]) {
    assert.deepEqual(calendarSlotAtPoint(rect, { x: 50, y }), {
      start,
      bandStart,
      bed: 0,
    });
  }
});
