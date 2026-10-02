import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarResourceItems,
  calendarBlockHTML,
  calendarBlockDetailsHTML,
} from "../public/calendar-blocks.js";
import { suggestBookingResources } from "../public/calendar-availability.js";

const room = { id: "r1", name: "Fictional room", capacity: 2, kind: "room" };
const appointment = {
  id: "a1",
  date: "2026-09-30",
  start: 660,
  duration: 60,
  therapistId: "t1",
  roomId: "r1",
  bed: 0,
  status: "booked",
};
const block = {
  id: "b1",
  date: appointment.date,
  start: 675,
  duration: 15,
  resourceType: "room",
  resourceId: "r1",
  bed: null,
  title: "PRIVATE title",
  note: "PRIVATE call note",
  blocksAvailability: false,
  version: 1,
};
const intersects = (a, b) =>
  a.record.start < b.record.start + b.record.duration &&
  b.record.start < a.record.start + a.record.duration;

test("a lone room appointment or note fills the column regardless of its physical table", () => {
  for (const bed of [0, 1]) {
    const record = { ...appointment, bed };
    const [item] = calendarResourceItems(room, [record]);
    assert.equal(item.left, 0);
    assert.equal(item.width, 100);
    assert.equal(item.bed, bed);
    assert.equal(item.record, record, "the physical assignment is unchanged");
  }
  for (const bed of [null, 0, 1]) {
    const items = calendarResourceItems(room, [], [{ ...block, bed }]);
    assert.equal(items.length, 1, "whole-room blocks are not duplicated");
    assert.equal(items[0].left, 0);
    assert.equal(items[0].width, 100);
    assert.equal(items[0].bed, bed);
  }
});

test("simultaneous room appointments share the column independent of bed number", () => {
  const items = calendarResourceItems(room, [
    { ...appointment, id: "a2", bed: 0 },
    { ...appointment, id: "a1", bed: 1 },
  ]);
  assert.deepEqual(
    items.map((i) => [i.record.id, i.left, i.width, i.bed]),
    [
      ["a1", 0, 50, 1],
      ["a2", 50, 50, 0],
    ],
  );
});

test("overlapping room notes and appointments remain distinct with more entries than physical tables", () => {
  const items = calendarResourceItems(
    room,
    [appointment, { ...appointment, id: "a2", bed: 1 }],
    [block, { ...block, id: "b2", bed: 0, start: 680, duration: 20 }],
  );
  assert.equal(items.length, 4);
  assert.equal(items.filter((i) => i.record.id === "b1").length, 1);
  for (const item of items) {
    assert.equal(item.width, 25);
    assert.ok(item.left >= 0 && item.left + item.width <= 100);
    for (const other of items)
      if (item !== other && intersects(item, other))
        assert.ok(
          item.left + item.width <= other.left + 1e-9 ||
            other.left + other.width <= item.left + 1e-9,
          `${item.record.id} must not obscure ${other.record.id}`,
        );
  }
});

test("overlap chains reuse lanes and boundary-adjacent clusters regain the full room width", () => {
  const items = calendarResourceItems(
    room,
    [
      appointment,
      { ...appointment, id: "adjacent", start: 720, bed: 1 },
      { ...appointment, id: "later", start: 900 },
    ],
    [block, { ...block, id: "next-note", start: 690, duration: 30, bed: 1 }],
  );
  const byId = (id) => items.find((i) => i.record.id === id);
  assert.equal(
    byId("b1").lane,
    byId("next-note").lane,
    "adjacent notes reuse their lane",
  );
  for (const id of ["a1", "b1", "next-note"]) assert.equal(byId(id).width, 50);
  for (const id of ["adjacent", "later"]) {
    assert.equal(byId(id).width, 100);
    assert.equal(byId(id).left, 0);
  }
});

test("room layout is deterministic under source order changes and does not mutate records", () => {
  const appointments = [appointment, { ...appointment, id: "a2", bed: 1 }];
  const blocks = [block, { ...block, id: "b2", start: 680, bed: 0 }];
  const before = structuredClone({ appointments, blocks });
  const layout = (appointments, blocks) =>
    calendarResourceItems(room, appointments, blocks).map(
      ({ record, ...item }) => ({ ...item, id: record.id }),
    );
  assert.deepEqual(
    layout(appointments, blocks),
    layout([...appointments].reverse(), [...blocks].reverse()),
  );
  assert.deepEqual({ appointments, blocks }, before);
});

test("unrelated resources and released appointments do not occupy room or therapist lanes", () => {
  const appointments = [
    appointment,
    { ...appointment, id: "other-room", roomId: "r2", therapistId: "t2" },
    { ...appointment, id: "cancelled", status: "cancelled" },
    { ...appointment, id: "no-show", status: "no_show" },
  ];
  const therapistBlock = {
    ...block,
    id: "tblock",
    resourceType: "therapist",
    resourceId: "t1",
  };
  const blocks = [
    block,
    therapistBlock,
    { ...block, id: "other-room-block", resourceId: "r2" },
  ];
  const items = calendarResourceItems(room, appointments, blocks);
  assert.deepEqual(
    items.map((i) => i.record.id),
    ["a1", "b1"],
  );
  assert.ok(items.every((i) => i.width === 50));
  const therapistItems = calendarResourceItems(
    { kind: "therapist", id: "t1", capacity: 1 },
    appointments,
    blocks,
  );
  assert.deepEqual(
    therapistItems.map((i) => i.record.id),
    ["a1", "tblock"],
  );
  assert.ok(therapistItems.every((i) => i.width === 50 && i.bed === 0));
  const [single] = calendarResourceItems(
    { kind: "therapist", id: "t1", capacity: 1 },
    [appointment],
  );
  assert.equal(single.width, 100);
});

test("therapist rendering removes private text and actions even with owner-shaped block data", () => {
  const item = calendarResourceItems(room, [], [block])[0];
  const catalogue = { rooms: [room], therapists: [] };
  for (const html of [
    calendarBlockHTML(item, "therapist"),
    calendarBlockDetailsHTML(block, { role: "therapist", catalogue }),
  ]) {
    assert.doesNotMatch(
      html,
      /PRIVATE|calendar-block-edit|calendar-block-remove/,
    );
    assert.match(html, /Calendar note/);
  }
  const owner = calendarBlockHTML(item, "owner");
  assert.match(owner, /PRIVATE call note/);
  assert.match(owner, /is-short/);
});

test("block cards expose overlap styling and split times without changing accessible time or physical metadata", () => {
  const solo = calendarResourceItems(room, [], [block])[0];
  const overlap = calendarResourceItems(room, [appointment], [block]).find(
    (item) => item.kind === "block",
  );
  const soloHTML = calendarBlockHTML(solo, "owner");
  const overlapHTML = calendarBlockHTML(overlap, "owner");
  assert.doesNotMatch(soloHTML, /is-overlapping/);
  assert.match(overlapHTML, /is-overlapping/);
  assert.match(overlapHTML, /data-block-bed="null"/);
  assert.match(
    overlapHTML,
    /class="block-start">11:15<\/span><span class="block-time-separator">–<\/span><span class="block-end">11:30<\/span>/,
  );
  assert.match(overlapHTML, /aria-label="[^"\n]*11:15–11:30/);
});

test("block free text is escaped in card, accessible name and details", () => {
  const unsafe = {
    ...block,
    title: '<img src=x onerror="bad()">',
    note: "<script>bad()</script>",
    duration: 60,
  };
  const item = calendarResourceItems(room, [], [unsafe])[0];
  for (const html of [
    calendarBlockHTML(item, "reception"),
    calendarBlockDetailsHTML(unsafe, {
      role: "owner",
      catalogue: { rooms: [room], therapists: [] },
    }),
  ]) {
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /&lt;/);
  }
});

test("availability ignores notes but respects full-duration therapist, bed and whole-room blocks", () => {
  const weekly = Array.from({ length: 7 }, () => ({
    enabled: true,
    start: 600,
    end: 1320,
  }));
  const catalogue = {
    rooms: [room],
    therapists: ["t1", "t2"].map((id) => ({
      id,
      name: id,
      active: true,
      weekly,
      timeOff: [],
    })),
  };
  const selection = { ...appointment, status: "booked" };
  const suggest = (blocks, fixed = {}) =>
    suggestBookingResources({
      catalogue,
      selection,
      appointments: [],
      blocks,
      fixed,
    });
  assert.equal(
    suggest([block]).selection.bed,
    0,
    "notes do not consume availability",
  );
  assert.equal(
    suggest([{ ...block, bed: 0, blocksAvailability: true }]).selection.bed,
    1,
  );
  assert.equal(
    suggest([{ ...block, bed: 0, blocksAvailability: true }], {
      roomId: true,
      bed: true,
    }).available,
    false,
  );
  assert.equal(
    suggest([{ ...block, blocksAvailability: true }]).available,
    false,
  );
  assert.equal(
    suggest([
      {
        ...block,
        resourceType: "therapist",
        resourceId: "t1",
        blocksAvailability: true,
      },
    ]).selection.therapistId,
    "t2",
  );
  assert.equal(
    suggest([{ ...block, start: 720, blocksAvailability: true }]).available,
    true,
    "adjacent entries do not overlap",
  );
});
