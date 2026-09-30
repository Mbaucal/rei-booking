export const START = 600;
export const END = 1320;
export const SCALE = 2;
export const STEP = 5;
export const BAND = 15;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const calendarTop = (minute) => (minute - START) * SCALE;
export const calendarHeight = (duration, gap = 0) => duration * SCALE - gap;
export const calendarBandStart = (minute) =>
  START + Math.floor((minute - START) / BAND) * BAND;
export const calendarTime = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function calendarStartAtY(rect, y, duration = STEP, offset = 0) {
  return clamp(
    Math.round(((y - rect.top) / SCALE + START - offset) / STEP) * STEP,
    START,
    END - duration,
  );
}

export function calendarBedAtX(rect, x, capacity = 1) {
  return clamp(
    Math.floor(((x - rect.left) / rect.width) * capacity),
    0,
    capacity - 1,
  );
}

export function calendarSlotAtPoint(rect, point, capacity = 1) {
  // Empty-slot hover stays inside the physical quarter under the pointer.
  // Dragging uses nearest-five-minute snapping separately.
  const start = clamp(
    calendarBandStart((point.y - rect.top) / SCALE + START),
    START,
    END - BAND,
  );
  return {
    start,
    bandStart: calendarBandStart(start),
    bed: calendarBedAtX(rect, point.x, capacity),
  };
}
