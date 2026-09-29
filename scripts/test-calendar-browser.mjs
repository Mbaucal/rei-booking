// Independent browser acceptance with fictional API data; never contacts a salon account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.REI_PLAYWRIGHT_MODULE;
if (!modulePath)
  throw new Error(
    "Set REI_PLAYWRIGHT_MODULE to the installed Playwright index.mjs.",
  );
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = resolve("public"),
  fixtures = new Map();
const date = "2026-10-01",
  nextDate = "2026-10-02";
const week = () =>
  Array.from({ length: 7 }, () => ({ enabled: true, start: 600, end: 1320 }));
function fixture() {
  const therapists = ["A", "B", "C"].map((letter) => ({
    id: "t" + letter,
    name: "QA Therapist " + letter,
    active: true,
    weekly: week(),
    timeOff: [],
    version: 1,
  }));
  return {
    catalogue: {
      therapists,
      rooms: [
        { id: "r1", name: "QA Couple", capacity: 2 },
        { id: "r2", name: "QA Single", capacity: 1 },
      ],
      services: [
        {
          id: "s60",
          name: "QA Massage",
          duration: 60,
          priceCents: 470000,
          color: "#2e87a0",
          active: true,
        },
        {
          id: "s90",
          name: "QA Longer Massage",
          duration: 90,
          priceCents: 590000,
          color: "#836da4",
          active: true,
        },
      ],
    },
    clients: [
      {
        id: "c1",
        name: "Fictional QA Client",
        phone: "+381600000001",
        email: "qa@example.test",
        instagram: "",
        note: "Fixture only",
      },
    ],
    appointments: [],
    writes: [],
    requests: [],
    delayed: new Map(),
    failDates: new Set(),
    failNextWrite: false,
  };
}
function booking(
  id,
  therapistId,
  roomId,
  bed,
  start = 600,
  duration = 60,
  day = date,
) {
  return {
    id,
    therapistId,
    roomId,
    bed,
    start,
    duration,
    date: day,
    serviceId: "s60",
    serviceName: "QA Massage",
    color: "#2e87a0",
    status: "booked",
    clientId: "c1",
    clientName: "Fictional QA Client",
    note: "",
    requestedTherapistId: null,
    grossCents: 470000,
    netCents: 470000,
    version: 1,
    createdAt: "2026-09-01T10:00:00Z",
  };
}
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    f = fixtures.get(req.headers["x-rei-fixture"]);
  const json = (value, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname.startsWith("/api/")) {
      if (!f) return json({ error: "Unknown fictional test session" }, 401);
      f.requests.push({
        path: url.pathname,
        query: url.search,
        method: req.method,
      });
      if (url.pathname === "/api/session")
        return json({
          user: { id: "qa-owner", role: "owner", name: "Fictional QA Owner" },
          csrf: "fixture-csrf",
          mustChangePassword: false,
        });
      if (url.pathname === "/api/catalogue") return json(f.catalogue);
      if (url.pathname === "/api/clients") return json({ clients: f.clients });
      if (url.pathname === "/api/clients/matches") return json({ matches: [] });
      if (url.pathname === "/api/reports/appointments")
        return json({
          options: { from: date, to: date },
          comparison: null,
          totals: { revenueCents: 0, completed: 0, totalMinutes: 0 },
        });
      if (url.pathname === "/api/appointments" && req.method === "GET") {
        const from = url.searchParams.get("from"),
          to = url.searchParams.get("to");
        const result = structuredClone(
          f.appointments.filter(
            (a) => (!from || a.date >= from) && (!to || a.date <= to),
          ),
        );
        const delay = f.delayed.get(from);
        if (delay) await delay.promise;
        if (f.failDates.has(from))
          return json({ error: "Fictional availability outage" }, 503);
        return json({ appointments: result });
      }
      if (
        url.pathname.startsWith("/api/appointments") &&
        ["POST", "PUT"].includes(req.method)
      ) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        f.writes.push({ body, method: req.method, path: url.pathname });
        assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
        if (f.failNextWrite) {
          f.failNextWrite = false;
          return json(
            {
              error:
                "That therapist or table is already booked. Choose another time or resource.",
            },
            409,
          );
        }
        const saved = {
          ...booking(
            "new-" + f.writes.length,
            body.therapistId,
            body.roomId,
            body.bed,
          ),
          ...body,
        };
        f.appointments.push(saved);
        return json({ appointment: saved }, req.method === "POST" ? 201 : 200);
      }
      return json({ error: "Unimplemented fixture API: " + url.pathname }, 404);
    }
    const path = resolve(
      root,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    if (!res.headersSent) json({ error: String(error.message) }, 500);
    else res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let passed = 0;

async function scenario(name, device, run) {
  const id = name + "-" + device.name,
    f = fixture();
  fixtures.set(id, f);
  const context = await browser.newContext({
    viewport: device.viewport,
    isMobile: device.mobile || false,
    hasTouch: device.mobile || false,
    extraHTTPHeaders: { "x-rei-fixture": id },
    timezoneId: "Europe/Belgrade",
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  const open = async () => {
    await page.goto(origin);
    await page.locator("#report-metrics .report-metric").first().waitFor();
    await page.locator('[data-page="calendar"]').click();
    await page.locator("#calendar-date").fill(date);
    await page.locator("#calendar-date").dispatchEvent("change");
    await page
      .locator("#calendar-summary")
      .filter({ hasText: "Oct" })
      .waitFor();
  };
  try {
    await run({ page, f, open, device });
    assert.deepEqual(
      errors,
      [],
      "The actual application emitted a browser exception",
    );
    passed++;
    console.log(`PASS ${device.name}: ${name}`);
  } finally {
    for (const delay of f.delayed.values()) delay.release();
    await context.close();
    fixtures.delete(id);
  }
}

const desktop = { name: "desktop", viewport: { width: 1440, height: 1100 } };
const phone = {
  name: "phone",
  viewport: { width: 390, height: 844 },
  mobile: true,
};
const tablet = {
  name: "tablet",
  viewport: { width: 820, height: 1180 },
  mobile: true,
};
const control = (page, name) =>
  page.locator(`#appointment-form [name="${name}"]`);
async function stateIs(page, state) {
  await page.locator(`#booking-availability[data-state="${state}"]`).waitFor();
}
async function selected(page) {
  return page
    .locator("#appointment-form")
    .evaluate((form) =>
      Object.fromEntries(
        [
          "date",
          "start",
          "duration",
          "therapistId",
          "roomId",
          "bed",
          "clientId",
          "requestedTherapistId",
          "note",
          "serviceId",
          "grossCents",
          "netCents",
        ].map((name) => [name, form.elements[name]?.value]),
      ),
    );
}
async function roomSlot(page, device, id = "r1", lane = 1) {
  await page.locator('[data-mode="rooms"]').click();
  const column = page.locator(`[data-resource="${id}"]`);
  await column.evaluate((el) => {
    const scroller = el.closest(".calendar-scroll");
    scroller.scrollTop = 0;
    scroller.scrollLeft = el.offsetLeft - 60;
  });
  const width = await column.evaluate((el) => el.clientWidth);
  const position = {
    x: width * (id === "r1" ? (lane === 1 ? 0.75 : 0.25) : 0.5),
    y: 4,
  };
  if (device.mobile) await column.tap({ position });
  else await column.click({ position });
  await page.locator("#appointment-form").waitFor();
}
async function add(page) {
  await page.locator("#appointment-add").click();
  await page.locator("#appointment-form").waitFor();
}
function deferred() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}

try {
  for (const device of [desktop, phone, tablet]) {
    await scenario(
      "clicked second table, full treatment recheck and intact save",
      device,
      async ({ page, f, open }) => {
        f.appointments = [
          booking("busy-a", "tA", "r1", 0),
          booking("later-b", "tB", "r2", 0, 660),
        ];
        await open();
        await roomSlot(page, device);
        await stateIs(page, "available");
        let values = await selected(page);
        assert.equal(values.roomId, "r1");
        assert.equal(values.bed, "1");
        assert.equal(values.therapistId, "tB");
        assert.equal(values.start, "10:00");
        assert.equal(values.date, date);
        assert.equal(values.clientId, "", "A new booking starts as Walk-in");
        await control(page, "serviceId").selectOption("s90");
        await stateIs(page, "available");
        await page.waitForFunction(
          () => document.querySelector('[name="therapistId"]').value === "tC",
        );
        values = await selected(page);
        assert.equal(values.duration, "90");
        assert.equal(
          values.bed,
          "1",
          "Changing treatment must preserve the clicked table",
        );
        assert.equal(values.grossCents, "5900.00");
        await control(page, "clientId").selectOption("c1");
        await control(page, "requestedTherapistId").selectOption("tC");
        await control(page, "note").fill("Fictional QA appointment note");
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.writes[0].body, {
          date,
          start: 600,
          duration: 90,
          serviceId: "s90",
          therapistId: "tC",
          roomId: "r1",
          bed: 1,
          status: "booked",
          clientId: "c1",
          requestedTherapistId: "tC",
          note: "Fictional QA appointment note",
          grossCents: 590000,
          netCents: 590000,
        });
        assert.equal(await page.locator("#app-error").isVisible(), false);
      },
    );
  }
  await scenario(
    "explicit resources warn without reassignment and failed save recovers",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [booking("occupied", "tA", "r1", 0)];
      await open();
      await add(page);
      await stateIs(page, "available");
      await control(page, "therapistId").selectOption("tA");
      await stateIs(page, "warning");
      let values = await selected(page);
      assert.equal(
        values.therapistId,
        "tA",
        "Explicit unavailable therapist must remain selected",
      );
      await control(page, "note").fill("Keep me after a server collision");
      await control(page, "requestedTherapistId").selectOption("tA");
      f.failNextWrite = true;
      await page.locator("#form-save").click();
      await page
        .locator("#form-error")
        .filter({ hasText: "already booked" })
        .waitFor();
      await stateIs(page, "warning");
      assert.equal(await control(page, "therapistId").isEnabled(), true);
      assert.equal(await page.locator("#form-save").isEnabled(), true);
      values = await selected(page);
      assert.equal(values.therapistId, "tA");
      assert.equal(values.note, "Keep me after a server collision");
      assert.equal(values.requestedTherapistId, "tA");
      assert.equal(
        f.appointments.length,
        1,
        "Rejected save cannot create a fixture booking",
      );
      await control(page, "start").fill("11:00");
      await control(page, "start").press("Tab");
      await stateIs(page, "available");
      values = await selected(page);
      assert.equal(values.therapistId, "tA");
      await page.locator("#form-save").click();
      await page.locator("#drawer").waitFor({ state: "hidden" });
      assert.equal(f.writes.at(-1).body.start, 660);
      assert.equal(
        f.writes.at(-1).body.clientId,
        null,
        "Walk-in remains without a client",
      );
    },
  );
  await scenario(
    "manual room and table choices remain explicit",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [booking("future-table", "tA", "r1", 1, 720)];
      await open();
      await add(page);
      await stateIs(page, "available");
      await control(page, "bed").selectOption("1");
      await stateIs(page, "available");
      await control(page, "start").fill("12:00");
      await control(page, "start").press("Tab");
      await stateIs(page, "warning");
      assert.equal((await selected(page)).bed, "1");
      await control(page, "roomId").selectOption("r2");
      await stateIs(page, "available");
      let values = await selected(page);
      assert.equal(values.roomId, "r2");
      assert.equal(
        values.bed,
        "0",
        "A one-table room must select its valid table",
      );
      await control(page, "roomId").selectOption("r1");
      await stateIs(page, "available");
      values = await selected(page);
      assert.equal(values.bed, "0");
      await control(page, "therapistId").focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Tab");
      await stateIs(page, "available");
      assert.equal(
        (await selected(page)).therapistId,
        "tB",
        "Keyboard selection must reach the real form listener",
      );
    },
  );
  await scenario(
    "fully booked and fetch failure stay advisory, never claim availability",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [
        booking("a", "tA", "r1", 0),
        booking("b", "tB", "r1", 1),
        booking("c", "tC", "r2", 0),
      ];
      await open();
      await add(page);
      await stateIs(page, "warning");
      assert.match(
        await page.locator("#booking-availability").textContent(),
        /No therapist is available/,
      );
      assert.equal((await selected(page)).start, "10:00");
      f.failDates.add(nextDate);
      await control(page, "date").fill(nextDate);
      await control(page, "date").press("Tab");
      await stateIs(page, "warning");
      assert.match(
        await page.locator("#booking-availability").textContent(),
        /could not be checked/,
      );
      assert.equal(
        await page.locator("#form-save").isEnabled(),
        true,
        "The atomic API remains available for manually chosen resources",
      );
      assert.equal(f.writes.length, 0);
    },
  );
  await scenario(
    "late availability cannot replace a newer date or closed drawer",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [
        booking("next-day-a", "tA", "r1", 0, 600, 60, nextDate),
      ];
      await open();
      const held = deferred();
      f.delayed.set(date, held);
      await add(page);
      await stateIs(page, "loading");
      await control(page, "date").fill(nextDate);
      await control(page, "date").press("Tab");
      await stateIs(page, "available");
      let values = await selected(page);
      assert.equal(values.therapistId, "tB");
      assert.equal(values.bed, "1");
      const oldResponse = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/appointments" &&
          new URL(r.url()).searchParams.get("from") === date,
      );
      held.release();
      await oldResponse;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      values = await selected(page);
      assert.equal(values.date, nextDate);
      assert.equal(values.therapistId, "tB");
      f.delayed.delete(date);
      const closed = deferred();
      f.delayed.set("2026-10-03", closed);
      await control(page, "date").fill("2026-10-03");
      await control(page, "date").press("Tab");
      await stateIs(page, "loading");
      await page.locator("#form-cancel").click();
      const closedResponse = page.waitForResponse(
        (r) => new URL(r.url()).searchParams.get("from") === "2026-10-03",
      );
      closed.release();
      await closedResponse;
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      assert.equal(await page.locator("#drawer").isVisible(), false);
      assert.equal(await page.locator("#appointment-form").count(), 0);
      assert.equal(f.writes.length, 0);
    },
  );
  assert.ok(passed > 0, "No browser acceptance scenarios ran");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `Calendar browser acceptance: ${passed} passed. Chromium emulation only; physical touch devices are not certified.`,
);
