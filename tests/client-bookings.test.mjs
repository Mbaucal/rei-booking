import test from "node:test";
import assert from "node:assert/strict";
import {
  mountClientBookings,
  renderClientBookings,
} from "../public/client-bookings.js";

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const display = {
  esc,
  prettyDate: (value) => value,
  clock: () => "10:00",
  statusName: (value) =>
    ({ done: "Completed", cancelled: "Cancelled", no_show: "No Show" })[
      value
    ] || value,
  therapistName: () => "Fictional therapist",
  roomName: () => "Room 1",
};
const appointment = (changes = {}) => ({
  id: "booking-one",
  date: "2026-01-01",
  start: 600,
  duration: 60,
  serviceName: "Fictional treatment",
  therapistId: "t1",
  roomId: "r1",
  status: "done",
  requestedTherapistId: "t1",
  ...changes,
});
const data = (changes = {}) => ({
  client: { id: "client-a" },
  appointments: [appointment()],
  appointmentSummary: { total: 506, completed: 501, cancelled: 2, noShow: 1 },
  appointmentPagination: { page: 0, pageSize: 50, totalPages: 11 },
  ...changes,
});

// Minimal element harness for the mount lifecycle; display markup is tested separately.
function rootElement() {
  const nodes = new Map();
  const attributes = new Map();
  function element(markup = "") {
    let html = "";
    const result = {
      hidden: /\bhidden\b/.test(markup),
      disabled: /\bdisabled\b/.test(markup),
      onclick: null,
      get innerHTML() {
        return html;
      },
      set innerHTML(value) {
        html = value;
        scan(value);
      },
    };
    return result;
  }
  function scan(html) {
    for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))
      nodes.set(match[1], element(match[0]));
  }
  let html = "";
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      nodes.clear();
      html = value;
      scan(value);
    },
    querySelector(selector) {
      return nodes.get(selector.slice(1)) || null;
    },
    setAttribute(key, value) {
      attributes.set(key, value);
    },
    getAttribute(key) {
      return attributes.get(key);
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("native profile uses full-history totals, keeps statuses separate and exposes older pages", () => {
  const input = data(),
    before = JSON.stringify(input);
  const html = renderClientBookings(input, display);
  assert.match(html, /501 completed visits/);
  assert.match(html, /506 bookings · 2 cancelled · 1 no-shows/);
  assert.match(html, /Page 1 of 11/);
  assert.match(html, /id="client-bookings-prev" disabled/);
  assert.doesNotMatch(html, /id="client-bookings-next" disabled/);
  assert.equal((html.match(/data-client-booking=/g) || []).length, 1);
  assert.match(html, /♥ Requested/);
  assert.equal(JSON.stringify(input), before);
  const last = renderClientBookings(
    data({ appointmentPagination: { page: 10, pageSize: 50, totalPages: 11 } }),
    display,
  );
  assert.match(last, /Page 11 of 11/);
  assert.match(last, /id="client-bookings-next" disabled/);
});

test("empty and single-page native history do not show redundant pagination", () => {
  const html = renderClientBookings(
    data({
      appointments: [],
      appointmentSummary: { total: 0, completed: 0, cancelled: 0, noShow: 0 },
      appointmentPagination: { page: 0, pageSize: 50, totalPages: 1 },
    }),
    display,
  );
  assert.match(html, /0 completed visits/);
  assert.match(html, /No appointments yet/);
  assert.doesNotMatch(
    html,
    /client-bookings-prev|client-bookings-next|Page 1 of/,
  );
});

test("booking display escapes names, attributes and status text without exposing finance or notes", () => {
  const html = renderClientBookings(
    data({
      appointments: [
        appointment({
          id: '" onclick="bad()',
          serviceName: "<script>bad()</script>",
          status: '\"><img src=x onerror="bad()">',
          note: "PRIVATE_NOTE",
          grossCents: 999999,
          netCents: 888888,
        }),
      ],
    }),
    {
      ...display,
      therapistName: () => "<b>therapist</b>",
      roomName: () => "<img src=x>",
    },
  );
  assert.doesNotMatch(html, /<script>|<img|<b>|PRIVATE_NOTE|999999|888888/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-client-booking="&quot; onclick=&quot;bad\(\)"/);
  assert.match(html, /class="status "/);
});

test("mount uses initial response without a fetch; pagination updates totals and suppresses duplicate clicks", async () => {
  const root = rootElement(),
    calls = [];
  let resolve;
  const cleanup = mountClientBookings({
    root,
    ...display,
    clientId: "client-a",
    initialData: data(),
    isCurrent: () => true,
    api: (path) => {
      calls.push(path);
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  assert.equal(calls.length, 0);
  const next = root.querySelector("#client-bookings-next");
  next.onclick();
  next.onclick();
  assert.deepEqual(calls, ["/clients/client-a?appointments_page=1"]);
  assert.equal(next.disabled, true);
  assert.equal(root.getAttribute("aria-busy"), "true");
  resolve(
    data({
      appointments: [appointment({ id: "older-booking" })],
      appointmentSummary: {
        total: 507,
        completed: 502,
        cancelled: 2,
        noShow: 1,
      },
      appointmentPagination: { page: 1, pageSize: 50, totalPages: 11 },
    }),
  );
  await tick();
  assert.match(root.innerHTML, /502 completed visits/);
  assert.match(root.innerHTML, /Page 2 of 11/);
  assert.match(root.innerHTML, /older-booking/);
  assert.doesNotMatch(root.innerHTML, /data-client-booking="booking-one"/);
  assert.equal(root.getAttribute("aria-busy"), "false");
  root.querySelector("#client-bookings-prev").onclick();
  assert.equal(calls.at(-1), "/clients/client-a?appointments_page=0");
  cleanup();
  resolve(data());
  await tick();
});

test("failed page retains the visible rows and offers retry without mixing clients", async () => {
  const root = rootElement();
  let calls = 0;
  const cleanup = mountClientBookings({
    root,
    ...display,
    clientId: "client-a",
    initialData: data(),
    isCurrent: () => true,
    api: async () => {
      calls++;
      if (calls === 1) throw new Error("<script>Network failed</script>");
      if (calls === 2)
        return data({
          client: { id: "wrong-client" },
          appointments: [appointment({ serviceName: "WRONG_CLIENT_DETAIL" })],
        });
      return data({
        appointmentPagination: { page: 1, pageSize: 50, totalPages: 11 },
      });
    },
  });
  root.querySelector("#client-bookings-next").onclick();
  await tick();
  assert.match(root.innerHTML, /booking-one/);
  assert.equal(root.querySelector("#client-bookings-error").hidden, false);
  assert.match(
    root.querySelector("#client-bookings-error").innerHTML,
    /&lt;script&gt;Network failed/,
  );
  assert.equal(root.querySelector("#client-bookings-next").disabled, false);
  root.querySelector("#client-bookings-retry").onclick();
  await tick();
  assert.doesNotMatch(root.innerHTML, /WRONG_CLIENT_DETAIL/);
  assert.match(
    root.querySelector("#client-bookings-error").innerHTML,
    /could not be verified/,
  );
  root.querySelector("#client-bookings-retry").onclick();
  await tick();
  assert.match(root.innerHTML, /Page 2 of 11/);
  assert.equal(root.querySelector("#client-bookings-error").hidden, true);
  cleanup();
});

test("closing the profile or changing the current client ignores delayed page responses", async () => {
  for (const dispose of [false, true]) {
    const root = rootElement();
    let current = true,
      resolve;
    const cleanup = mountClientBookings({
      root,
      ...display,
      clientId: "client-a",
      initialData: data(),
      isCurrent: () => current,
      api: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    root.querySelector("#client-bookings-next").onclick();
    const before = root.innerHTML;
    if (dispose) cleanup();
    else current = false;
    resolve(data({ appointments: [appointment({ id: "STALE_DETAIL" })] }));
    await tick();
    assert.equal(root.innerHTML, before);
    assert.doesNotMatch(root.innerHTML, /STALE_DETAIL/);
    cleanup();
  }
});
