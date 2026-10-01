import test from "node:test";
import assert from "node:assert/strict";
import {
  SCALE,
  setCalendarScale,
  calendarTop,
  calendarHeight,
  calendarStartAtY,
  calendarSlotAtPoint,
} from "../public/calendar-geometry.js";

const rect = { top: 83, left: 44, width: 204 };

test("both calendar densities preserve every 15-minute slot and independent room beds", () => {
  try {
    for (const scale of [1, 2]) {
      setCalendarScale(scale);
      assert.equal(SCALE, scale);
      assert.equal(calendarHeight(1440), 1440 * scale);
      for (let minute = 0; minute < 1440; minute += 15) {
        for (const offset of [0, 7, 14.99]) {
          for (const bed of [0, 1]) {
            assert.deepEqual(
              calendarSlotAtPoint(
                rect,
                {
                  x: rect.left + 51 + bed * 102,
                  y: rect.top + (minute + offset) * scale,
                },
                2,
              ),
              { start: minute, bandStart: minute, bed },
            );
          }
        }
      }
    }
  } finally {
    setCalendarScale(2);
  }
});

test("dense and desktop movement snap to five minutes without changing duration or grab offset", () => {
  try {
    for (const scale of [1, 2]) {
      setCalendarScale(scale);
      for (let minute = 0; minute <= 1350; minute += 5) {
        const grabOffset = 27;
        assert.equal(
          calendarStartAtY(
            rect,
            rect.top + (minute + grabOffset) * scale,
            90,
            grabOffset,
          ),
          minute,
        );
      }
      assert.equal(calendarStartAtY(rect, rect.top + 602 * scale, 90), 600);
      assert.equal(calendarStartAtY(rect, rect.top + 603 * scale, 90), 605);
      assert.equal(calendarStartAtY(rect, rect.top - 100, 90), 0);
      assert.equal(calendarStartAtY(rect, rect.top + 1500 * scale, 90), 1350);
      assert.equal(calendarTop(1435), 1435 * scale);
      assert.equal(calendarHeight(90, 2), 90 * scale - 2);
      assert.equal(
        calendarSlotAtPoint(rect, { x: rect.left, y: rect.top + 1440 * scale })
          .start,
        1425,
      );
    }
  } finally {
    setCalendarScale(2);
  }
});

test("invalid calendar density cannot corrupt shared geometry", () => {
  try {
    setCalendarScale(1);
    for (const value of [0, -1, 0.5, 3, NaN, Infinity, "1", undefined, null]) {
      assert.throws(() => setCalendarScale(value), RangeError);
      assert.equal(SCALE, 1);
    }
  } finally {
    setCalendarScale(2);
  }
});
