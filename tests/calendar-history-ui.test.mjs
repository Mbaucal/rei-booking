import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarHistoryTherapists,
  calendarHistoryEventHTML,
  calendarHistoryDetailsHTML,
  calendarAppointmentCounts,
} from "../public/calendar-history.js";
import { calendarResourceItems } from "../public/calendar-blocks.js";
import { appointmentDetailsHTML } from "../public/appointment-preview.js";

const history = {
  id: "history:one",
  imported: true,
  readOnly: true,
  date: "2026-10-04",
  start: 600,
  duration: 90,
  status: "booked",
  sourceStatus: "New",
  serviceName: "Original treatment",
  therapistId: "t1",
  therapistName: "Original therapist",
  roomId: null,
  roomName: null,
  bed: null,
  requestState: "unknown",
  color: "#738a84",
  clientId: "c1",
  clientName: "Private source customer",
  phone: "PRIVATE phone",
  email: "PRIVATE email",
  note: "PRIVATE note",
  netCents: 9876543,
  grossCents: 99887766,
};
const current = {
  id: "native",
  date: history.date,
  start: 630,
  duration: 60,
  status: "confirmed",
  therapistId: "t1",
  roomId: "r1",
  bed: 0,
};
const resource = { kind: "therapist", id: "t1", capacity: 1 };

test("historical resources reuse explicit IDs and preserve live availability without changing the catalogue", () => {
  const catalogue = [
    {
      id: "t1",
      name: "Current name",
      active: true,
      weekly: [{ enabled: true }],
      timeOff: [],
    },
    { id: "t2", name: "Inactive team", active: false, weekly: [], timeOff: [] },
  ];
  const archived = [
    { id: "t1", name: "Old name", active: false, historyOnly: true },
    { id: "t2", name: "Previous name", active: false, historyOnly: true },
    { id: "history:therapist:one", name: "Unmapped team", active: true },
  ];
  const before = structuredClone({ catalogue, archived });
  const merged = calendarHistoryTherapists(catalogue, archived);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].name, "Current name");
  assert.equal(merged[0].active, true);
  assert.equal(merged[0].historyOnly, undefined);
  assert.equal(merged[1].active, false);
  assert.equal(merged[2].active, false);
  assert.equal(merged[2].historyOnly, true);
  assert.deepEqual(merged[2].weekly, []);
  assert.deepEqual({ catalogue, archived }, before);
  assert.deepEqual(calendarHistoryTherapists(catalogue), catalogue);
});

test("imported appointments share overlap lanes, retain cancellation evidence and never acquire a room", () => {
  const appointments = [
    current,
    history,
    {
      ...history,
      id: "history:cancelled",
      status: "cancelled",
      sourceStatus: "Canceled",
    },
    {
      ...history,
      id: "history:no-show",
      status: "no_show",
      sourceStatus: "No Show",
    },
    { ...current, id: "native-cancelled", status: "cancelled" },
  ];
  const before = structuredClone(appointments);
  const items = calendarResourceItems(resource, appointments);
  assert.equal(items.length, 4);
  assert.ok(items.every((item) => item.width === 25));
  assert.equal(items.filter((item) => item.record.id === history.id).length, 1);
  assert.equal(
    calendarResourceItems({ kind: "room", id: "r1" }, appointments).length,
    1,
  );
  assert.deepEqual(appointments, before);
});

test("calendar counts include imported visits once and separate imported status evidence from active appointments", () => {
  assert.deepEqual(calendarAppointmentCounts([current], [history]), {
    appointments: 2,
    imported: 1,
  });
  assert.deepEqual(
    calendarAppointmentCounts(
      [],
      [
        history,
        { ...history, status: "cancelled" },
        { ...history, status: "no_show" },
        { ...history, status: "unknown", sourceStatus: "Started" },
      ],
    ),
    { appointments: 2, imported: 4 },
  );
  assert.deepEqual(calendarAppointmentCounts(), {
    appointments: 0,
    imported: 0,
  });
});

test("imported card and details are read-only and preserve source time, duration and original status", () => {
  const card = calendarHistoryEventHTML(history, "owner", {
    left: 50,
    width: 50,
  });
  const details = appointmentDetailsHTML(history, {
    role: "owner",
    catalogue: { therapists: [], rooms: [] },
  });
  assert.match(card, /data-imported="true"/);
  assert.match(card, /Imported/);
  assert.match(card, /is-overlapping/);
  assert.match(details, /Original treatment/);
  assert.match(details, /Original therapist/);
  assert.match(details, /New/);
  assert.match(details, /10:00/);
  assert.match(details, /11:30/);
  assert.match(details, /90 minutes/);
  assert.match(details, /Request not recorded/);
  assert.match(details, /Not recorded/);
  assert.match(details, /appointment-summary-client/);
  for (const html of [card, details]) {
    assert.doesNotMatch(
      html,
      /appointment-summary-edit|appointment-summary-reschedule|drag-grip|Table 1|No specific therapist request|PRIVATE|9876543|99887766/,
    );
  }
});

test("therapists never receive client identity in HTML, even with an owner-shaped imported object", () => {
  for (const html of [
    calendarHistoryEventHTML(history, "therapist"),
    calendarHistoryDetailsHTML(history, { role: "therapist" }),
    appointmentDetailsHTML(history, {
      role: "therapist",
      catalogue: { therapists: [], rooms: [] },
      variant: "preview",
    }),
  ]) {
    assert.doesNotMatch(
      html,
      /Private source customer|PRIVATE|9876543|99887766|appointment-summary-client|appointment-client-symbol/,
    );
    assert.match(html, /Original treatment/);
    assert.match(html, /90 minutes/);
  }
  for (const role of ["owner", "reception"]) {
    const html = calendarHistoryDetailsHTML(history, { role });
    assert.match(html, /Private source customer/);
    assert.doesNotMatch(html, /PRIVATE|9876543|99887766/);
  }
});

test("only explicitly linked imported clients offer a profile action and hover remains noninteractive", () => {
  for (const props of [
    [{ ...history, clientId: null }, { role: "owner" }],
    [history, { role: "owner", variant: "preview" }],
    [history, { role: "therapist" }],
  ])
    assert.doesNotMatch(calendarHistoryDetailsHTML(...props), /<button/);
  assert.match(
    calendarHistoryDetailsHTML(history, { role: "reception" }),
    /Open client profile/,
  );
  assert.match(
    calendarHistoryDetailsHTML(
      { ...history, requestState: "yes", roomName: "Source Room" },
      { role: "owner" },
    ),
    /Requested therapist/,
  );
  assert.match(
    calendarHistoryDetailsHTML(
      { ...history, requestState: "no" },
      { role: "owner" },
    ),
    /No specific therapist request/,
  );
});

test("source labels and status are escaped and untrusted colors cannot inject markup", () => {
  const attack = '<img src=x onerror="alert(1)"> & Test';
  const a = {
    ...history,
    clientName: attack,
    serviceName: attack,
    therapistName: attack,
    roomName: attack,
    sourceStatus: attack,
    color: 'red;" onclick="alert(1)',
  };
  for (const html of [
    calendarHistoryEventHTML(a, "owner"),
    calendarHistoryDetailsHTML(a, { role: "owner" }),
  ]) {
    assert.doesNotMatch(html, /<img|onclick=|--service:red/);
    assert.match(html, /&lt;img/);
    assert.match(html, /--service:#708f89/);
  }
  assert.match(
    calendarHistoryEventHTML(
      { ...history, status: "cancelled", sourceStatus: "Canceled" },
      "owner",
    ),
    /is-released/,
  );
  assert.match(
    calendarHistoryEventHTML(
      { ...history, status: "no_show", sourceStatus: "No Show" },
      "owner",
    ),
    /No Show/,
  );
});
