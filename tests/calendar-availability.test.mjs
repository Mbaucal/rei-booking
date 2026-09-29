import test from "node:test";
import assert from "node:assert/strict";
import {
  suggestBookingResources,
  mountBookingAvailability,
} from "../public/calendar-availability.js";

const date = "2026-09-29";
const therapist = (id, extra = {}) => ({
  id,
  name: id,
  active: true,
  weekly: Array.from({ length: 7 }, () => ({
    enabled: true,
    start: 600,
    end: 1320,
  })),
  timeOff: [],
  ...extra,
});
const catalogue = () => ({
  therapists: [therapist("t1"), therapist("t2"), therapist("t3")],
  rooms: [
    { id: "r1", name: "Room 1", capacity: 2 },
    { id: "r2", name: "Room 2", capacity: 1 },
  ],
});
const selection = (extra = {}) => ({
  date,
  start: 840,
  duration: 60,
  status: "booked",
  therapistId: "t1",
  roomId: "r1",
  bed: 0,
  ...extra,
});
const booking = (extra = {}) => ({ id: "occupied", ...selection(), ...extra });
const suggest = (
  appointments,
  fixed = {},
  extra = {},
  resources = catalogue(),
) =>
  suggestBookingResources({
    catalogue: resources,
    appointments,
    fixed,
    selection: selection(extra),
  });

test("therapist slot keeps its time and therapist, finds the second table for the entire treatment", () => {
  const result = suggest(
    [booking({ therapistId: "t2", start: 880, duration: 20 })],
    { therapistId: true },
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.selection, selection({ bed: 1 }));
  assert.match(result.message, /Table 2/);
});

test("room slot retains its clicked table half and selects a free therapist", () => {
  const result = suggest(
    [booking({ roomId: "r2", bed: 0 })],
    { roomId: true, bed: true },
    { bed: 1 },
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.selection, selection({ therapistId: "t2", bed: 1 }));
  const blocked = suggest(
    [booking({ bed: 1 })],
    { roomId: true, bed: true },
    { therapistId: "t2", bed: 1 },
  );
  assert.equal(blocked.available, false);
  assert.deepEqual(blocked.selection, selection({ therapistId: "t2", bed: 1 }));
});

test("working hours include the full interval; weekly day off, dated time off and inactive therapists are excluded", () => {
  const resources = catalogue();
  resources.therapists[0].weekly[2].end = 895;
  resources.therapists[1].weekly[2].enabled = false;
  resources.therapists[2].timeOff = [date];
  resources.therapists.push(therapist("inactive", { active: false }));
  assert.equal(suggest([], {}, {}, resources).available, false);
  resources.therapists[0].weekly[2].end = 900;
  assert.equal(suggest([], {}, {}, resources).selection.therapistId, "t1");
  assert.equal(
    suggest([], { therapistId: true }, { therapistId: "t2" }, resources)
      .available,
    false,
  );
});

test("cancelled/no-show and other dates do not block; completed bookings still occupy resources; adjacent intervals fit", () => {
  for (const status of ["cancelled", "no_show"])
    assert.equal(
      suggest([booking({ status })], {
        therapistId: true,
        roomId: true,
        bed: true,
      }).available,
      true,
    );
  assert.equal(
    suggest([booking({ date: "2026-09-30" })], { therapistId: true }).available,
    true,
  );
  for (const [start, duration] of [
    [780, 60],
    [900, 60],
  ])
    assert.equal(
      suggest([booking({ start, duration })], {
        therapistId: true,
        roomId: true,
        bed: true,
      }).available,
      true,
    );
  assert.equal(
    suggest([booking({ status: "done" })], { therapistId: true }).available,
    false,
  );
  assert.equal(
    suggest([booking()], {}, { status: "cancelled" }).available,
    true,
  );
});

test("duration/time/capacity constraints fail explicitly and never silently move the requested appointment", () => {
  for (const changes of [
    { start: 841 },
    { duration: 61 },
    { start: 595 },
    { start: 1290, duration: 35 },
    { duration: 0 },
    { date: "2026-02-30" },
    { date: "" },
  ]) {
    const result = suggest([], {}, changes);
    assert.equal(result.available, false);
    assert.deepEqual(result.selection, selection(changes));
  }
  const wrongTable = suggest(
    [],
    { roomId: true, bed: true },
    { roomId: "r2", bed: 1 },
  );
  assert.equal(wrongTable.available, false);
  assert.match(wrongTable.message, /valid table/);
});

test("explicit therapist/room/table choices are retained and flagged; automatic suggestions prefer still-free selections", () => {
  const fixed = { therapistId: true, roomId: true, bed: true };
  const result = suggest([booking()], fixed);
  assert.equal(result.available, false);
  assert.deepEqual(result.selection, selection());
  assert.deepEqual(
    suggest([], {}, { therapistId: "t3", roomId: "r2" }).selection,
    selection({ therapistId: "t3", roomId: "r2" }),
  );
  const fullRooms = [
    booking({ therapistId: "t2" }),
    booking({ therapistId: "t3", bed: 1 }),
    booking({ therapistId: "other", roomId: "r2" }),
  ];
  assert.equal(suggest(fullRooms, { therapistId: true }).available, false);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}
function harness(defaults = {}, initial = {}) {
  const elements = Object.fromEntries(
    Object.entries({
      date,
      start: "14:00",
      duration: "60",
      status: "booked",
      serviceId: "massage",
      therapistId: "t1",
      roomId: "r1",
      bed: "0",
      clientId: "client",
      note: "Keep this note",
      requestedTherapistId: "t1",
      ...initial,
    }).map(([name, value]) => [name, { name, value, disabled: false }]),
  );
  const handlers = {},
    requests = [],
    applied = [];
  let open = true;
  const form = {
    elements,
    addEventListener(name, fn) {
      handlers[name] = fn;
    },
  };
  const feedback = { textContent: "", dataset: {} };
  const controller = mountBookingAvailability({
    form,
    feedback,
    catalogue: catalogue(),
    defaults,
    loadAppointments(day) {
      const pending = deferred();
      requests.push({ day, ...pending });
      return pending.promise;
    },
    applyResources(next) {
      applied.push(next);
      for (const name of ["therapistId", "roomId", "bed"])
        elements[name].value = String(next[name]);
    },
    isCurrent: () => open,
  });
  return {
    elements,
    requests,
    applied,
    feedback,
    controller,
    close() {
      open = false;
    },
    change(name, value, event = "change") {
      elements[name].value = value;
      handlers[event]({ target: elements[name] });
    },
  };
}

test("late day responses cannot replace suggestions for the new date; input invalidation happens before blur", async () => {
  const h = harness({ roomId: "r1", bed: 1 }, { bed: "1" });
  h.change("date", "2026-09-30", "input");
  assert.deepEqual(
    h.requests.map((r) => r.day),
    [date, "2026-09-30"],
  );
  h.requests[1].resolve([booking({ date: "2026-09-30", roomId: "r2" })]);
  await flush();
  assert.equal(h.elements.therapistId.value, "t2");
  h.requests[0].resolve([]);
  await flush();
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].date, "2026-09-30");
  assert.equal(h.elements.bed.value, "1");
});

test("explicit choices during a pending request supersede it, remain selected on conflict and leave client/note/request untouched", async () => {
  const h = harness();
  h.change("therapistId", "t3");
  h.change("bed", "1");
  h.requests[2].resolve([booking({ therapistId: "t3", bed: 1 })]);
  await flush();
  assert.equal(h.feedback.dataset.state, "warning");
  h.requests[0].resolve([]);
  h.requests[1].resolve([]);
  await flush();
  assert.equal(h.applied.length, 0);
  assert.equal(h.elements.therapistId.value, "t3");
  assert.equal(h.elements.bed.value, "1");
  assert.equal(h.elements.clientId.value, "client");
  assert.equal(h.elements.note.value, "Keep this note");
  assert.equal(h.elements.requestedTherapistId.value, "t1");
});

test("treatment duration changes refresh availability without resetting explicit table choice", async () => {
  const h = harness({ therapistId: "t1" });
  h.requests[0].resolve([]);
  await flush();
  h.change("bed", "1");
  h.requests[1].resolve([]);
  await flush();
  h.elements.duration.value = "90";
  h.change("serviceId", "long-massage");
  h.requests[2].resolve([
    booking({ therapistId: "t2", bed: 1, start: 910, duration: 30 }),
  ]);
  await flush();
  assert.equal(h.elements.duration.value, "90");
  assert.equal(h.elements.bed.value, "1");
  assert.equal(h.feedback.dataset.state, "warning");
});

test("choosing a different room releases the previous table constraint and suggests a free table in the selected room", async () => {
  const h = harness({ roomId: "r2", bed: 0 }, { roomId: "r2" });
  h.requests[0].resolve([]);
  await flush();
  h.change("roomId", "r1");
  h.requests[1].resolve([booking({ therapistId: "t2" })]);
  await flush();
  assert.equal(h.elements.roomId.value, "r1");
  assert.equal(h.elements.bed.value, "1");
  assert.equal(h.feedback.dataset.state, "available");
  h.change("bed", "0");
  h.requests[2].resolve([booking({ therapistId: "t2" })]);
  await flush();
  assert.equal(h.elements.bed.value, "0");
  assert.equal(h.feedback.dataset.state, "warning");
});

test("closing a drawer prevents success/error callbacks; network failures allow manual resources", async () => {
  for (const fail of [false, true]) {
    const h = harness();
    h.close();
    if (fail) h.requests[0].reject(new Error("failed"));
    else h.requests[0].resolve([]);
    await flush();
    assert.equal(h.applied.length, 0);
    assert.equal(h.feedback.dataset.state, "loading");
  }
  const h = harness();
  h.requests[0].reject(new Error("failed"));
  await flush();
  assert.equal(h.feedback.dataset.state, "warning");
  assert.match(h.feedback.textContent, /choose your resources and save/);
  assert.equal(h.elements.therapistId.disabled, false);
});

test("submit suspension prevents resource changes; conflict recovery refreshes without replacing submitted selections", async () => {
  const h = harness();
  for (const field of Object.values(h.elements)) field.disabled = true;
  h.controller.suspend();
  h.requests[0].resolve([booking()]);
  await flush();
  assert.equal(h.applied.length, 0);
  const resumed = h.controller.resume();
  h.requests[1].resolve([booking()]);
  await resumed;
  assert.equal(h.feedback.dataset.state, "warning");
  assert.equal(h.elements.therapistId.value, "t1");
  assert.equal(h.elements.roomId.value, "r1");
  assert.equal(h.elements.bed.value, "0");
  assert.equal(h.elements.note.value, "Keep this note");
  assert.ok(Object.values(h.elements).every((el) => el.disabled));
});
