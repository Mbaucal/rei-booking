// Independent browser acceptance with fictional API data; never contacts a salon account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
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
    role: "owner",
    clientResponses: [],
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
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", csp);
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
          user: { id: "qa-owner", role: f.role, name: "Fictional QA Owner" },
          csrf: "fixture-csrf",
          mustChangePassword: false,
        });
      if (url.pathname === "/api/catalogue") return json(f.catalogue);
      if (url.pathname === "/api/clients") {
        const response = f.clientResponses.shift();
        if (response?.wait) await response.wait.promise;
        if (response?.fail)
          return json({ error: "Fictional client-list outage" }, 503);
        return json({ clients: response?.clients || f.clients });
      }
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
    if (f.role === "owner") {
      await page.locator("#report-metrics .report-metric").first().waitFor();
      await page.locator('[data-page="calendar"]').click();
    } else await page.locator("#calendar-grid").waitFor();
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
  } catch (error) {
    await capture(
      page,
      id.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-failure",
    ).catch(() => {});
    throw error;
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
async function capture(page, name) {
  if (!process.env.REI_BROWSER_ARTIFACTS) return;
  const dir = resolve(process.env.REI_BROWSER_ARTIFACTS);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, name + ".png") });
}
async function withinViewport(page, locator, description) {
  const rect = await locator.boundingBox(),
    viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
  assert.ok(
    rect && rect.width > 0 && rect.height > 0,
    description + " is rendered",
  );
  assert.ok(
    rect.x >= -1 &&
      rect.y >= -1 &&
      rect.x + rect.width <= viewport.width + 1 &&
      rect.y + rect.height <= viewport.height + 1,
    description + " fits the viewport: " + JSON.stringify({ rect, viewport }),
  );
  return rect;
}
async function menuAt(page, point) {
  const menu = page.locator("#calendar-slot-menu");
  await menu.waitFor();
  const rect = await withinViewport(page, menu, "Quick-action popup");
  const dx = Math.max(rect.x - point.x, point.x - rect.x - rect.width, 0);
  const dy = Math.max(rect.y - point.y, point.y - rect.y - rect.height, 0);
  assert.ok(
    Math.hypot(dx, dy) <= 32,
    "Popup stays near the chosen slot rather than the page bottom",
  );
  assert.equal(
    await page.locator("#appointment-form").count(),
    0,
    "Slot click opens quick actions first",
  );
}
async function formAtTop(page) {
  await withinViewport(page, page.locator("#drawer"), "Booking dialog");
  const result = await page.locator("#drawer-content").evaluate((content) => {
    const field = content.querySelector("#booking-client-search"),
      box = content.getBoundingClientRect(),
      input = field.getBoundingClientRect();
    return {
      scroll: content.scrollTop,
      visible: input.top >= box.top - 1 && input.bottom <= box.bottom + 1,
    };
  });
  assert.ok(
    result.scroll <= 1 && result.visible,
    "A newly opened form starts at its visible top, before any auto-scrolling: " +
      JSON.stringify(result),
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
  const box = await column.boundingBox();
  await menuAt(page, { x: box.x + position.x, y: box.y + position.y });
  await capture(page, `${device.name}-calendar-popup`);
  await page.locator("#calendar-slot-add").click();
  await page.locator("#appointment-form").waitFor();
  await formAtTop(page);
  if (device.name === "desktop") await capture(page, "desktop-opened-booking");
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
  await scenario(
    "hover band and exact time respect room halves; keyboard quick actions work",
    desktop,
    async ({ page, open }) => {
      await open();
      await page.locator('[data-mode="rooms"]').click();
      const column = page.locator('[data-resource="r1"]');
      await column.evaluate((el) => {
        el.closest(".calendar-scroll").scrollTop = 0;
      });
      const box = await column.boundingBox();
      for (const minute of [605, 610, 625]) {
        await page.mouse.move(
          box.x + box.width * 0.75,
          box.y + (minute - 600) * 2 + 1,
        );
        const hint = column.locator(".calendar-slot-hint");
        await hint.waitFor();
        assert.equal(await hint.getAttribute("data-start"), String(minute));
        assert.equal(await hint.getAttribute("data-band-start"), "600");
        assert.equal(
          await hint.locator(".calendar-slot-time").textContent(),
          `10:${String(minute - 600).padStart(2, "0")}`,
        );
        const rect = await hint.boundingBox();
        assert.ok(
          Math.abs(rect.height - 60) <= 3,
          "The hover band spans 30 minutes at the calendar's 2px/minute scale",
        );
        assert.ok(
          rect.x >= box.x + box.width / 2 - 3 &&
            rect.x + rect.width <= box.x + box.width + 1,
          "Hover stays in the selected room table half",
        );
      }
      await column.focus();
      await page.keyboard.press("Home");
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await page.locator("#calendar-slot-menu").waitFor();
      assert.match(
        await page.locator("#calendar-slot-menu-time").textContent(),
        /10:15/,
      );
      assert.match(
        await page.locator("#calendar-slot-menu-resource").textContent(),
        /Table 2/,
      );
      await page.keyboard.press("Escape");
      await page.locator("#calendar-slot-menu").waitFor({ state: "hidden" });
      assert.equal(
        await column.evaluate((el) => document.activeElement === el),
        true,
      );
      await page.keyboard.press("Enter");
      await page.locator("#calendar-slot-menu").waitFor();
      await page.locator("#calendar-scroll").evaluate((el) => {
        el.scrollTop += 20;
      });
      await page.locator("#calendar-slot-menu").waitFor({ state: "hidden" });
    },
  );
  for (const device of [desktop, phone])
    await scenario(
      "quick actions remain anchored inside a scrolled viewport edge",
      device,
      async ({ page, open }) => {
        await open();
        await page.locator('[data-mode="rooms"]').click();
        const scroller = page.locator("#calendar-scroll");
        await scroller.evaluate((el) => {
          el.scrollTop = 420;
          el.scrollLeft = el.scrollWidth - el.clientWidth;
        });
        await scroller.scrollIntoViewIfNeeded();
        const area = await scroller.boundingBox(),
          column = page.locator('[data-resource="r2"]'),
          box = await column.boundingBox();
        const viewport = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        const point = {
          x: Math.min(
            box.x + box.width - 8,
            area.x + area.width - 12,
            viewport.width - 12,
          ),
          y: Math.min(area.y + area.height - 15, viewport.height - 15),
        };
        const expectedStart = Math.round(((point.y - box.y) / 2 + 600) / 5) * 5;
        if (device.mobile) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        await menuAt(page, point);
        const expectedClock = `${String(Math.floor(expectedStart / 60)).padStart(2, "0")}:${String(expectedStart % 60).padStart(2, "0")}`;
        assert.match(
          await page.locator("#calendar-slot-menu-time").textContent(),
          new RegExp(expectedClock),
        );
        await capture(page, `${device.name}-scrolled-edge-popup`);
        await page.locator("#calendar-slot-add").click();
        await page.locator("#appointment-form").waitFor();
        await formAtTop(page);
        assert.equal((await selected(page)).start, expectedClock);
        assert.equal((await selected(page)).roomId, "r2");
        assert.equal((await selected(page)).bed, "0");
      },
    );
  await scenario(
    "reopening a booking resets old bottom scroll and keeps duration editable",
    phone,
    async ({ page, open }) => {
      await open();
      await add(page);
      await control(page, "note").fill("Scroll the old form to its bottom");
      const oldScroll = await page
        .locator("#drawer-content")
        .evaluate((el) => el.scrollTop);
      assert.ok(
        oldScroll > 100,
        "The regression fixture really scrolled the old drawer",
      );
      await page.locator("#form-cancel").click();
      await add(page);
      await formAtTop(page);
      await control(page, "duration").fill("90");
      await control(page, "duration").press("Tab");
      await stateIs(page, "available");
      assert.equal((await selected(page)).duration, "90");
      await page.locator("#form-save").click();
      await page.locator("#drawer").waitFor({ state: "hidden" });
    },
  );
  await scenario(
    "client-list failure exposes retry in a usable loading dialog",
    desktop,
    async ({ page, f, open }) => {
      await open();
      const held = deferred();
      f.delayed.set("client-error", held);
      f.clientResponses.push({ wait: held, fail: true });
      await page.locator("#appointment-add").click();
      await page.locator("#booking-opening[aria-busy=true]").waitFor();
      await withinViewport(page, page.locator("#drawer"), "Loading dialog");
      assert.equal(await page.locator("#form-cancel").isEnabled(), true);
      held.release();
      await page.locator("#booking-opening-error").waitFor();
      assert.match(
        await page.locator("#booking-opening-error").textContent(),
        /client-list outage/,
      );
      await page.locator("#booking-opening-retry").click();
      await page.locator("#appointment-form").waitFor();
      await formAtTop(page);
      await control(page, "serviceId").selectOption("s90");
      await stateIs(page, "available");
      assert.equal((await selected(page)).duration, "90");
    },
  );
  await scenario(
    "an old opening response cannot reset a newer form or reopen after navigation",
    desktop,
    async ({ page, f, open }) => {
      await open();
      const old = deferred();
      f.delayed.set("old-opening", old);
      f.clientResponses.push({ wait: old });
      await page.locator("#appointment-add").click();
      await page.locator("#booking-opening").waitFor();
      await page.locator("#form-cancel").click();
      await add(page);
      await control(page, "note").fill("Keep the newer form intact");
      const oldResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/clients",
      );
      old.release();
      await oldResponse;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert.equal((await selected(page)).note, "Keep the newer form intact");
      await page.locator("#form-cancel").click();
      const abandoned = deferred();
      f.delayed.set("abandoned-opening", abandoned);
      f.clientResponses.push({ wait: abandoned });
      const abandonedStarted = page.waitForRequest(
        (r) => new URL(r.url()).pathname === "/api/clients",
      );
      await page.locator("#appointment-add").click();
      const abandonedRequest = await abandonedStarted;
      await page.locator("#booking-opening").waitFor();
      await page.locator("#form-cancel").click();
      await page.locator('[data-page="clients"]').click();
      await page
        .locator("#page-title")
        .filter({ hasText: "Clients" })
        .waitFor();
      const abandonedResponse = page.waitForResponse(
        (r) => r.request() === abandonedRequest,
      );
      abandoned.release();
      await abandonedResponse;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert.equal(await page.locator("#drawer").isVisible(), false);
      assert.equal(await page.locator("#appointment-form").count(), 0);
      assert.equal(await page.locator("#page-title").textContent(), "Clients");
    },
  );
  await scenario(
    "stale client search cannot replace a reopened booking's client list",
    desktop,
    async ({ page, f, open }) => {
      await open();
      await add(page);
      await stateIs(page, "available");
      const held = deferred();
      f.delayed.set("old-search", held);
      f.clientResponses.push({
        wait: held,
        clients: [{ id: "obsolete", name: "Obsolete search response" }],
      });
      const started = page.waitForRequest(
        (r) =>
          new URL(r.url()).pathname === "/api/clients" &&
          new URL(r.url()).searchParams.get("q") === "old search",
      );
      await page.locator("#booking-client-search").fill("old search");
      await started;
      await page.locator("#form-cancel").click();
      await add(page);
      await stateIs(page, "available");
      await control(page, "clientId").selectOption("c1");
      const response = page.waitForResponse(
        (r) => new URL(r.url()).searchParams.get("q") === "old search",
      );
      held.release();
      await response;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert.equal((await selected(page)).clientId, "c1");
      assert.equal(
        await control(page, "clientId")
          .locator('option[value="obsolete"]')
          .count(),
        0,
      );
    },
  );
  await scenario(
    "existing appointment click and drag do not open empty-slot actions",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [booking("existing", "tA", "r1", 0)];
      await open();
      await page.locator('[data-mode="rooms"]').click();
      const event = page.locator('[data-appointment="existing"]');
      await event.click();
      await page.locator("#appointment-form").waitFor();
      assert.equal(
        await page.locator("#drawer-title").textContent(),
        "Appointment details",
      );
      assert.equal(
        await page.locator("#calendar-slot-menu").isVisible(),
        false,
      );
      assert.equal(await page.locator("#booking-availability").count(), 0);
      await page.locator("#form-cancel").click();
      const grip = await event.locator(".drag-grip").boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        grip.x + grip.width / 2,
        grip.y + grip.height / 2 + 20,
        { steps: 5 },
      );
      await page.mouse.up();
      await page
        .locator("#toast")
        .filter({ hasText: "Appointment moved" })
        .waitFor();
      assert.equal(f.writes.at(-1).method, "PUT");
      assert.equal(f.writes.at(-1).body.start, 610);
      assert.equal(
        await page.locator("#calendar-slot-menu").isVisible(),
        false,
      );
      assert.equal(await page.locator("#drawer").isVisible(), false);
    },
  );
  await scenario(
    "therapist calendar remains read-only without slot actions",
    desktop,
    async ({ page, f, open }) => {
      f.role = "therapist";
      f.appointments = [booking("read-only", "tA", "r1", 0)];
      await open();
      await page.locator('[data-mode="rooms"]').click();
      const column = page.locator('[data-resource="r1"]'),
        box = await column.boundingBox();
      await page.mouse.move(box.x + box.width * 0.75, box.y + 20);
      await page.mouse.click(box.x + box.width * 0.75, box.y + 20);
      assert.equal(
        await page.locator("#calendar-slot-menu").isVisible(),
        false,
      );
      assert.equal(
        await page.locator(".calendar-slot-hint:visible").count(),
        0,
      );
      assert.equal(await page.locator("#appointment-add").count(), 0);
      assert.equal(await page.locator(".drag-grip").count(), 0);
      await page.locator('[data-appointment="read-only"]').click();
      await page.locator("#drawer").waitFor();
      assert.equal(await page.locator("#appointment-form").count(), 0);
      assert.doesNotMatch(
        await page.locator("#drawer").textContent(),
        /Fictional QA Client/,
      );
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
