import test from "node:test";
import assert from "node:assert/strict";
import {
  appointmentDetailsHTML,
  appointmentPreviewPosition,
} from "../public/appointment-preview.js";

const catalogue = {
  therapists: [
    { id: "t1", name: "Therapist Willow" },
    { id: "t2", name: "Therapist Maple" },
  ],
  rooms: [{ id: "r1", name: "Room 1" }],
};
const appointment = {
  id: "a1",
  date: "2026-09-30",
  start: 855,
  duration: 90,
  status: "confirmed",
  serviceName: "Aroma massage",
  color: "#527c70",
  therapistId: "t1",
  roomId: "r1",
  bed: 1,
  requestedTherapistId: "t2",
  clientId: "c1",
  clientName: "Fictional Customer",
  note: "Sensitive fictional note\nSecond line",
  netCents: 590000,
  grossCents: 650000,
  createdAt: "2026-09-29T10:00:00Z",
};

test("owner summary shows real allowed details and only supported actions", () => {
  const html = appointmentDetailsHTML(appointment, {
    role: "owner",
    catalogue,
  });
  for (const value of [
    "14:15",
    "15:45",
    "Confirmed",
    "Fictional Customer",
    "90 minutes",
    "Room 1 · Table 2",
    "Therapist Maple requested",
    "Assigned to Therapist Willow",
    "Sensitive fictional note",
    "RSD",
    "5,900.00",
    "6,500.00",
    "appointment-summary-edit",
    "appointment-summary-reschedule",
    "appointment-summary-client",
  ])
    assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /Checkout|Repeat appointment|Recurrence/);
});

test("therapist rendering strips client identity, initials, notes, financial values and operator actions even from owner-shaped input", () => {
  for (const variant of ["preview", "summary"]) {
    const html = appointmentDetailsHTML(appointment, {
      role: "therapist",
      catalogue,
      variant,
    });
    for (const value of [
      "Fictional Customer",
      "Sensitive fictional note",
      "RSD",
      "5,900",
      "6,500",
      "appointment-summary-client",
      "appointment-summary-edit",
      "appointment-summary-reschedule",
      "appointment-client-symbol",
      "Booked on",
    ])
      assert.ok(!html.includes(value), `${variant}: ${value}`);
    for (const value of [
      "Aroma massage",
      "90 minutes",
      "Room 1 · Table 2",
      "Therapist Maple requested",
      "14:15",
    ])
      assert.ok(html.includes(value), value);
  }
});

test("reception sees clients without financial values; previews are noninteractive and omit private notes", () => {
  const html = appointmentDetailsHTML(appointment, {
    role: "reception",
    catalogue,
  });
  assert.match(html, /Fictional Customer/);
  assert.match(html, /appointment-summary-edit/);
  assert.doesNotMatch(html, /RSD|5,900|6,500|Full price/);
  const preview = appointmentDetailsHTML(appointment, {
    role: "owner",
    catalogue,
    variant: "preview",
  });
  assert.doesNotMatch(preview, /<button|Sensitive fictional note|Booked on/);
  assert.match(preview, /Fictional Customer/);
});

test("walk-ins have no profile action and completed/cancelled appointments have no reschedule action", () => {
  const walkin = appointmentDetailsHTML(
    { ...appointment, clientId: null, clientName: null },
    { role: "owner", catalogue },
  );
  assert.match(walkin, /Walk-in/);
  assert.doesNotMatch(walkin, /id="appointment-summary-client"/);
  for (const status of ["done", "cancelled", "no_show"]) {
    const html = appointmentDetailsHTML(
      { ...appointment, status },
      { role: "owner", catalogue },
    );
    assert.doesNotMatch(html, /appointment-summary-reschedule/);
    assert.match(html, /appointment-summary-edit/);
  }
});

test("all untrusted text is escaped and invalid service colors cannot escape the style attribute", () => {
  const value = '<img src=x onerror="alert(1)"> & O\'Neil';
  const html = appointmentDetailsHTML(
    {
      ...appointment,
      clientName: value,
      serviceName: value,
      note: value,
      color: 'red\" onmouseover=\"alert(1)',
    },
    {
      role: "owner",
      catalogue: {
        therapists: [
          { id: "t1", name: value },
          { id: "t2", name: value },
        ],
        rooms: [{ id: "r1", name: value }],
      },
    },
  );
  assert.doesNotMatch(html, /<img|onmouseover=/);
  assert.match(
    html,
    /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; O&#39;Neil/,
  );
  assert.match(html, /--service:#a8863d/);
});

test("floating previews stay within desktop/tablet/offset viewport bounds near every edge", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { left: 15, top: 30, width: 390, height: 560 },
  ]) {
    const size = { width: 326, height: 430 };
    for (const x of [0, viewport.width - 100])
      for (const y of [0, viewport.height - 100]) {
        const left = x + (viewport.left || 0),
          top = y + (viewport.top || 0);
        const result = appointmentPreviewPosition(
          { left, right: left + 100, top },
          size,
          viewport,
        );
        assert.ok(result.left >= (viewport.left || 0) + 10);
        assert.ok(result.top >= (viewport.top || 0) + 10);
        assert.ok(
          result.left + size.width <=
            (viewport.left || 0) + viewport.width - 10,
        );
        assert.ok(
          result.top + size.height <=
            (viewport.top || 0) + viewport.height - 10,
        );
      }
  }
});
