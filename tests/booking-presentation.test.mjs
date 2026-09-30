import test from "node:test";
import assert from "node:assert/strict";
import {
  bookingSummary,
  bookingSummaryHTML,
} from "../public/booking-presentation.js";

const catalogue = {
  services: [
    { id: "s1", name: "Thai massage" },
    { id: "s2", name: "Aroma oil" },
  ],
  therapists: [
    { id: "t1", name: "Dao" },
    { id: "t2", name: "Jenny" },
  ],
  rooms: [
    { id: "r1", name: "Couple room", capacity: 2 },
    { id: "r2", name: "Single room", capacity: 1 },
  ],
};
const selection = (overrides = {}) => ({
  date: "2026-09-30",
  start: "19:00",
  duration: "90",
  serviceId: "s1",
  therapistId: "t1",
  roomId: "r1",
  bed: "1",
  ...overrides,
});

test("live booking presentation reflects edited treatment, time, duration and resource values", () => {
  const initial = bookingSummary(selection(), catalogue);
  assert.equal(initial.date, "Wed, 30 Sept 2026");
  assert.equal(initial.time, "19:00–20:30");
  assert.equal(initial.duration, "90 min");
  assert.equal(initial.treatment, "Thai massage");
  assert.equal(initial.therapist, "Dao");
  assert.equal(initial.room, "Couple room");
  assert.equal(initial.table, "Table 2");
  const changed = bookingSummary(
    selection({
      start: "18:55",
      duration: "120",
      serviceId: "s2",
      therapistId: "t2",
      roomId: "r2",
      bed: "0",
    }),
    catalogue,
  );
  assert.equal(changed.time, "18:55–20:55");
  assert.equal(changed.duration, "120 min");
  assert.equal(changed.treatment, "Aroma oil");
  assert.equal(changed.therapist, "Jenny");
  assert.equal(changed.room, "Single room");
  assert.equal(changed.table, "Table 1");
});

test("blank, invalid, fractional and overflowing values never create misleading zero or NaN summaries", () => {
  for (const start of [
    "",
    "x",
    "24:00",
    "12:60",
    "19:02",
    "19:05:00",
    null,
    undefined,
    600,
  ]) {
    const result = bookingSummary(selection({ start }), catalogue);
    assert.equal(result.time, "Choose a start time");
    assert.doesNotMatch(JSON.stringify(result), /NaN|undefined/);
  }
  for (const duration of [
    "",
    " ",
    null,
    undefined,
    false,
    "bad",
    "Infinity",
    0,
    -5,
    6,
    60.5,
    725,
  ]) {
    const result = bookingSummary(selection({ duration }), catalogue);
    assert.equal(result.duration, "Choose a duration");
    assert.equal(result.time, "19:00 · choose a duration");
  }
  assert.equal(
    bookingSummary(selection({ start: "23:55", duration: "5" }), catalogue)
      .time,
    "23:55–24:00",
  );
  assert.equal(
    bookingSummary(selection({ start: "23:55", duration: "10" }), catalogue)
      .time,
    "23:55 · end time exceeds this day",
  );
  assert.equal(
    bookingSummary(selection({ start: "00:00", duration: "5" }), catalogue)
      .time,
    "00:00–00:05",
  );
  for (const date of [
    "",
    null,
    undefined,
    "2026-02-30",
    "2026-9-30",
    "not a date",
  ])
    assert.equal(
      bookingSummary(selection({ date }), catalogue).date,
      "Choose a date",
    );
  assert.equal(
    bookingSummary(selection({ date: "2028-02-29" }), catalogue).date,
    "Tue, 29 Feb 2028",
  );
});

test("unknown resources and empty or invalid table values remain explicitly incomplete", () => {
  const unknown = bookingSummary(
    selection({ serviceId: "other", therapistId: "other", roomId: "other" }),
    catalogue,
  );
  assert.equal(unknown.treatment, "Choose a treatment");
  assert.equal(unknown.therapist, "Choose a therapist");
  assert.equal(unknown.room, "Choose a room");
  assert.equal(unknown.table, "Choose a table");
  for (const bed of ["", " ", null, undefined, false, -1, 0.5, 2])
    assert.equal(
      bookingSummary(selection({ bed }), catalogue).table,
      "Choose a table",
    );
  assert.equal(
    bookingSummary(selection({ roomId: "r2", bed: "1" }), catalogue).table,
    "Choose a table",
  );
  assert.equal(bookingSummary(selection(), {}).treatment, "Choose a treatment");
});

test("summary escapes catalogue names and never renders client identities, notes, prices or availability claims", () => {
  const html = bookingSummaryHTML(
    selection({
      clientName: "SECRET CLIENT",
      note: "SECRET NOTE",
      newName: "SECRET NEW CLIENT",
      grossCents: 987654321,
      netCents: 123456789,
      available: true,
      saved: true,
    }),
    {
      ...catalogue,
      services: [{ id: "s1", name: '<img src=x onerror="alert(1)">' }],
      therapists: [{ id: "t1", name: "<b>Dao</b>" }],
      rooms: [{ id: "r1", name: "Room & <script>1</script>", capacity: 2 }],
    },
  );
  assert.match(html, /Current selection/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;b&gt;Dao&lt;\/b&gt;/);
  assert.doesNotMatch(
    html,
    /<img|<script|SECRET|987654321|123456789|available|saved|RSD/i,
  );
});
