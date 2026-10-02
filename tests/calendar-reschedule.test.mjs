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
  setCalendarScale,
} from "../public/calendar-geometry.js";
import {
  calendarMovedAppointment,
  calendarAvailableTable,
  calendarMoveLayout,
  createCalendarMoveSaver,
  sameCalendarPosition,
  calendarMovedBlock,
  calendarBlockScopeChanged,
  calendarBlockMoveRequiresSave,
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
const calendarBlock = () => ({
  id: "b1",
  date: "2026-10-01",
  start: 1140,
  duration: 90,
  resourceType: "room",
  resourceId: "r1",
  bed: 1,
  title: "Room preparation",
  note: "Keep the original note",
  blocksAvailability: true,
  createdAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:00:00Z",
  version: 4,
});

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
  assert.equal(late.bed, 0);
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

test("room moves preserve the original table across pointer positions and transient occupied times", () => {
  const original = appointment(),
    room = { id: "r1", kind: "room", capacity: 2 },
    rect = { top: -800, left: -80, width: 240 },
    context = {
      resources: [room],
      blockingAppointments: [
        original,
        {
          ...original,
          id: "other",
          start: 1020,
          duration: 60,
          therapistId: "t2",
        },
      ],
    };
  const obstructed = calendarMovedAppointment(
    original,
    original,
    room,
    rect,
    { x: rect.left + 239, y: rect.top + calendarTop(1020) },
    0,
    context,
  );
  assert.equal(obstructed.bed, 0);
  for (const x of [rect.left, rect.left + 120, rect.left + 239]) {
    const moved = calendarMovedAppointment(
      original,
      obstructed,
      room,
      rect,
      { x, y: rect.top + calendarTop(1135) },
      0,
      context,
    );
    assert.equal(moved.start, 1135);
    assert.equal(
      moved.bed,
      1,
      "Original table survives the provisional detour",
    );
    assert.equal(moved.note, original.note);
    assert.equal(moved.requestedTherapistId, original.requestedTherapistId);
  }
});

test("table allocation covers the whole duration, ignores self and released records, and treats interval boundaries as free", () => {
  const candidate = { ...appointment(), start: 600, duration: 90 },
    room = { id: "r1", capacity: 2 },
    record = (id, start, duration, bed, extra = {}) => ({
      ...candidate,
      id,
      start,
      duration,
      bed,
      ...extra,
    });
  const base = [
    candidate,
    record("ends-at-start", 570, 30, 1),
    record("starts-at-end", 690, 60, 1),
    record("cancelled", 600, 90, 1, { status: "cancelled" }),
    record("no-show", 600, 90, 1, { status: "no_show" }),
    record("different-day", 600, 90, 1, { date: "2026-10-02" }),
    record("different-room", 600, 90, 1, { roomId: "r2" }),
  ];
  assert.equal(calendarAvailableTable(candidate, room, base), 1);
  const lateConflict = record("last-five-minutes", 685, 30, 1, {
    status: "completed",
  });
  assert.equal(
    calendarAvailableTable(candidate, room, [...base, lateConflict]),
    0,
  );
  assert.equal(
    calendarAvailableTable(candidate, room, [
      ...base,
      lateConflict,
      record("other-table", 660, 60, 0),
    ]),
    null,
  );
});

test("blocking room entries prevent allocation while notes, therapist blocks and unrelated dates do not consume a table", () => {
  const candidate = { ...appointment(), start: 600 },
    room = { id: "r1", capacity: 2 },
    block = {
      id: "b1",
      date: candidate.date,
      start: 685,
      duration: 30,
      resourceType: "room",
      resourceId: "r1",
      bed: 1,
      blocksAvailability: true,
    };
  assert.equal(calendarAvailableTable(candidate, room, [], [block]), 0);
  assert.equal(
    calendarAvailableTable(candidate, room, [], [{ ...block, bed: null }]),
    null,
  );
  for (const extra of [
    { blocksAvailability: false },
    { resourceType: "therapist", resourceId: "t1" },
    { resourceId: "r2" },
    { date: "2026-10-02" },
    { start: 690 },
  ])
    assert.equal(
      calendarAvailableTable(candidate, room, [], [{ ...block, ...extra }]),
      1,
    );
});

test("new-room drag chooses its free table without x selection and retains a valid server-checkable candidate when full", () => {
  const original = appointment(),
    room = { id: "r2", kind: "room", capacity: 2 },
    rect = { top: 0, left: 0, width: 180 },
    busy = { ...original, id: "other", roomId: "r2", bed: 0 },
    context = { resources: [room], blockingAppointments: [original, busy] };
  for (const x of [0, 90, 179]) {
    const moved = calendarMovedAppointment(
      original,
      original,
      room,
      rect,
      { x, y: calendarTop(original.start) },
      0,
      context,
    );
    assert.equal(moved.roomId, "r2");
    assert.equal(moved.bed, 1);
  }
  const full = {
    ...context,
    blocks: [
      {
        date: original.date,
        start: original.start,
        duration: original.duration,
        resourceType: "room",
        resourceId: "r2",
        bed: null,
        blocksAvailability: true,
      },
    ],
  };
  const moved = calendarMovedAppointment(
    original,
    original,
    room,
    rect,
    { x: 179, y: calendarTop(original.start) },
    0,
    full,
  );
  assert.equal(
    calendarAvailableTable(moved, room, full.blockingAppointments, full.blocks),
    null,
  );
  assert.equal(moved.bed, 0);
  assert.equal(moved.version, original.version);
});

test("move previews share unified room collision lanes, include calendar notes, and remove the original position", () => {
  const original = { ...appointment(), start: 600, duration: 60 },
    candidate = { ...original, start: 720 },
    other = { ...original, id: "other", start: 720, bed: 0 },
    room = { id: "r1", kind: "room", capacity: 2 },
    context = { blockingAppointments: [original, other], blocks: [] };
  const moved = calendarMoveLayout(room, candidate, context);
  assert.equal(moved.length, 2);
  assert.deepEqual(
    moved.map((item) => item.width),
    [50, 50],
  );
  assert.deepEqual(new Set(moved.map((item) => item.left)), new Set([0, 50]));
  assert.equal(
    moved.find((item) => item.record.id === original.id).record.start,
    720,
  );
  const separate = calendarMoveLayout(
    room,
    { ...candidate, start: 780 },
    context,
  );
  assert.deepEqual(
    separate.map((item) => item.width),
    [100, 100],
  );
  const withNote = calendarMoveLayout(room, candidate, {
    ...context,
    blocks: [
      {
        id: "note",
        date: candidate.date,
        start: 720,
        duration: 60,
        resourceType: "room",
        resourceId: "r1",
        bed: null,
        blocksAvailability: false,
      },
    ],
  });
  assert.equal(withNote.length, 3);
  assert.ok(withNote.every((item) => item.width === 100 / 3));
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

test("moving notes and blocks snaps to five minutes at either density and preserves every non-position field", () => {
  const room = { id: "r1", kind: "room", capacity: 2 },
    rect = { top: -800, left: 40, width: 120 };
  try {
    for (const scale of [1, 2]) {
      setCalendarScale(scale);
      for (const blocksAvailability of [true, false]) {
        const original = { ...calendarBlock(), blocksAvailability };
        const moved = calendarMovedBlock(
          original,
          room,
          rect,
          { x: 80, y: rect.top + calendarTop(1135) + 15 * scale },
          15,
        );
        assert.deepEqual(moved, { ...original, start: 1135 });
        assert.deepEqual(original, { ...calendarBlock(), blocksAvailability });
        assert.equal(moved.start + moved.duration, 1225);
      }
    }
  } finally {
    setCalendarScale(2);
  }
});

test("whole blocks clamp to midnight boundaries, including a full-day block", () => {
  const resource = { id: "r1", kind: "room", capacity: 2 },
    rect = { top: 50, left: 0, width: 120 },
    original = calendarBlock();
  assert.equal(
    calendarMovedBlock(original, resource, rect, { x: 10, y: -900 }).start,
    0,
  );
  const late = calendarMovedBlock(original, resource, rect, { x: 10, y: 9999 });
  assert.equal(late.start, 1350);
  assert.equal(late.start + late.duration, 1440);
  const fullDay = { ...original, start: 0, duration: 1440, bed: null };
  assert.deepEqual(
    calendarMovedBlock(fullDay, resource, rect, { x: 10, y: 1500 }),
    fullDay,
  );
});

test("room block moves preserve explicit table or all-table scope across the full column", () => {
  const resource = { id: "r2", kind: "room", capacity: 2 },
    rect = { top: 0, left: 0, width: 120 };
  for (const bed of [null, 0, 1]) {
    const original = { ...calendarBlock(), bed };
    for (const x of [1, 60, 119]) {
      const moved = calendarMovedBlock(original, resource, rect, {
        x,
        y: calendarTop(original.start),
      });
      assert.deepEqual(moved, { ...original, resourceId: "r2" });
      assert.equal(calendarBlockScopeChanged(original, moved), false);
      assert.equal(sameCalendarPosition(original, moved, "block"), false);
    }
  }
});

test("cross-kind and smaller-room changes are marked for explicit review and returning restores original scope", () => {
  const original = calendarBlock(),
    rect = { top: 0, left: 0, width: 120 },
    point = { x: 20, y: calendarTop(original.start) },
    therapist = { id: "t2", kind: "therapist", capacity: 1 },
    smallRoom = { id: "r3", kind: "room", capacity: 1 },
    originalRoom = { id: "r1", kind: "room", capacity: 2 };
  const toTherapist = calendarMovedBlock(original, therapist, rect, point);
  assert.equal(toTherapist.resourceType, "therapist");
  assert.equal(toTherapist.resourceId, "t2");
  assert.equal(toTherapist.bed, null);
  assert.equal(calendarBlockScopeChanged(original, toTherapist), true);
  const toSmallRoom = calendarMovedBlock(original, smallRoom, rect, point);
  assert.equal(toSmallRoom.bed, 0);
  assert.equal(calendarBlockScopeChanged(original, toSmallRoom), true);
  const back = calendarMovedBlock(original, originalRoom, rect, point);
  assert.deepEqual(
    back,
    original,
    "provisional detours do not replace the original scope",
  );
  assert.equal(calendarBlockScopeChanged(original, back), false);
  const all = { ...original, bed: null };
  const allToSmallRoom = calendarMovedBlock(all, smallRoom, rect, point);
  assert.equal(allToSmallRoom.bed, null);
  assert.equal(calendarBlockScopeChanged(all, allToSmallRoom), false);
  const therapistOriginal = {
    ...original,
    resourceType: "therapist",
    resourceId: "t1",
    bed: null,
  };
  const toRoom = calendarMovedBlock(
    therapistOriginal,
    originalRoom,
    rect,
    point,
  );
  assert.equal(toRoom.bed, null);
  assert.equal(calendarBlockScopeChanged(therapistOriginal, toRoom), true);
  const toOtherTherapist = calendarMovedBlock(
    therapistOriginal,
    therapist,
    rect,
    point,
  );
  assert.equal(
    calendarBlockScopeChanged(therapistOriginal, toOtherTherapist),
    false,
  );
});

test("block preview layout replaces only its typed identity and reflows both old and new resources", () => {
  const original = {
      ...calendarBlock(),
      id: "shared-id",
      start: 600,
      duration: 60,
      bed: null,
    },
    appointmentWithSameId = {
      ...appointment(),
      id: original.id,
      start: 720,
      duration: 60,
    },
    room = { id: "r1", kind: "room", capacity: 2 },
    target = { id: "r2", kind: "room", capacity: 2 },
    other = {
      ...original,
      id: "other-note",
      start: 720,
      resourceId: target.id,
    },
    context = {
      blockingAppointments: [appointmentWithSameId],
      blocks: [original, other],
    },
    candidate = { ...original, start: 720, resourceId: target.id };
  const oldItems = calendarMoveLayout(room, candidate, context, "block");
  assert.equal(oldItems.length, 1);
  assert.equal(oldItems[0].kind, "appointment");
  assert.equal(oldItems[0].record, appointmentWithSameId);
  assert.equal(oldItems[0].width, 100);
  const targetItems = calendarMoveLayout(target, candidate, context, "block");
  assert.equal(targetItems.length, 2);
  assert.ok(targetItems.every((item) => item.width === 50));
  assert.equal(
    targetItems.find((item) => item.record.id === candidate.id).record,
    candidate,
  );
  const sameRoom = calendarMoveLayout(
    room,
    { ...candidate, resourceId: room.id },
    context,
    "block",
  );
  assert.equal(sameRoom.length, 2);
  assert.deepEqual(
    new Set(sameRoom.map((item) => item.kind)),
    new Set(["appointment", "block"]),
  );
  assert.ok(sameRoom.every((item) => item.width === 50));
  const therapistCandidate = {
    ...candidate,
    resourceType: "therapist",
    resourceId: "t1",
    bed: null,
  };
  const therapistItems = calendarMoveLayout(
    { id: "t1", kind: "therapist", capacity: 1 },
    therapistCandidate,
    context,
    "block",
  );
  assert.equal(therapistItems.length, 2);
  assert.ok(therapistItems.every((item) => item.width === 50));
});

test("block saver compares resource identity and scope and sends no appointment-only fields", async () => {
  const original = calendarBlock(),
    writes = [];
  const saver = createCalendarMoveSaver({
    kind: "block",
    isCurrent: () => true,
    confirmTherapistChange: () =>
      assert.fail("Blocks never request a therapist"),
    onSave: (...args) => writes.push(args),
  });
  assert.equal(await saver.save(original, { ...original }), "unchanged");
  const candidate = { ...original, resourceId: "r2" };
  assert.equal(await saver.save(original, candidate), "saved");
  assert.deepEqual(writes, [[candidate, original, { kind: "block" }]]);
  assert.equal(Object.hasOwn(writes[0][0], "requestedTherapistId"), false);
  assert.equal(
    sameCalendarPosition(original, { ...original, bed: null }, "block"),
    false,
  );
  assert.equal(
    sameCalendarPosition(
      original,
      { ...original, resourceType: "therapist", resourceId: "t1", bed: null },
      "block",
    ),
    false,
  );
});

test("block save rejects duplicate concurrent writes, retains its version for conflict retry and suppresses stale results", async () => {
  const original = calendarBlock(),
    candidate = { ...original, start: 1135 },
    pending = deferred(),
    writes = [];
  const saver = createCalendarMoveSaver({
    kind: "block",
    isCurrent: () => true,
    onSave: (value) => {
      writes.push(value);
      if (writes.length === 1) return pending.promise;
    },
  });
  const first = saver.save(original, candidate);
  assert.equal(await saver.save(original, candidate), "busy");
  assert.equal(writes.length, 1);
  pending.reject(new Error("Calendar entry conflicts with another booking"));
  await assert.rejects(first, /conflicts/);
  assert.equal(saver.busy, false);
  assert.equal(await saver.save(original, candidate), "saved");
  assert.deepEqual(writes, [candidate, candidate]);
  for (const fail of [false, true]) {
    let current = true;
    const late = deferred();
    const staleSaver = createCalendarMoveSaver({
      kind: "block",
      isCurrent: () => current,
      onSave: () => late.promise,
    });
    const result = staleSaver.save(original, candidate);
    current = false;
    if (fail) late.reject(new Error("Late conflict"));
    else late.resolve();
    assert.equal(await result, "stale");
    assert.equal(staleSaver.busy, false);
  }
});

test("a scope-changing mouse drop latches explicit Save through later moves and return to the original position", async () => {
  const original = calendarBlock();
  assert.equal(
    calendarBlockMoveRequiresSave(original, { ...original, start: 1135 }),
    false,
  );
  let requiresSave = calendarBlockMoveRequiresSave(original, {
    ...original,
    resourceId: "single-room",
    bed: 0,
  });
  assert.equal(requiresSave, true);
  requiresSave = calendarBlockMoveRequiresSave(
    original,
    { ...original, start: 1135 },
    requiresSave,
  );
  assert.equal(requiresSave, true);
  requiresSave = calendarBlockMoveRequiresSave(
    original,
    original,
    requiresSave,
  );
  assert.equal(requiresSave, true);
  const saver = createCalendarMoveSaver({
    kind: "block",
    isCurrent: () => true,
    onSave: () => assert.fail("Returning unchanged must not write"),
  });
  assert.equal(await saver.save(original, original), "unchanged");
});
