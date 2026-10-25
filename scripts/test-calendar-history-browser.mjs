// Render the shipped calendar with fictional historical data on loopback only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.REI_PLAYWRIGHT_MODULE)
  throw new Error(
    "Set REI_PLAYWRIGHT_MODULE to the installed Playwright index.mjs.",
  );
const { chromium } = await import(
  pathToFileURL(resolve(process.env.REI_PLAYWRIGHT_MODULE)).href
);
const publicRoot = resolve("public"),
  fixtures = new Map();
const date = "2026-10-04",
  nextDate = "2026-10-05";
const sourceTherapist = "history:therapist:" + "a".repeat(64);
const privateClient = "PRIVATE Fictional Imported Client";
const week = () =>
  Array.from({ length: 7 }, () => ({ enabled: true, start: 600, end: 1320 }));
function historical(id, therapistId = "tA", changes = {}) {
  return {
    id: "history:" + id,
    imported: true,
    readOnly: true,
    source: "fictional",
    date,
    start: 600,
    duration: 60,
    status: "booked",
    sourceStatus: "New",
    serviceId: "s60",
    serviceName: "Original source massage",
    therapistId,
    therapistName: "Original source therapist",
    roomId: null,
    roomName: null,
    bed: null,
    requestState: "unknown",
    color: "#2e87a0",
    clientId: "c1",
    clientName: privateClient,
    ...changes,
  };
}
function native(changes = {}) {
  return {
    id: "native",
    therapistId: "tA",
    roomId: "r1",
    bed: 0,
    date,
    start: 690,
    duration: 60,
    status: "booked",
    serviceId: "s60",
    serviceName: "Current massage",
    color: "#2e87a0",
    clientId: "c1",
    clientName: "Fictional Native Client",
    note: "",
    requestedTherapistId: null,
    grossCents: 470000,
    netCents: 470000,
    version: 1,
    createdAt: "2026-09-01T10:00:00Z",
    ...changes,
  };
}
function fixture() {
  return {
    role: "owner",
    writes: [],
    requests: [],
    unexpected: [],
    delayed: new Map(),
    omitHistory: false,
    appointments: [],
    history: [
      historical("linked"),
      historical("unlinked", sourceTherapist, {
        start: 660,
        status: "confirmed",
        sourceStatus: "Confirmed",
        clientId: null,
        clientName: "Fictional Source Guest",
        therapistName: "Unmapped source therapist",
      }),
      historical("old", "tOld", {
        start: 630,
        duration: 90,
        status: "unknown",
        sourceStatus: "Started",
        therapistName: "Therapist's previous name",
      }),
      historical("cancelled", "tB", {
        duration: 30,
        status: "cancelled",
        sourceStatus: "Cancelled",
      }),
      historical("no-show", "tC", {
        start: 660,
        status: "no_show",
        sourceStatus: "No Show",
      }),
    ],
    catalogue: {
      therapists: ["A", "B", "C", "Old"].map((key) => ({
        id: "t" + key,
        name:
          key === "Old"
            ? "Retired mapped therapist"
            : "Current therapist " + key,
        active: key !== "Old",
        weekly: week(),
        timeOff: [],
        version: 1,
      })),
      rooms: [{ id: "r1", name: "Fictional room", capacity: 2 }],
      services: [
        {
          id: "s60",
          name: "Current massage",
          duration: 60,
          priceCents: 470000,
          color: "#2e87a0",
          active: true,
          version: 1,
        },
      ],
    },
  };
}
function historyPayload(f, from, to) {
  const appointments = structuredClone(
    f.history.filter((a) => a.date >= from && a.date <= to),
  );
  const therapists = [
    ...new Map(
      appointments.map((a) => {
        const mapped = f.catalogue.therapists.find(
          (t) => t.id === a.therapistId,
        );
        return [
          a.therapistId,
          {
            id: a.therapistId,
            name: mapped?.name || a.therapistName,
            kind: "therapist",
            historyOnly: true,
            active: false,
          },
        ];
      }),
    ).values(),
  ];
  return {
    appointments,
    therapists,
    metadata: {
      from,
      to,
      loadedRows: appointments.length,
      roomlessRows: appointments.length,
      archiveRevision: 1,
      catalogueRevision: 1,
    },
  };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    f = fixtures.get(req.headers["x-history-fixture"]);
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'",
  );
  const json = (data, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    if (url.pathname.startsWith("/api/")) {
      assert.ok(f, "Fictional session is required");
      f.requests.push({
        path: url.pathname,
        query: url.search,
        method: req.method,
      });
      if (url.pathname === "/api/session")
        return json({
          user: { id: "fixture", name: "Fictional Account", role: f.role },
          csrf: "fixture-csrf",
          mustChangePassword: false,
        });
      if (url.pathname === "/api/catalogue") return json(f.catalogue);
      if (url.pathname === "/api/reports/appointments")
        return json({
          options: { from: date, to: date },
          comparison: null,
          totals: { revenueCents: 0, completed: 0, totalMinutes: 0 },
        });
      if (url.pathname === "/api/appointments" && req.method === "GET") {
        const from = url.searchParams.get("from"),
          to = url.searchParams.get("to") || from;
        const payload = {
          appointments: structuredClone(
            f.appointments.filter((a) => a.date >= from && a.date <= to),
          ),
          blocks: [],
          ...(!f.omitHistory ? { history: historyPayload(f, from, to) } : {}),
        };
        if (f.delayed.has(from)) await f.delayed.get(from).promise;
        return json(payload);
      }
      if (req.method !== "GET") {
        let raw = "";
        for await (const part of req) raw += part;
        const body = raw ? JSON.parse(raw) : {};
        f.writes.push({ path: url.pathname, method: req.method, body });
        assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
        if (
          req.method === "PUT" &&
          url.pathname === "/api/appointments/native"
        ) {
          const previous = f.appointments.find((a) => a.id === "native");
          assert.ok(previous);
          Object.assign(previous, body, { version: previous.version + 1 });
          return json({ appointment: previous });
        }
        return json({ error: "Historical records must not be mutated" }, 405);
      }
      if (url.pathname === "/api/clients")
        return json({
          clients: [
            { id: "c1", name: privateClient, phone: "", email: "", note: "" },
          ],
        });
      f.unexpected.push(`${req.method} ${url.pathname}`);
      return json({ error: "Unexpected fixture route" }, 404);
    }
    const file = resolve(
      publicRoot,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    assert.ok(file.startsWith(publicRoot + sep));
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
        }[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch (error) {
    f?.unexpected.push(error.message);
    if (!res.headersSent) json({ error: error.message }, 500);
    else res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.REI_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.REI_CHROMIUM_EXECUTABLE }
    : {}),
});
const desktop = { name: "desktop", viewport: { width: 1440, height: 1100 } };
const phone = {
  name: "phone",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
let passed = 0;
const failures = [];
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
const card = (page, id) =>
  page.locator(`[data-kind="therapist"] [data-appointment="${id}"]`);
async function setDate(page, day) {
  await page.locator("#calendar-date").fill(day);
  await page.locator("#calendar-date").dispatchEvent("change");
  const expected = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
  await page.waitForFunction(
    (text) =>
      document.querySelector("#calendar-summary")?.textContent.includes(text),
    expected,
  );
}
async function selectMode(page, mode) {
  if (await page.locator(`[data-mode="${mode}"]`).isVisible())
    await page.locator(`[data-mode="${mode}"]`).click();
  else {
    await page.locator("#calendar-view-options").click();
    await page.locator(`[data-mobile-mode="${mode}"]`).click();
    await page.locator("#drawer").waitFor({ state: "hidden" });
  }
}
async function point(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box && box.width && box.height);
  return {
    x: box.x + Math.min(40, box.width / 2),
    y: box.y + Math.min(24, box.height / 2),
  };
}
async function noOverflow(page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
    "The page does not overflow horizontally",
  );
  const drawer = page.locator("#drawer[open]");
  if (await drawer.count())
    assert.equal(
      await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
      "Details fit the phone width",
    );
}
async function capture(page, name) {
  if (!process.env.REI_BROWSER_ARTIFACTS) return;
  const dir = resolve(process.env.REI_BROWSER_ARTIFACTS);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, name + ".png") });
}
async function scenario(name, device, run) {
  const f = fixture(),
    key = device.name + "-" + name;
  fixtures.set(key, f);
  const { name: _name, ...options } = device;
  const context = await browser.newContext({
    ...options,
    timezoneId: "Europe/Belgrade",
    extraHTTPHeaders: { "x-history-fixture": key },
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
    if (f.role === "owner" && !device.isMobile) {
      await page.locator("#report-metrics .report-metric").first().waitFor();
      await page.locator('nav [data-page="calendar"]').click();
    }
    await page.locator("#calendar-grid").waitFor();
    await setDate(page, date);
    await selectMode(page, "therapists");
  };
  try {
    await run({ page, f, open });
    assert.deepEqual(
      errors,
      [],
      "The shipped app emitted no browser exceptions",
    );
    assert.deepEqual(f.unexpected, [], "No unexpected API calls");
    passed++;
    console.log(`PASS ${device.name}: ${name}`);
  } catch (error) {
    failures.push({ name, device: device.name, error: error.message });
    console.error(`FAIL ${device.name}: ${name}\n${error.stack || error}`);
    await capture(page, key.replace(/[^a-z0-9]+/gi, "-") + "-failure").catch(
      () => {},
    );
  } finally {
    for (const delay of f.delayed.values()) delay.release();
    await context.close();
    fixtures.delete(key);
  }
}
try {
  await scenario(
    "imported dates render mapped, inactive and unmapped columns with overlap lanes",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [native({ start: 615, duration: 30 })];
      await open();
      assert.equal(await page.locator('[data-imported="true"]').count(), 5);
      assert.match(
        await page.locator("#calendar-summary").innerText(),
        /4 appointments.*5 imported/,
      );
      assert.equal(await page.locator('[data-resource="tOld"]').count(), 1);
      assert.equal(
        await page.locator(`[data-resource="${sourceTherapist}"]`).count(),
        1,
      );
      assert.equal(
        await card(page, "history:cancelled").evaluate((el) =>
          el.classList.contains("is-released"),
        ),
        true,
      );
      assert.equal(
        await card(page, "history:no-show").evaluate((el) =>
          el.classList.contains("is-released"),
        ),
        true,
      );
      const layout = await page
        .locator('[data-resource="tA"]')
        .evaluate((column) => {
          const imported = column
            .querySelector('[data-imported="true"]')
            .getBoundingClientRect();
          const native = column
            .querySelector('[data-appointment="native"]')
            .getBoundingClientRect();
          return {
            width: column.getBoundingClientRect().width,
            imported: { x: imported.x, width: imported.width },
            native: { x: native.x, width: native.width },
          };
        });
      assert.ok(
        layout.imported.width < layout.width * 0.6 &&
          layout.native.width < layout.width * 0.6,
        "Overlapping cards share visual lanes",
      );
      assert.ok(
        Math.abs(layout.imported.x - layout.native.x) > layout.width * 0.4,
      );
      assert.deepEqual(f.writes, []);
      await capture(page, "desktop-imported-calendar");
    },
  );
  await scenario(
    "hover and details preserve source evidence without edit controls or invented room",
    desktop,
    async ({ page, f, open }) => {
      f.history[0].serviceName =
        "Source <img src=x onerror=alert(1)> treatment";
      await open();
      await card(page, "history:linked").hover();
      await page.locator("#appointment-hover").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#appointment-hover").innerText(),
        /Imported/i,
      );
      assert.match(
        await page.locator("#appointment-hover").innerText(),
        /Source <img src=x onerror=alert\(1\)> treatment/,
      );
      assert.equal(
        await page.locator("#appointment-hover img").count(),
        0,
        "Source labels stay escaped",
      );
      await card(page, "history:linked").click();
      await page.locator(".is-imported-summary").waitFor();
      const details = await page.locator("#drawer-content").innerText();
      assert.match(details, /Original source therapist/);
      assert.match(details, /New/);
      assert.doesNotMatch(details, /Table 1|No specific therapist request/);
      assert.equal(
        await page
          .locator("#appointment-summary-edit, #appointment-summary-reschedule")
          .count(),
        0,
      );
      assert.equal(
        await page.locator("#appointment-summary-client").count(),
        1,
      );
      await page.locator("#drawer-close").click();
      await card(page, "history:unlinked").click();
      await page.locator(".is-imported-summary").waitFor();
      assert.equal(
        await page.locator("#appointment-summary-client").count(),
        0,
      );
      assert.match(
        await page.locator("#drawer-content").innerText(),
        /Fictional Source Guest/,
      );
      assert.deepEqual(f.writes, []);
    },
  );
  await scenario(
    "imported drag sends no writes and native five-minute move can overlap history",
    desktop,
    async ({ page, f, open }) => {
      f.history = [historical("linked")];
      f.appointments = [native()];
      await open();
      const start = await point(card(page, "history:linked"));
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x, start.y + 30, { steps: 5 });
      await page.mouse.up();
      await frames(page);
      assert.equal(
        await page.locator("#calendar-reschedule-bar").isVisible(),
        false,
      );
      assert.deepEqual(f.writes, []);
      if (await page.locator("#drawer").isVisible())
        await page.locator("#drawer-close").click();
      const live = await point(card(page, "native"));
      await page.mouse.move(live.x, live.y);
      await page.mouse.down();
      await page.mouse.move(live.x, live.y - 110, { steps: 8 });
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#calendar-reschedule-save").isEnabled(),
        true,
        "Archived history does not occupy a live booking slot",
      );
      assert.deepEqual(f.writes, [], "A mouse drag is not saved before drop");
      // Desktop drops commit automatically; the Save button belongs to the
      // active draft (and the touch confirmation flow), not a second click.
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === "/api/appointments/native",
      );
      await page.mouse.up();
      assert.equal((await saved).status(), 200);
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        document
          .querySelector(
            '[data-kind="therapist"] [data-appointment="native"] .event-time',
          )
          ?.textContent.includes("10:35–11:35"),
      );
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].method, "PUT");
      assert.equal(f.writes[0].path, "/api/appointments/native");
      assert.equal(f.writes[0].body.start, 635);
      assert.equal(f.history[0].start, 600);
      assert.match(
        await card(page, "history:linked").locator(".event-time").textContent(),
        /10:00–11:00/,
      );
    },
  );
  await scenario(
    "phone keeps three readable columns and imported long-press never starts a move",
    phone,
    async ({ page, f, open }) => {
      await open();
      await noOverflow(page);
      const sizes = await page
        .locator("#calendar-scroll")
        .evaluate((scroll) => ({
          width: scroll.clientWidth,
          column: scroll
            .querySelector(".calendar-column")
            .getBoundingClientRect().width,
          axis: scroll.querySelector(".time-axis").getBoundingClientRect()
            .width,
        }));
      assert.ok(
        Math.abs(sizes.width - sizes.axis - 3 * sizes.column) <= 3,
        "Three therapist columns fit on the phone",
      );
      const p = await point(card(page, "history:linked"));
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: p.x, y: p.y, id: 1, force: 0.5 }],
      });
      await new Promise((done) => setTimeout(done, 550));
      assert.equal(
        await page.locator("#calendar-reschedule-bar").isVisible(),
        false,
      );
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
      await frames(page);
      if (!(await page.locator("#drawer").isVisible()))
        await card(page, "history:linked").tap();
      await page.locator(".is-imported-summary").waitFor();
      assert.equal(
        await page
          .locator("#appointment-summary-edit, #appointment-summary-reschedule")
          .count(),
        0,
      );
      await noOverflow(page);
      await capture(page, "phone-imported-calendar-details");
      assert.deepEqual(f.writes, []);
    },
  );
  await scenario(
    "therapist rendering cannot leak client identity even from an owner-shaped fixture",
    phone,
    async ({ page, f, open }) => {
      f.role = "therapist";
      f.history = [
        historical("linked", "tA", {
          note: "PRIVATE APPOINTMENT NOTE",
          phone: "+381600000099",
          netCents: 123456789,
          grossCents: 123456789,
          requestState: "yes",
        }),
      ];
      await open();
      assert.doesNotMatch(
        await page.locator("#calendar-body").innerText(),
        /PRIVATE|381600000099|123456789/,
      );
      await card(page, "history:linked").tap();
      await page.locator(".is-imported-summary").waitFor();
      const content = await page.locator("#drawer-content").innerText();
      assert.doesNotMatch(
        content,
        /PRIVATE|381600000099|123456789|RSD|Walk-in/,
      );
      assert.match(content, /Original source massage/);
      assert.match(content, /request/i);
      assert.equal(
        await page
          .locator(
            "#appointment-summary-client, #appointment-summary-edit, #appointment-summary-reschedule",
          )
          .count(),
        0,
      );
      assert.deepEqual(f.writes, []);
    },
  );
  await scenario(
    "room view explains missing room links and historical-only columns cannot create bookings",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [native()];
      await open();
      const sourceColumn = page.locator(`[data-resource="${sourceTherapist}"]`);
      assert.equal(
        await sourceColumn.getAttribute("data-history-only"),
        "true",
      );
      await sourceColumn.evaluate((el) => {
        el.closest(".calendar-scroll").scrollLeft = el.offsetLeft - 60;
        el.closest(".calendar-scroll").scrollTop = 540 * 2;
      });
      await sourceColumn.click({ position: { x: 90, y: 600 * 2 } });
      assert.equal(
        await page.locator("#calendar-slot-menu").isVisible(),
        false,
      );
      assert.equal(await page.locator("#appointment-form").count(), 0);
      await selectMode(page, "rooms");
      assert.equal(await page.locator('[data-imported="true"]').count(), 0);
      assert.equal(
        await page.locator('[data-appointment="native"]').count(),
        1,
      );
      await page
        .locator("#calendar-history-notice")
        .waitFor({ state: "visible" });
      await page.locator("#calendar-history-view-therapists").click();
      assert.equal(await page.locator('[data-imported="true"]').count(), 5);
      assert.deepEqual(f.writes, []);
    },
  );
  await scenario(
    "empty dates clear imported columns and late historical responses cannot replace current date",
    desktop,
    async ({ page, f, open }) => {
      await open();
      await setDate(page, nextDate);
      assert.equal(await page.locator('[data-imported="true"]').count(), 0);
      assert.equal(
        await page.locator(`[data-resource="${sourceTherapist}"]`).count(),
        0,
      );
      let release;
      f.delayed.set(date, {
        promise: new Promise((done) => {
          release = done;
        }),
        release: () => release(),
      });
      const request = page.waitForRequest(
        (req) =>
          new URL(req.url()).pathname === "/api/appointments" &&
          new URL(req.url()).searchParams.get("from") === date,
      );
      await page.locator("#calendar-date").fill(date);
      await page.locator("#calendar-date").dispatchEvent("change");
      await request;
      await setDate(page, nextDate);
      const response = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/appointments" &&
          new URL(res.url()).searchParams.get("from") === date,
      );
      release();
      await response;
      await frames(page);
      assert.equal(await page.locator("#calendar-date").inputValue(), nextDate);
      assert.equal(await page.locator('[data-imported="true"]').count(), 0);
      f.delayed.delete(date);
      f.omitHistory = true;
      await setDate(page, date);
      assert.equal(
        await page.locator('[data-imported="true"]').count(),
        0,
        "Native-only responses remain compatible",
      );
      assert.deepEqual(f.writes, []);
    },
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `Calendar history browser acceptance: ${passed} passed, ${failures.length} failed.`,
);
if (failures.length) process.exitCode = 1;
