import test from "node:test";
import assert from "node:assert/strict";
import {
  START,
  END,
  SCALE,
  STEP,
  BAND,
  calendarBandStart,
  calendarTop,
  calendarHeight,
  calendarSlotAtPoint,
  calendarStartAtY,
} from "../public/calendar-geometry.js";
import {
  calendarMovedAppointment,
  createCalendarMoveSaver,
  sameCalendarPosition,
} from "../public/calendar-reschedule.js";

const appointment = () => ({
  id: "a1",
  date: "2026-10-01",
  start: 1140,
  duration: 90,
  therapistId: "t1",
  roomId: "r1",
  bed: 1,
  serviceId: "s90",
  requestedTherapistId: "t1",
  clientId: "c1",
  note: "Keep this note",
  grossCents: 590000,
  netCents: 500000,
  createdAt: "2026-09-01T12:00:00Z",
  version: 4,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("shared geometry selects quarter-hour booking starts while dragging still resolves every five minutes", () => {
  assert.deepEqual([START, END, SCALE, STEP, BAND], [0, 1440, 2, 5, 15]);
  assert.deepEqual([0, 15, 30, 45].map(calendarTop), [0, 30, 60, 90]);
  assert.deepEqual(
    [600, 615, 630, 645].map(calendarTop),
    [1200, 1230, 1260, 1290],
  );
  assert.equal(calendarHeight(60), 120);
  assert.equal(calendarHeight(90, 3), 177);
  const rect = { top: -400, left: 80, width: 240 };
  for (let minute = START; minute < END; minute += STEP) {
    const slot = calendarSlotAtPoint(
      rect,
      { x: 81, y: rect.top + calendarTop(minute) },
      2,
    );
    assert.equal(slot.start, calendarBandStart(minute));
    assert.equal(slot.bandStart, calendarBandStart(minute));
    assert.equal(
      calendarStartAtY(rect, rect.top + calendarTop(minute)),
      minute,
    );
  }
});

test("dragging 19:00 to 18:55 keeps all ninety minutes and immutable appointment fields", () => {
  const original = appointment();
  const moved = calendarMovedAppointment(
    original,
    original,
    { id: "t1", kind: "therapist", capacity: 1 },
    { top: -800, left: 40, width: 200 },
    { x: 100, y: -800 + calendarTop(1135) + 30 },
    15,
  );
  assert.deepEqual(moved, { ...original, start: 1135 });
  assert.deepEqual(original, appointment());
  assert.equal(moved.start + moved.duration, 1225);
});

test("whole treatment clamps to calendar boundaries and cross-resource movement preserves the other resource", () => {
  const original = appointment(),
    rect = { top: 100, left: -80, width: 240 };
  const therapist = { id: "t2", kind: "therapist", capacity: 1 };
  const early = calendarMovedAppointment(
    original,
    original,
    therapist,
    rect,
    { x: 30, y: -500 },
    5,
  );
  assert.equal(early.start, START);
  assert.equal(early.therapistId, "t2");
  assert.equal(early.roomId, "r1");
  assert.equal(early.bed, 1);
  const room = { id: "r2", kind: "room", capacity: 2 };
  const late = calendarMovedAppointment(
    original,
    early,
    room,
    rect,
    { x: 40, y: 3000 },
    5,
  );
  assert.equal(late.start, END - 90);
  assert.equal(late.therapistId, "t2");
  assert.equal(late.roomId, "r2");
  assert.equal(late.bed, 1);
  assert.equal(late.requestedTherapistId, "t1");
  const left = calendarMovedAppointment(original, late, room, rect, {
    x: 39,
    y: 200,
  });
  assert.equal(left.bed, 0);
  const single = calendarMovedAppointment(
    original,
    late,
    { ...room, capacity: 1 },
    rect,
    { x: 1000, y: 200 },
  );
  assert.equal(single.bed, 0);
});

test("unchanged position never saves or asks for confirmation", async () => {
  const saver = createCalendarMoveSaver({
    isCurrent: () => true,
    onSave: () => assert.fail("No PUT"),
    confirmTherapistChange: () => assert.fail("No confirmation"),
  });
  assert.equal(sameCalendarPosition(appointment(), appointment()), true);
  assert.equal(await saver.save(appointment(), appointment()), "unchanged");
});

test("concurrent Save while requested-therapist confirmation is pending performs one confirmation and one write", async () => {
  const pending = deferred(),
    writes = [],
    original = appointment(),
    candidate = { ...original, therapistId: "t2", start: 1135 };
  let confirmations = 0;
  const saver = createCalendarMoveSaver({
    isCurrent: () => true,
    onSave: async (value) => writes.push(value),
    confirmTherapistChange: () => {
      confirmations++;
      return pending.promise;
    },
  });
  const first = saver.save(original, candidate);
  assert.equal(saver.busy, true);
  assert.equal(await saver.save(original, candidate), "busy");
  assert.equal(writes.length, 0);
  pending.resolve(true);
  assert.equal(await first, "saved");
  assert.equal(confirmations, 1);
  assert.deepEqual(writes, [candidate]);
  assert.equal(saver.busy, false);
});

test("declined request confirmation does not write and navigation during confirmation cancels the write", async () => {
  const original = appointment(),
    candidate = { ...original, therapistId: "t2" };
  const denied = createCalendarMoveSaver({
    isCurrent: () => true,
    onSave: () => assert.fail("No PUT"),
    confirmTherapistChange: async () => false,
  });
  assert.equal(await denied.save(original, candidate), "cancelled");
  let current = true;
  const pending = deferred();
  const stale = createCalendarMoveSaver({
    isCurrent: () => current,
    onSave: () => assert.fail("No stale PUT"),
    confirmTherapistChange: () => pending.promise,
  });
  const result = stale.save(original, candidate);
  current = false;
  pending.resolve(true);
  assert.equal(await result, "stale");
});

test("failed writes release the save lock for an explicit retry and preserve the original request identity", async () => {
  const original = appointment(),
    candidate = { ...original, start: 1135, requestedTherapistId: null },
    writes = [];
  const saver = createCalendarMoveSaver({
    isCurrent: () => true,
    confirmTherapistChange: () => assert.fail("Same therapist"),
    onSave: async (value) => {
      writes.push(value);
      if (writes.length === 1) throw new Error("Already booked");
    },
  });
  await assert.rejects(saver.save(original, candidate), /Already booked/);
  assert.equal(saver.busy, false);
  assert.equal(await saver.save(original, candidate), "saved");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].requestedTherapistId, original.requestedTherapistId);
  assert.equal(writes[1].version, 4);
});

test("late save success or failure after navigation produces only a stale result", async () => {
  for (const fail of [false, true]) {
    let current = true;
    const pending = deferred();
    const saver = createCalendarMoveSaver({
      isCurrent: () => current,
      confirmTherapistChange: () => assert.fail("Same therapist"),
      onSave: () => pending.promise,
    });
    const result = saver.save(appointment(), { ...appointment(), start: 1135 });
    current = false;
    if (fail) pending.reject(new Error("Late error"));
    else pending.resolve();
    assert.equal(await result, "stale");
    assert.equal(saver.busy, false);
  }
});
