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

test("overlapping notes and bookings remain separate inside their physical room table", () => {
  const items = calendarResourceItems(
    room,
    [appointment, { ...appointment, id: "a2", bed: 1 }],
    [block, { ...block, id: "b2", bed: 0, start: 680, duration: 20 }],
  );
  assert.equal(
    items.filter((i) => i.record.id === "b1").length,
    2,
    "whole-room entries mirror to both physical tables",
  );
  assert.equal(items.filter((i) => i.record.id === "b2").length, 1);
  for (const item of items) {
    assert.ok(item.left >= item.bed * 50);
    assert.ok(item.left + item.width <= (item.bed + 1) * 50 + 1e-9);
    for (const other of items)
      if (item !== other && item.bed === other.bed && intersects(item, other))
        assert.ok(
          item.left + item.width <= other.left + 1e-9 ||
            other.left + other.width <= item.left + 1e-9,
          `${item.record.id} must not obscure ${other.record.id}`,
        );
  }
});

test("non-overlapping clusters regain full table width; therapist entries do not leak into room lanes", () => {
  const items = calendarResourceItems(
    room,
    [appointment, { ...appointment, id: "later", start: 900 }],
    [
      block,
      { ...block, id: "tblock", resourceType: "therapist", resourceId: "t1" },
    ],
  );
  assert.equal(items.find((i) => i.record.id === "later").width, 50);
  assert.equal(
    items.some((i) => i.record.id === "tblock"),
    false,
  );
  const therapistItems = calendarResourceItems(
    { kind: "therapist", id: "t1", capacity: 1 },
    [appointment],
    [{ ...block, resourceType: "therapist", resourceId: "t1" }],
  );
  assert.equal(therapistItems.length, 2);
  assert.equal(therapistItems[0].width, 50);
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
