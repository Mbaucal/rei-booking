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
// Measure the rendered 24-hour column. Density itself is asserted separately:
// one pixel per minute on the compact phone UI and two on desktop/tablet.
const displayStart = 0;
async function pixelsPerMinute(page) {
  return page.evaluate(
    () =>
      document
        .querySelector("#calendar-body .calendar-column")
        .getBoundingClientRect().height / 1440,
  );
}
function calendarDensityReady({
  fixtureDate,
  summaryDate,
  expectedScale,
  diagnostic = false,
}) {
  // Re-query and measure in one browser task: renderCalendar replaces columns.
  // A previously resolved element handle may describe the detached old grid.
  const column = document.querySelector("#calendar-body .calendar-column"),
    rect = column?.getBoundingClientRect(),
    snapshot = {
      date: document.querySelector("#calendar-date")?.value ?? null,
      summary: document.querySelector("#calendar-summary")?.textContent ?? null,
      connected: column?.isConnected ?? false,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      density: (rect?.height ?? 0) / 1440,
      expectedScale,
    };
  if (diagnostic) return snapshot;
  return snapshot.date === fixtureDate &&
    snapshot.summary?.includes(summaryDate) &&
    snapshot.connected &&
    snapshot.width > 0 &&
    snapshot.height > 0 &&
    Math.abs(snapshot.density - expectedScale) < 0.001
    ? snapshot
    : false;
}
const pixelAt = async (page, minute) =>
  (minute - displayStart) * (await pixelsPerMinute(page));
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
    authenticated: true,
    serviceWrites: [],
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
    blocks: [],
    blockWrites: [],
    blockWriteWait: null,
    photoWrites: [],
    clientPhotos: new Map(),
    writes: [],
    requests: [],
    delayed: new Map(),
    failDates: new Set(),
    failNextWrite: false,
    writeWait: null,
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
function calendarBlock(id, extra = {}) {
  return {
    id,
    date,
    start: 495,
    duration: 45,
    resourceType: "room",
    resourceId: "r1",
    bed: 1,
    title: "QA room preparation",
    note: "Fictional calendar note",
    blocksAvailability: true,
    version: 1,
    createdAt: "2026-10-01T07:00:00Z",
    updatedAt: "2026-10-01T07:00:00Z",
    ...extra,
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
      if (url.pathname === "/api/session" && !f.authenticated)
        return json({ error: "Fictional signed-out session" }, 401);
      if (url.pathname === "/api/login") f.authenticated = true;
      if (["/api/session", "/api/login"].includes(url.pathname))
        return json({
          user: { id: "qa-owner", role: f.role, name: "Fictional QA Owner" },
          csrf: "fixture-csrf",
          mustChangePassword: false,
        });
      if (url.pathname === "/api/catalogue") return json(f.catalogue);
      if (
        /^\/api\/services(?:\/[^/]+)?$/.test(url.pathname) &&
        ["POST", "PUT"].includes(req.method)
      ) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
        f.serviceWrites.push({ method: req.method, body, path: url.pathname });
        const index = f.catalogue.services.findIndex(
          (s) => s.id === url.pathname.split("/").at(-1),
        );
        if (req.method === "PUT" && index < 0)
          return json({ error: "Fixture treatment not found" }, 404);
        const saved = {
          ...body,
          id: index < 0 ? "qa-created-service" : f.catalogue.services[index].id,
          version: (f.catalogue.services[index]?.version || 0) + 1,
        };
        if (index < 0) f.catalogue.services.push(saved);
        else f.catalogue.services[index] = saved;
        return json({ id: saved.id }, req.method === "POST" ? 201 : 200);
      }
      if (url.pathname === "/api/clients") {
        const response = f.clientResponses.shift();
        if (response?.wait) await response.wait.promise;
        if (response?.fail)
          return json({ error: "Fictional client-list outage" }, 503);
        return json({ clients: response?.clients || f.clients });
      }
      if (url.pathname === "/api/clients/matches") return json({ matches: [] });
      if (
        /^\/api\/clients\/[^/]+\/history$/.test(url.pathname) &&
        req.method === "GET"
      )
        return json({
          clientId: url.pathname.split("/").at(-2),
          page: 0,
          pageSize: 25,
          total: 0,
          totalPages: 0,
          statusCounts: [],
          rows: [],
        });
      if (
        /^\/api\/clients\/[^/]+$/.test(url.pathname) &&
        req.method === "GET"
      ) {
        const client = f.clients.find(
          (c) => c.id === url.pathname.split("/").at(-1),
        );
        if (!client) return json({ error: "Fixture client not found" }, 404);
        return json({
          client,
          appointments: f.appointments.filter((a) => a.clientId === client.id),
        });
      }
      if (
        url.pathname.startsWith("/api/photos/clients/") &&
        req.method === "PUT"
      ) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
        f.photoWrites.push(body);
        const id = url.pathname.split("/").at(-1);
        f.clientPhotos.set(id, body.data);
        const client = f.clients.find((c) => c.id === id);
        client.hasPhoto = !!body.data;
        client.photoVersion = (client.photoVersion || 0) + 1;
        return json({ ok: true });
      }

      if (
        url.pathname.startsWith("/api/photos/clients/") &&
        req.method === "GET"
      ) {
        const data = f.clientPhotos.get(url.pathname.split("/").at(-1));
        if (!data) return json({ error: "Fixture photo not found" }, 404);
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        return res.end(Buffer.from(data, "base64"));
      }
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
        return json({
          appointments: result,
          blocks: f.blocks.filter(
            (b) => (!from || b.date >= from) && (!to || b.date <= to),
          ),
        });
      }
      if (
        url.pathname.startsWith("/api/calendar-blocks") &&
        ["POST", "PUT", "DELETE"].includes(req.method)
      ) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
        f.blockWrites.push({ body, method: req.method, path: url.pathname });
        if (f.role === "therapist")
          return json(
            { error: "Calendar entries are read-only for therapists." },
            403,
          );
        if (f.blockWriteWait) await f.blockWriteWait.promise;
        const id = url.pathname.split("/").at(-1);
        const index = f.blocks.findIndex((b) => b.id === id);
        if (req.method !== "POST" && index < 0)
          return json({ error: "Fixture block not found" }, 404);
        if (req.method !== "POST" && body.version !== f.blocks[index].version)
          return json({ error: "Fixture block version changed" }, 409);
        if (req.method === "DELETE") {
          f.blocks.splice(index, 1);
          return json({ ok: true });
        }
        const resource = (
          body.resourceType === "room"
            ? f.catalogue.rooms
            : f.catalogue.therapists
        ).find((entry) => entry.id === body.resourceId);
        if (
          !resource ||
          !Number.isInteger(body.start) ||
          !Number.isInteger(body.duration) ||
          body.start < 0 ||
          body.duration < 5 ||
          body.start % 5 ||
          body.duration % 5 ||
          body.start + body.duration > 1440 ||
          (body.resourceType === "therapist" && body.bed !== null) ||
          (body.resourceType === "room" &&
            body.bed !== null &&
            (!Number.isInteger(body.bed) ||
              body.bed < 0 ||
              body.bed >= resource.capacity))
        )
          return json(
            {
              error:
                "Use a valid resource and 5-minute steps within a single day.",
            },
            400,
          );
        const overlaps = (entry) =>
          entry.date === body.date &&
          entry.start < body.start + body.duration &&
          entry.start + entry.duration > body.start;
        const occupied = f.appointments.some(
          (entry) =>
            !["cancelled", "no_show"].includes(entry.status) &&
            overlaps(entry) &&
            (body.resourceType === "therapist"
              ? entry.therapistId === body.resourceId
              : entry.roomId === body.resourceId &&
                (body.bed === null || body.bed === entry.bed)),
        );
        const blocked = f.blocks.some(
          (entry) =>
            entry.id !== id &&
            entry.blocksAvailability &&
            overlaps(entry) &&
            entry.resourceType === body.resourceType &&
            entry.resourceId === body.resourceId &&
            (body.resourceType === "therapist" ||
              body.bed === null ||
              entry.bed === null ||
              entry.bed === body.bed),
        );
        if (body.blocksAvailability && (occupied || blocked))
          return json(
            {
              error:
                "This time overlaps a booking or blocked time. Choose another time or resource.",
            },
            409,
          );
        const previous = f.blocks[index];
        const saved = {
          ...body,
          id: previous?.id || "block-" + f.blockWrites.length,
          version: (previous?.version || 0) + 1,
          createdAt: previous?.createdAt || "2026-10-01T08:00:00Z",
          updatedAt: "2026-10-01T08:01:00Z",
        };
        if (index >= 0) f.blocks[index] = saved;
        else f.blocks.push(saved);
        return json({ block: saved }, req.method === "POST" ? 201 : 200);
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
        if (f.writeWait) await f.writeWait.promise;
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
        const existingIndex =
          req.method === "PUT"
            ? f.appointments.findIndex(
                (a) => a.id === url.pathname.split("/").at(-1),
              )
            : -1;
        const previous = f.appointments[existingIndex];
        const saved = {
          ...booking(
            "new-" + f.writes.length,
            body.therapistId,
            body.roomId,
            body.bed,
          ),
          ...previous,
          ...body,
          version: (previous?.version || 0) + 1,
        };
        if (body.newClient) {
          const client = {
            ...body.newClient,
            id: "inline-client-" + f.writes.length,
          };
          f.clients.push(client);
          saved.clientId = client.id;
          saved.clientName = client.name;
        }
        if (existingIndex >= 0) f.appointments[existingIndex] = saved;
        else f.appointments.push(saved);
        return json({ appointment: saved }, req.method === "POST" ? 201 : 200);
      }
      return json({ error: "Unimplemented fixture API: " + url.pathname }, 404);
    }
    if (url.pathname === "/qa-unconstrained-zoom") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:200vh;touch-action:auto}main{height:100vh;background:linear-gradient(#fff,#ccc)}</style><main>Fictional unconstrained zoom control</main>',
      );
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
const failures = [];

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
    const compact = await page.evaluate(
      () =>
        matchMedia("(max-width:700px), (max-height:560px) and (pointer:coarse)")
          .matches,
    );
    if (f.role === "owner" && !compact) {
      await page.locator("#report-metrics .report-metric").first().waitFor();
      await navigate(page, "calendar");
    } else await page.locator("#calendar-grid").waitFor();
    await page.locator("#calendar-date").fill(date);
    await page.locator("#calendar-date").dispatchEvent("change");
    const geometryArgs = {
      fixtureDate: date,
      summaryDate: "1 Oct 2026",
      expectedScale: compact ? 1 : 2,
    };
    let geometry;
    try {
      const ready = await page.waitForFunction(
        calendarDensityReady,
        geometryArgs,
        { polling: "raf", timeout: 10000 },
      );
      geometry = await ready.jsonValue();
      await ready.dispose();
    } catch (error) {
      const actual = await page.evaluate(calendarDensityReady, {
        ...geometryArgs,
        diagnostic: true,
      });
      throw new Error(
        `Calendar did not reach the expected date and density: ${JSON.stringify(
          {
            fixtureDate: date,
            ...actual,
            pageErrors: errors,
          },
        )}`,
        { cause: error },
      );
    }
    assert.ok(
      Math.abs(geometry.density - (compact ? 1 : 2)) < 0.001,
      "Rendered calendar density matches compact 60px/hour or desktop 120px/hour",
    );
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
    failures.push({ name, device: device.name, message: error.message });
    console.error(`FAIL ${device.name}: ${name}\n${error.stack || error}`);
  } finally {
    for (const delay of f.delayed.values()) delay.release();
    f.writeWait?.release();
    f.blockWriteWait?.release();
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
async function editableFonts(page, scope, label) {
  const controls = await page
    .locator(scope)
    .locator("input,select,textarea")
    .evaluateAll((nodes) =>
      nodes
        .filter(
          (el) =>
            !["checkbox", "radio", "color", "file", "hidden"].includes(
              el.type,
            ) && el.getClientRects().length,
        )
        .map((el) => ({
          name: el.name || el.id,
          font: parseFloat(getComputedStyle(el).fontSize),
        })),
    );
  assert.ok(controls.length > 0, label + " has editable controls");
  assert.deepEqual(
    controls.filter((el) => el.font < 16),
    [],
    label + " uses at least 16px for every rendered editable field",
  );
}
async function noPageOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    width: innerWidth,
    drawer: document.querySelector("#drawer[open]")?.scrollWidth,
    drawerWidth: document.querySelector("#drawer[open]")?.clientWidth,
  }));
  assert.ok(
    sizes.page <= sizes.width + 1,
    label + " has no outer horizontal overflow: " + JSON.stringify(sizes),
  );
  if (sizes.drawer != null)
    assert.ok(
      sizes.drawer <= sizes.drawerWidth + 1,
      label + " has no horizontal drawer overflow: " + JSON.stringify(sizes),
    );
}
async function pinch(page, point) {
  await page.bringToFront();
  await renderedFrames(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    // A genuine two-contact gesture, not a forced page-scale override. This
    // advertises two available contacts; the application's touch-action still
    // decides whether the browser may pan or pinch.
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 2,
    });
    const contacts = (spread) => [
      {
        id: 1,
        x: point.x - spread,
        y: point.y,
        radiusX: 3,
        radiusY: 3,
        force: 0.5,
      },
      {
        id: 2,
        x: point.x + spread,
        y: point.y,
        radiusX: 3,
        radiusY: 3,
        force: 0.5,
      },
    ];
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: contacts(25),
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: contacts(25 + step * 6),
      });
      await renderedFrames(page);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await renderedFrames(page);
  } finally {
    await cdp.detach();
  }
  const scale = await page.evaluate(() => visualViewport.scale);
  console.log(`Touch pinch ${new URL(page.url()).pathname}: scale=${scale}`);
  return scale;
}
async function calendarScaleStable(page) {
  assert.ok(
    Math.abs((await page.evaluate(() => visualViewport.scale)) - 1) < 0.02,
    "Application starts at natural scale",
  );
  const box = await page.locator("#calendar-scroll").boundingBox();
  const center = {
    x: box.x + box.width / 2,
    y: Math.min(box.y + box.height / 2, page.viewportSize().height - 100),
  };
  const scale = await pinch(page, center);
  assert.ok(
    Math.abs(scale - 1) < 0.02,
    "Pinching the calendar preserves viewport scale: " + scale,
  );
}
async function bookingLayout(page, role = "owner") {
  const headings = await page
    .locator("#appointment-form .booking-section-heading")
    .allTextContents();
  assert.deepEqual(
    headings.map((text) => text.trim()),
    [
      "Client",
      "Treatment & time",
      "Therapist & room",
      ...(role === "owner" ? ["Pricing"] : []),
      "Requests & notes",
    ],
  );
  await withinViewport(
    page,
    page.locator("#drawer-footer"),
    "Appointment save footer",
  );
  await withinViewport(
    page,
    page.locator("#form-save"),
    "Appointment save action",
  );
  await withinViewport(
    page,
    page.locator("#form-cancel"),
    "Appointment cancel action",
  );
  const overflow = await page
    .locator("#drawer")
    .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(
    overflow.scroll <= overflow.width + 1,
    "Booking drawer has no horizontal overflow",
  );
}
async function liveSummary(page, { time, duration, treatment, resources }) {
  const summary = page.locator("#booking-summary");
  await summary.waitFor();
  assert.match(
    await summary.locator(".booking-summary-time").textContent(),
    time,
  );
  assert.match(
    await summary.locator(".booking-summary-duration").textContent(),
    duration,
  );
  assert.match(
    await summary.locator(".booking-summary-treatment").textContent(),
    treatment,
  );
  for (const resource of resources)
    assert.match(
      await summary.locator(".booking-summary-resources").textContent(),
      resource,
    );
  assert.doesNotMatch(
    await summary.textContent(),
    /Fictional QA Client|4700|5900|RSD|Private QA/,
  );
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
  await selectMode(page, "rooms");
  const column = page.locator(`[data-resource="${id}"]`);
  await column.evaluate(
    (el, top) => {
      const scroller = el.closest(".calendar-scroll");
      scroller.scrollTop = top;
      scroller.scrollLeft = el.offsetLeft - 60;
    },
    await pixelAt(page, 540),
  );
  await renderedFrames(page);
  const box = await column.boundingBox();
  const point = {
    x: box.x + box.width * (id === "r1" ? (lane === 1 ? 0.75 : 0.25) : 0.5),
    y: Math.ceil(box.y + (await pixelAt(page, 585))),
  };
  if (device.mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await menuAt(page, point);
  await capture(page, `${device.name}-calendar-popup`);
  await page.locator("#calendar-slot-add").click();
  await page.locator("#appointment-form").waitFor();
  await formAtTop(page);
  if (device.name === "desktop") await capture(page, "desktop-opened-booking");
}
const blockControl = (page, name) =>
  page.locator(`#calendar-block-form [name="${name}"]`);
async function roomPoint(page, device, minute, roomId = "r1", lane = 1) {
  await selectMode(page, "rooms");
  const column = page.locator(`[data-resource="${roomId}"]`);
  await column.evaluate(
    (el, top) => {
      const scroller = el.closest(".calendar-scroll");
      scroller.scrollTop = top;
      scroller.scrollLeft = el.offsetLeft - 60;
    },
    await pixelAt(page, Math.max(0, minute - 60)),
  );
  await renderedFrames(page);
  const box = await column.boundingBox();
  const point = {
    x: box.x + box.width * (roomId === "r1" ? (lane ? 0.75 : 0.25) : 0.5),
    // Click MouseEvents round CSS coordinates; choose the first integer
    // pixel inside this minute, keeping the last-minute boundary probes intact.
    y: Math.ceil(box.y + (await pixelAt(page, minute))),
  };
  if (device.mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await menuAt(page, point);
}
async function mobileNavigation(page) {
  return page.locator("#mobile-navigation").isVisible();
}
async function navigate(page, destination) {
  if (!(await mobileNavigation(page))) {
    await page.locator(`nav [data-page="${destination}"]`).click();
    return;
  }
  const direct = page.locator(
    `#mobile-navigation [data-mobile-page="${destination}"]`,
  );
  if (await direct.isVisible()) await direct.click();
  else {
    await page.locator("#mobile-more").click();
    await page.locator(`#drawer [data-mobile-page="${destination}"]`).click();
  }
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
async function openAdd(page, kind) {
  const desktop = page.locator(
    kind === "block" ? "#calendar-block-add" : "#appointment-add",
  );
  if (await desktop.isVisible()) await desktop.click();
  else {
    await page.locator("#mobile-add").click();
    await page
      .locator(
        kind === "block" ? "#mobile-add-block" : "#mobile-add-appointment",
      )
      .click();
  }
}
async function refreshCalendar(page) {
  if (await page.locator("#calendar-refresh").isVisible())
    await page.locator("#calendar-refresh").click();
  else {
    await page.locator("#calendar-view-options").click();
    await page.locator("#mobile-calendar-refresh").click();
    await page.locator("#drawer").waitFor({ state: "hidden" });
  }
}
async function add(page) {
  await openAdd(page, "appointment");
  await page.locator("#appointment-form").waitFor();
}
function deferred() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}
function denseSchedule(f) {
  f.catalogue.rooms = [
    { id: "r1", name: "QA Garden Room", capacity: 2 },
    { id: "r2", name: "QA Orchid Room", capacity: 2 },
    { id: "r3", name: "QA Quiet Room", capacity: 1 },
  ];
  for (const letter of ["D", "E", "F"])
    f.catalogue.therapists.push({
      ...structuredClone(f.catalogue.therapists[0]),
      id: "t" + letter,
      name: "QA Therapist " + letter,
    });
  f.appointments = [];
  for (const [therapistId, roomId, bed] of [
    ["tB", "r1", 1],
    ["tC", "r2", 0],
    ["tD", "r2", 1],
    ["tE", "r3", 0],
  ]) {
    for (let start = 1020; start < 1260; start += 60) {
      const a = booking(
        `dense-${therapistId}-${start}`,
        therapistId,
        roomId,
        bed,
        start,
      );
      Object.assign(a, {
        clientName: `Fictional Guest ${therapistId.slice(1)} ${start}`,
        serviceName:
          start % 120
            ? "Relaxing Aroma Oil Massage"
            : "Traditional Thai Massage",
        color: start % 120 ? "#ad7185" : "#6f9472",
        requestedTherapistId: start === 1140 ? therapistId : null,
      });
      f.appointments.push(a);
    }
  }
  f.appointments.push(booking("dense-before", "tA", "r1", 0, 1035));
  const target = {
    ...booking("dense-target", "tA", "r1", 0, 1140, 90),
    serviceName: "QA Signature Thai and Aroma Massage",
    clientName: "Fictional Long-Name Calendar Guest",
    requestedTherapistId: "tA",
    note: "PRIVATE QA appointment note",
    grossCents: 680000,
    netCents: 590000,
    color: "#8c70a5",
  };
  f.appointments.push(target, booking("dense-after", "tA", "r1", 0, 1230));
  return target;
}
async function denseView(page) {
  await selectMode(page, "rooms");
  await page.locator("#calendar-scroll").evaluate(
    (el, top) => {
      el.scrollTop = top;
      el.scrollLeft = 0;
    },
    await pixelAt(page, 1080),
  );
  await page.locator('[data-appointment="dense-target"]').waitFor();
}
async function bodyPoint(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "Appointment is rendered");
  return { x: box.x + Math.min(40, box.width / 2), y: box.y + 24 };
}
async function touchStart(page, point) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, at = point) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" ? [] : [{ x: at.x, y: at.y, id: 1, force: 0.5 }],
    });
  await send("touchStart");
  return {
    move: (at) => send("touchMove", at),
    end: async () => {
      await send("touchEnd");
      await cdp.detach();
    },
  };
}
async function longPress(page, locator) {
  const touch = await touchStart(page, await bodyPoint(locator));
  await new Promise((done) => setTimeout(done, 520));
  await touch.end();
  await page.locator("#calendar-reschedule-bar").waitFor();
}
async function shiftKeyboardDraft(page, key) {
  await page.locator("#calendar-reschedule-save").focus();
  await page.keyboard.press(key);
}
async function compactMoveBar(page) {
  const bar = page.locator("#calendar-reschedule-bar");
  assert.deepEqual(await bar.locator("button:visible").allTextContents(), [
    "Cancel",
    "Save",
  ]);
  assert.ok(
    (await bar.boundingBox()).height <= 80,
    "Move footer stays compact",
  );
}
async function shiftTouchDraft(page) {
  const preview = page.locator(
    '.calendar-reschedule-preview[data-appointment="dense-target"]',
  );
  const point = await bodyPoint(preview);
  const touch = await touchStart(page, point);
  await touch.move({
    x: point.x,
    y: point.y - 5 * (await pixelsPerMinute(page)) - 0.25,
  });
  await touch.end();
  await page
    .locator("#calendar-reschedule-time")
    .filter({ hasText: "18:55–20:25 · 90 min" })
    .waitFor();
}
async function renderedFrames(page) {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

async function blockMoveView(page, mode = "rooms", minute = 600) {
  await selectMode(page, mode);
  await page.locator("#calendar-scroll").evaluate(
    (el, top) => {
      el.scrollTop = top;
      el.scrollLeft = 0;
    },
    await pixelAt(page, Math.max(0, minute - 60)),
  );
  await renderedFrames(page);
}
async function moveBlockPointer(
  page,
  id,
  resourceType,
  resourceId,
  start,
  touch = false,
) {
  const preview = page.locator(
      `.calendar-reschedule-preview[data-calendar-block="${id}"]`,
    ),
    card = (await preview.count())
      ? preview
      : page.locator(`[data-calendar-block="${id}"]`),
    source = await bodyPoint(card),
    sourceBox = await card.boundingBox(),
    target = await page
      .locator(`[data-kind="${resourceType}"][data-resource="${resourceId}"]`)
      .boundingBox();
  assert.ok(target, "Move target column is rendered");
  const point = {
    x: target.x + target.width / 2,
    y: target.y + (await pixelAt(page, start)) + source.y - sourceBox.y,
  };
  if (touch) {
    const gesture = await touchStart(page, source);
    await gesture.move(point);
    await gesture.end();
  } else {
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.up();
  }
}

function assertBlockSnapshot(saved, original, target) {
  for (const key of [
    "date",
    "duration",
    "title",
    "note",
    "blocksAvailability",
    "createdAt",
  ])
    assert.equal(
      saved[key],
      original[key],
      `${key} survives the calendar move`,
    );
  for (const [key, value] of Object.entries(target))
    assert.equal(saved[key], value, key);
}

try {
  for (const device of [desktop, phone, tablet]) {
    await scenario(
      "room quick action automatically chooses a free table, rechecks treatment and saves intact",
      device,
      async ({ page, f, open }) => {
        f.appointments = [
          booking("busy-a", "tA", "r1", 0),
          booking("later-b", "tB", "r2", 0, 660),
        ];
        await open();
        await roomSlot(page, device);
        assert.equal((await selected(page)).start, "09:45");
        await control(page, "start").fill("10:00");
        await control(page, "start").press("Tab");
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
          "Changing treatment must keep a table free for the whole duration",
        );
        assert.equal(values.grossCents, "5900.00");
        await bookingLayout(page);
        await liveSummary(page, {
          time: /10:00.*11:30/,
          duration: /90/,
          treatment: /QA Longer Massage/,
          resources: [/QA Therapist C/, /QA Couple/, /Table 2/],
        });
        await page.locator("#drawer-content").evaluate((el) => {
          el.scrollTop = 0;
        });
        await capture(page, `${device.name}-booking-sections-live-summary`);
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
  for (const device of [desktop, phone, tablet])
    await scenario(
      "full-day labels stay visible and populated workday slots select quarter hours",
      device,
      async ({ page, f, open }) => {
        f.appointments = [booking("first-hour", "tA", "r2", 0, 600, 90)];
        await open();
        await selectMode(page, "rooms");
        const column = page.locator('[data-resource="r1"]');
        assert.ok(
          Math.abs(
            (await page
              .locator("#calendar-scroll")
              .evaluate((el) => el.scrollTop)) - (await pixelAt(page, 540)),
          ) <= 2,
          "A new full-day calendar initially opens near 09:00",
        );
        await column.evaluate((el) => {
          el.closest(".calendar-scroll").scrollTop = 0;
          el.closest(".calendar-scroll").scrollLeft = 0;
        });
        await page.locator("#calendar-scroll").scrollIntoViewIfNeeded();
        await renderedFrames(page);
        const firstLabel = page.locator(".time-axis span").first();
        assert.equal(await firstLabel.textContent(), "00:00");
        const label = await withinViewport(
          page,
          firstLabel,
          "Complete first 00:00 label",
        );
        const header = await page.locator("#calendar-headers").boundingBox();
        assert.ok(
          label.y >= header.y + header.height - 1,
          "The first label must sit completely below the sticky resource header",
        );
        assert.equal(
          await firstLabel.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return (
              document.elementFromPoint(
                box.left + box.width / 2,
                box.top + 2,
              ) === el
            );
          }),
          true,
          "The top of 00:00 is not covered by the sticky header",
        );
        await page.locator("#calendar-scroll").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await renderedFrames(page);
        const lastLabel = page.locator(".time-axis span").last();
        assert.equal(await lastLabel.textContent(), "24:00");
        await withinViewport(page, lastLabel, "Complete last 24:00 label");
        await page.locator("#calendar-scroll").evaluate(
          (el, top) => {
            el.scrollTop = top;
          },
          await pixelAt(page, 540),
        );
        await renderedFrames(page);
        await withinViewport(
          page,
          page.locator(".time-axis span").filter({ hasText: /^10:00$/ }),
          "Complete 10:00 workday label",
        );
        const appointment = page.locator('[data-appointment="first-hour"]');
        assert.match(
          await appointment.locator(".event-time").textContent(),
          /10:00–11:30/,
        );
        assert.ok(
          Math.abs(
            (await appointment.boundingBox()).y -
              (await column.boundingBox()).y -
              (await pixelAt(page, 600)),
          ) <= 1,
          "Label repair must not shift the 10:00 appointment off its time origin",
        );
        await capture(page, `${device.name}-populated-first-hour`);
        for (const [minute, quarter] of [
          [601, 600],
          [614, 600],
          [615, 615],
          [629, 615],
          [630, 630],
          [640, 630],
          [644, 630],
          [645, 645],
        ]) {
          const box = await column.boundingBox();
          const point = {
            x: box.x + box.width * 0.75,
            // Click MouseEvents round CSS coordinates; choose the first integer
            // pixel inside this minute, keeping the last-minute boundary probes intact.
            y: Math.ceil(box.y + (await pixelAt(page, minute))),
          };
          const expected = `10:${String(quarter - 600).padStart(2, "0")}`;
          if (!device.mobile) {
            await page.mouse.move(point.x, point.y);
            const hint = column.locator(".calendar-slot-hint");
            await hint.waitFor();
            assert.equal(
              await hint.getAttribute("data-start"),
              String(quarter),
            );
            assert.equal(
              await hint.getAttribute("data-band-start"),
              String(quarter),
            );
            assert.equal(
              await hint.locator(".calendar-slot-time").textContent(),
              expected,
            );
            const rect = await hint.boundingBox();
            assert.ok(
              Math.abs(rect.height - 15 * (await pixelsPerMinute(page))) <= 3,
              "The selected quarter spans 15 minutes",
            );
            assert.ok(
              Math.abs(rect.x - box.x) <= 3 &&
                Math.abs(rect.width - box.width) <= 3,
              "Hover spans the unified room without permanent table halves",
            );
            if (minute === 640)
              await capture(page, "desktop-1040-selects1030-hover");
            await page.mouse.click(point.x, point.y);
          } else await page.touchscreen.tap(point.x, point.y);
          await menuAt(page, point);
          assert.equal(
            await page.locator("#calendar-slot-menu-time").textContent(),
            expected,
          );
          assert.match(
            await page.locator("#calendar-slot-menu-resource").textContent(),
            /^QA Couple$/,
          );
          if (minute === 640) {
            await page.locator("#calendar-slot-add").click();
            await page.locator("#appointment-form").waitFor();
            await stateIs(page, "available");
            const values = await selected(page);
            assert.equal(
              values.start,
              "10:30",
              "Pointer at 10:40 prefills a 10:30 booking",
            );
            assert.equal(values.bed, "0");
            assert.equal(values.roomId, "r1");
            await page.locator("#form-cancel").click();
          } else await page.locator("#calendar-slot-close").click();
        }
        assert.equal(f.writes.length, 0);
        if (device.mobile) return;
        await column.focus();
        await page.keyboard.press("Home");
        for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await page.locator("#calendar-slot-menu").waitFor();
        assert.match(
          await page.locator("#calendar-slot-menu-time").textContent(),
          /00:45/,
        );
        assert.match(
          await page.locator("#calendar-slot-menu-resource").textContent(),
          /^QA Couple$/,
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
        await selectMode(page, "rooms");
        const scroller = page.locator("#calendar-scroll");
        await scroller.evaluate(
          (el, top) => {
            el.scrollTop = top;
            el.scrollLeft = el.scrollWidth - el.clientWidth;
          },
          await pixelAt(page, 810),
        );
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
        const floating = page.locator("#calendar-today-floating");
        if (await floating.isVisible()) {
          const overlay = await floating.boundingBox();
          if (
            point.x >= overlay.x &&
            point.x <= overlay.x + overlay.width &&
            point.y >= overlay.y &&
            point.y <= overlay.y + overlay.height
          )
            point.x = overlay.x - 10;
        }
        assert.equal(
          await page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest("[data-resource]")
                ?.dataset.resource,
            point,
          ),
          "r2",
          "Edge tap must hit the empty resource, not floating Today",
        );
        const displayScale = await pixelsPerMinute(page);
        const expectedStart =
          Math.floor(((point.y - box.y) / displayScale + displayStart) / 15) *
          15;
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
      await openAdd(page, "appointment");
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
      await openAdd(page, "appointment");
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
      await openAdd(page, "appointment");
      const abandonedRequest = await abandonedStarted;
      await page.locator("#booking-opening").waitFor();
      await page.locator("#form-cancel").click();
      await navigate(page, "clients");
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
      await selectMode(page, "rooms");
      const event = page.locator('[data-appointment="existing"]');
      await event.click();
      await page.locator("#appointment-summary-edit").waitFor();
      await page.locator("#appointment-summary-edit").click();
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
      await control(page, "serviceId").selectOption("s90");
      assert.equal((await selected(page)).duration, "90");
      await page.locator("#form-save").click();
      await page.locator("#drawer").waitFor({ state: "hidden" });
      assert.equal(f.writes.at(-1).body.duration, 90);
      const grip = await bodyPoint(event);
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x, grip.y + 20, { steps: 5 });
      const moved = page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          r.url().endsWith("/api/appointments/existing"),
      );
      await page.mouse.up();
      await moved;
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
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
      await selectMode(page, "rooms");
      const column = page.locator('[data-resource="r1"]'),
        box = await column.boundingBox();
      await page.mouse.move(
        box.x + box.width * 0.75,
        box.y + (await pixelAt(page, 585)) + 20,
      );
      await page.mouse.click(
        box.x + box.width * 0.75,
        box.y + (await pixelAt(page, 585)) + 20,
      );
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
  for (const device of [desktop, tablet, phone]) {
    await scenario(
      "dense five-table schedule and readable appointment summary",
      device,
      async ({ page, f, open }) => {
        const target = denseSchedule(f);
        await open();
        await denseView(page);
        assert.equal(await page.locator(".calendar-column").count(), 3);
        assert.equal(await page.locator(".calendar-column.couple").count(), 0);
        assert.equal(
          await page.locator("[data-appointment]").count(),
          f.appointments.length,
        );
        const quarterHeight = await page
          .locator("#calendar-grid")
          .evaluate((el) =>
            getComputedStyle(el)
              .getPropertyValue("--calendar-quarter-height")
              .trim(),
          );
        assert.equal(
          quarterHeight,
          `${15 * (await pixelsPerMinute(page))}px`,
          "Four 15-minute grid divisions fit one rendered hour",
        );
        const event = page.locator('[data-appointment="dense-target"]');
        const original = await event.boundingBox();
        assert.ok(
          Math.abs(
            original.height - (90 * (await pixelsPerMinute(page)) - 3),
          ) <= 1,
          "90-minute card retains its duration scale",
        );
        await capture(page, `${device.name}-dense-five-table-calendar`);
        if (!device.mobile) {
          await event.hover();
          const card = page.locator("#appointment-hover");
          await card.waitFor();
          const cardBox = await withinViewport(
            page,
            card,
            "Appointment hover card",
          );
          const after = await event.boundingBox();
          assert.deepEqual(
            after,
            original,
            "Subtle hover does not expand the appointment geometry",
          );
          assert.ok(
            Math.max(
              cardBox.x - original.x - original.width,
              original.x - cardBox.x - cardBox.width,
              0,
            ) <= 20,
            "Hover information stays beside the appointment",
          );
          assert.match(
            await card.textContent(),
            /Fictional Long-Name Calendar Guest/,
          );
          assert.match(await card.textContent(), /90 minutes/);
          assert.match(await card.textContent(), /QA Therapist A requested/);
          assert.equal(
            await card.locator(".appointment-treatment-price").count(),
            1,
          );
          await page.mouse.move(cardBox.x + 25, cardBox.y + 25);
          await page.waitForTimeout(220); // Cross the real 180 ms leave delay.
          assert.equal(
            await card.isVisible(),
            true,
            "Pointer can move into the information card",
          );
          await capture(page, "desktop-dense-appointment-hover");
          await event.focus();
          await page.keyboard.press("Escape");
          await card.waitFor({ state: "hidden" });
          await page.locator("#calendar-refresh").focus();
          await event.focus();
          await card.waitFor();
          await page.keyboard.press("Escape");
          await card.waitFor({ state: "hidden" });
        }
        if (device.mobile) await event.tap();
        else await event.click();
        await page.locator("#appointment-summary-edit").waitFor();
        await withinViewport(
          page,
          page.locator("#drawer"),
          "Appointment summary dialog",
        );
        const summary = page.locator("#drawer .appointment-summary");
        assert.match(
          await summary.textContent(),
          /QA Signature Thai and Aroma Massage/,
        );
        assert.match(
          await summary.textContent(),
          /PRIVATE QA appointment note/,
        );
        assert.match(await summary.textContent(), /QA Garden Room · Table 1/);
        const labels = await summary.locator("h3").evaluateAll((nodes) =>
          nodes.map((el) => ({
            text: el.textContent,
            width: el.clientWidth,
            contentWidth: el.scrollWidth,
            whiteSpace: getComputedStyle(el).whiteSpace,
            overflow: getComputedStyle(el).textOverflow,
          })),
        );
        assert.ok(
          labels.every(
            (l) =>
              l.contentWidth <= l.width + 1 &&
              l.whiteSpace !== "nowrap" &&
              l.overflow !== "ellipsis",
          ),
          "Full client and treatment names wrap without ellipsis: " +
            JSON.stringify(labels),
        );
        assert.equal(
          await page.locator("#appointment-form").count(),
          0,
          "Summary is separate from the editor",
        );
        await capture(page, `${device.name}-dense-appointment-details`);
        await page.locator("#appointment-summary-edit").click();
        await page.locator("#appointment-form").waitFor();
        const values = await selected(page);
        assert.equal(values.duration, "90");
        assert.equal(values.note, target.note);
        assert.equal(values.requestedTherapistId, "tA");
        assert.equal(f.writes.length, 0);
      },
    );
  }
  for (const role of ["reception", "therapist"]) {
    await scenario(
      `${role} hover and summary enforce field privacy`,
      desktop,
      async ({ page, f, open }) => {
        denseSchedule(f);
        f.role = role;
        await open();
        await denseView(page);
        const event = page.locator('[data-appointment="dense-target"]');
        await event.hover();
        const hover = page.locator("#appointment-hover");
        await hover.waitFor();
        assert.equal(
          await hover.locator(".appointment-treatment-price").count(),
          0,
        );
        assert.doesNotMatch(
          await hover.textContent(),
          /5,900|6,800|PRIVATE QA/,
        );
        if (role === "therapist")
          assert.doesNotMatch(await hover.textContent(), /Fictional Long-Name/);
        else assert.match(await hover.textContent(), /Fictional Long-Name/);
        await event.click();
        const summary = page.locator("#drawer .appointment-summary");
        await summary.waitFor();
        assert.equal(
          await summary.locator(".appointment-treatment-price").count(),
          0,
        );
        assert.match(await summary.textContent(), /90 minutes/);
        assert.match(await summary.textContent(), /QA Therapist A requested/);
        if (role === "therapist") {
          assert.doesNotMatch(
            await summary.textContent(),
            /Fictional Long-Name|PRIVATE QA/,
          );
          assert.equal(
            await page
              .locator(
                "#appointment-summary-edit, #appointment-summary-reschedule, #appointment-summary-client",
              )
              .count(),
            0,
          );
        } else {
          assert.match(await summary.textContent(), /PRIVATE QA/);
          assert.equal(
            await page.locator("#appointment-summary-edit").count(),
            1,
          );
        }
        assert.equal(f.writes.length, 0);
      },
    );
  }
  await scenario(
    "whole-card mouse drag shows exact five-minute feedback and preserves 90 minutes",
    desktop,
    async ({ page, f, open }) => {
      const target = denseSchedule(f);
      await open();
      await denseView(page);
      const point = await bodyPoint(
        page.locator('[data-appointment="dense-target"]'),
      );
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x, point.y - 10, { steps: 3 });
      await page
        .locator("#calendar-reschedule-time")
        .filter({ hasText: "18:55–20:25 · 90 min" })
        .waitFor();
      assert.equal(
        f.writes.length,
        0,
        "Live feedback precedes saving the drop",
      );
      assert.match(
        await page
          .locator(".calendar-reschedule-preview .event-time")
          .textContent(),
        /18:55–20:25/,
      );
      await capture(page, "desktop-live-five-minute-move");
      const moved = page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          r.url().endsWith("/api/appointments/dense-target"),
      );
      await page.mouse.up();
      assert.equal((await moved).status(), 200);
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 1);
      const body = f.writes[0].body;
      assert.equal(body.start, 1135);
      assert.equal(body.duration, 90);
      for (const key of [
        "clientId",
        "requestedTherapistId",
        "grossCents",
        "netCents",
        "note",
        "roomId",
        "bed",
        "therapistId",
      ])
        assert.equal(
          body[key],
          target[key],
          `${key} survives a time-only move`,
        );
      assert.equal(await page.locator("#drawer").isVisible(), false);
      assert.equal(
        await page.locator("#calendar-slot-menu").isVisible(),
        false,
      );
    },
  );
  await scenario(
    "touch swipe scrolls; long press selects a cancellable draft with fixed feedback",
    phone,
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      const event = page.locator('[data-appointment="dense-target"]');
      const scrollBefore = await page
        .locator("#calendar-scroll")
        .evaluate((el) => {
          // The denser full-day phone grid can clamp 18:00 at the bottom.
          // Start with real upward pan travel instead of swiping at its limit.
          el.scrollTop = Math.min(
            el.scrollTop,
            el.scrollHeight - el.clientHeight - 150,
          );
          return {
            top: el.scrollTop,
            maximum: el.scrollHeight - el.clientHeight,
          };
        });
      assert.ok(
        scrollBefore.maximum - scrollBefore.top >= 140,
        "Swipe fixture has at least 140px of upward scrolling travel: " +
          JSON.stringify(scrollBefore),
      );
      await renderedFrames(page);
      await withinViewport(
        page,
        event,
        "Booking used for ordinary touch swipe",
      );
      const point = await bodyPoint(event);
      const swipe = await touchStart(page, point);
      await swipe.move({ x: point.x, y: point.y - 40 });
      await swipe.move({ x: point.x, y: point.y - 100 });
      await swipe.end();
      await renderedFrames(page);
      assert.equal(await page.locator("#calendar-reschedule-bar").count(), 0);
      assert.equal(f.writes.length, 0);
      assert.ok(
        (await page
          .locator("#calendar-scroll")
          .evaluate((el) => el.scrollTop)) >
          scrollBefore.top + 25,
        "Ordinary touch swipe scrolls the calendar by more than 25px",
      );
      await denseView(page);
      await longPress(page, event);
      assert.equal(
        await page
          .locator(".calendar-reschedule-preview")
          .first()
          .evaluate((el) => getComputedStyle(el).touchAction),
        "none",
        "Selected draft retains its controlled drag gesture",
      );
      await withinViewport(
        page,
        page.locator("#calendar-reschedule-bar"),
        "Reschedule footer",
      );
      assert.equal(
        await page.locator("#calendar-scroll.is-rescheduling").count(),
        1,
      );
      assert.ok(
        (await page
          .locator('[data-appointment="dense-tB-1140"]')
          .evaluate((el) => Number(getComputedStyle(el).opacity))) < 1,
        "Other bookings dim while a draft is selected",
      );
      assert.equal(
        await page.locator("#drawer").isVisible(),
        false,
        "Long press must not open summary",
      );
      await shiftTouchDraft(page);
      await compactMoveBar(page);
      await capture(page, "phone-selected-draft-footer");
      await page.locator("#calendar-reschedule-cancel").click();
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(
        await page
          .locator(".calendar-reschedule-preview, .is-reschedule-source")
          .count(),
        0,
      );
      assert.match(
        await event.locator(".event-time").textContent(),
        /19:00–20:30/,
      );
      assert.equal(
        f.writes.length,
        0,
        "Cancel never sends an appointment mutation",
      );
    },
  );
  await scenario(
    "touch draft save sends one PUT despite repeated activation",
    { ...tablet, viewport: { width: 768, height: 1024 } },
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      await longPress(page, page.locator('[data-appointment="dense-target"]'));
      await shiftTouchDraft(page);
      await withinViewport(
        page,
        page.locator("#calendar-reschedule-bar"),
        "Tablet reschedule footer",
      );
      await withinViewport(
        page,
        page.locator("#calendar-reschedule-save"),
        "Tablet Save action",
      );
      await compactMoveBar(page);
      await capture(page, "tablet-768-selected-draft-footer");
      const hold = deferred();
      f.writeWait = hold;
      const started = page.waitForRequest((r) => r.method() === "PUT");
      await page.locator("#calendar-reschedule-save").click();
      await started;
      assert.equal(
        await page.locator("#calendar-reschedule-save").isDisabled(),
        true,
      );
      await page.locator("#calendar-reschedule-save").dispatchEvent("click");
      assert.equal(
        f.writes.length,
        1,
        "Repeated activation cannot duplicate a pending save",
      );
      const saved = page.waitForResponse((r) => r.request().method() === "PUT");
      hold.release();
      assert.equal((await saved).status(), 200);
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 1);
      assert.equal(
        f.appointments.find((a) => a.id === "dense-target").start,
        1135,
      );
      assert.equal(f.writes[0].body.duration, 90);
    },
  );
  await scenario(
    "409 leaves a recoverable touch draft and retry preserves its move",
    phone,
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      await longPress(page, page.locator('[data-appointment="dense-target"]'));
      await shiftKeyboardDraft(page, "ArrowUp");
      f.failNextWrite = true;
      await page.locator("#calendar-reschedule-save").click();
      await page
        .locator("#calendar-reschedule-error")
        .filter({ hasText: "already booked" })
        .waitFor();
      assert.equal(
        await page.locator("#calendar-reschedule-save").isEnabled(),
        true,
      );
      assert.equal(
        await page.locator(".calendar-reschedule-preview").count(),
        1,
      );
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /18:55–20:25/,
      );
      assert.equal(
        f.appointments.find((a) => a.id === "dense-target").start,
        1140,
      );
      const saved = page.waitForResponse(
        (r) => r.request().method() === "PUT" && r.status() === 200,
      );
      await page.locator("#calendar-reschedule-save").click();
      await saved;
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(
        f.writes.length,
        2,
        "One rejected attempt and one successful retry",
      );
      assert.equal(
        f.appointments.find((a) => a.id === "dense-target").start,
        1135,
      );
    },
  );
  await scenario(
    "pending calendar refresh cannot discard selected draft; date change cancels without write",
    phone,
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      const hold = deferred();
      f.delayed.set(date, hold);
      const started = page.waitForRequest(
        (r) => new URL(r.url()).pathname === "/api/appointments",
      );
      await refreshCalendar(page);
      const request = await started;
      await longPress(page, page.locator('[data-appointment="dense-target"]'));
      await shiftKeyboardDraft(page, "ArrowUp");
      const finished = page.waitForResponse((r) => r.request() === request);
      hold.release();
      await finished;
      await renderedFrames(page);
      assert.equal(
        await page.locator("#calendar-reschedule-bar").isVisible(),
        true,
      );
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /18:55–20:25/,
      );
      f.delayed.delete(date);
      await page.locator("#calendar-date").fill(nextDate);
      await page.locator("#calendar-date").dispatchEvent("change");
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(
        await page.locator(".calendar-reschedule-preview").count(),
        0,
      );
      assert.equal(f.writes.length, 0);
    },
  );
  await scenario(
    "late saved response after navigation cannot revive draft or replace the new page",
    desktop,
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      await page.locator('[data-appointment="dense-target"]').click();
      await page.locator("#appointment-summary-reschedule").click();
      await shiftKeyboardDraft(page, "ArrowUp");
      const hold = deferred();
      f.writeWait = hold;
      const started = page.waitForRequest((r) => r.method() === "PUT");
      await page.locator("#calendar-reschedule-save").click();
      const request = await started;
      await navigate(page, "clients");
      await page.locator("#client-search").waitFor();
      const finished = page.waitForResponse((r) => r.request() === request);
      hold.release();
      await finished;
      await renderedFrames(page);
      assert.equal(await page.locator("#client-search").isVisible(), true);
      assert.equal(
        await page
          .locator("#calendar-reschedule-bar, .calendar-reschedule-preview")
          .count(),
        0,
      );
      assert.equal(await page.locator("#drawer").isVisible(), false);
      assert.equal(
        f.writes.length,
        1,
        "Already-authorized save finishes once, without new phantom writes",
      );
    },
  );
  await scenario(
    "blur during a pending move blocks a second save and refreshes its eventual result",
    desktop,
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      const event = page.locator('[data-appointment="dense-target"]');
      await event.click();
      await page.locator("#appointment-summary-reschedule").click();
      await shiftKeyboardDraft(page, "ArrowUp");
      const hold = deferred();
      f.writeWait = hold;
      const started = page.waitForRequest((r) => r.method() === "PUT");
      await page.locator("#calendar-reschedule-save").click();
      const request = await started;
      // Exercise the lifecycle callback without opening an unrelated real browser tab.
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      const point = await bodyPoint(event);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x, point.y - 20, { steps: 3 });
      await page.mouse.up();
      assert.equal(f.writes.length, 1);
      assert.equal(await page.locator("#calendar-reschedule-bar").count(), 0);
      const finished = page.waitForResponse((r) => r.request() === request);
      hold.release();
      await finished;
      await event
        .locator(".event-time")
        .filter({ hasText: "18:55–20:25" })
        .waitFor();
      assert.equal(f.writes.length, 1);
    },
  );
  await scenario(
    "All resources mirrors unified-room moves and preserves a declined then accepted therapist request",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [
        {
          ...booking("linked", "tA", "r1", 0, 1140, 90),
          requestedTherapistId: "tA",
        },
      ];
      await open();
      await selectMode(page, "all");
      await page.locator("#calendar-scroll").evaluate(
        (el, top) => {
          el.scrollTop = top;
          el.scrollLeft = 0;
        },
        await pixelAt(page, 1080),
      );
      const roomColumn = page.locator('[data-kind="room"][data-resource="r1"]');
      await roomColumn.locator('[data-appointment="linked"]').click();
      await page.locator("#appointment-summary-reschedule").click();
      assert.equal(
        await page
          .locator('.calendar-reschedule-preview[data-appointment="linked"]')
          .count(),
        2,
        "Therapist and room share one selected draft",
      );
      const source = await bodyPoint(
        roomColumn.locator(".calendar-reschedule-preview"),
      );
      const roomBox = await roomColumn.boundingBox();
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      await page.mouse.move(roomBox.x + roomBox.width * 0.75, source.y - 10, {
        steps: 8,
      });
      await page.mouse.up();
      const mirrored = await page
        .locator(".calendar-reschedule-preview .event-time")
        .allTextContents();
      assert.deepEqual(mirrored, ["18:55–20:25", "18:55–20:25"]);
      const previewBox = await roomColumn
        .locator(".calendar-reschedule-preview")
        .boundingBox();
      assert.ok(
        Math.abs(previewBox.x - roomBox.x - 3) <= 1 &&
          Math.abs(previewBox.width - (roomBox.width - 6)) <= 1,
        "Lone room copy stays full width despite the horizontal drag position",
      );
      assert.match(
        await page.locator("#calendar-reschedule-resource").textContent(),
        /Table 1/,
      );
      assert.equal(
        f.writes.length,
        0,
        "Explicit draft waits for Save even when moved using a mouse",
      );
      const firstSave = page.waitForResponse(
        (r) => r.request().method() === "PUT",
      );
      await page.locator("#calendar-reschedule-save").click();
      await firstSave;
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(f.writes[0].body.bed, 0);
      assert.equal(f.writes[0].body.start, 1135);
      assert.equal(f.writes[0].body.therapistId, "tA");
      await page
        .locator(
          '[data-kind="therapist"][data-resource="tA"] [data-appointment="linked"]',
        )
        .click();
      await page.locator("#appointment-summary-reschedule").click();
      const therapistColumn = page.locator(
        '[data-kind="therapist"][data-resource="tB"]',
      );
      const oldPoint = await bodyPoint(
        page.locator(
          '[data-kind="therapist"][data-resource="tA"] .calendar-reschedule-preview',
        ),
      );
      const nextBox = await therapistColumn.boundingBox();
      await page.mouse.move(oldPoint.x, oldPoint.y);
      await page.mouse.down();
      await page.mouse.move(nextBox.x + nextBox.width / 2, oldPoint.y, {
        steps: 8,
      });
      await page.mouse.up();
      assert.equal(
        await therapistColumn.locator(".calendar-reschedule-preview").count(),
        1,
      );
      let confirmation;
      page.once("dialog", async (dialog) => {
        confirmation = dialog.message();
        await dialog.dismiss();
      });
      await page.locator("#calendar-reschedule-save").click();
      await page.waitForFunction(
        () => !document.querySelector("#calendar-reschedule-save").disabled,
      );
      assert.match(confirmation, /another therapist/i);
      assert.equal(
        f.writes.length,
        1,
        "Declining therapist reassignment adds no mutation",
      );
      assert.equal(
        await page.locator("#calendar-reschedule-bar").isVisible(),
        true,
      );
      page.once("dialog", (dialog) => dialog.accept());
      const secondSave = page.waitForResponse(
        (r) => r.request().method() === "PUT",
      );
      await page.locator("#calendar-reschedule-save").click();
      await secondSave;
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 2);
      assert.equal(f.writes[1].body.therapistId, "tB");
      assert.equal(f.writes[1].body.requestedTherapistId, "tA");
      assert.equal(f.writes[1].body.bed, 0);
      assert.equal(f.writes[1].body.duration, 90);
    },
  );
  await scenario(
    "Today action returns both past and future to the Belgrade date",
    phone,
    async ({ page, open }) => {
      await open();
      const today = await page.evaluate(() => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Belgrade",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
            .formatToParts(new Date())
            .map((p) => [p.type, p.value]),
        );
        return `${parts.year}-${parts.month}-${parts.day}`;
      });
      for (const away of ["2025-01-03", "2027-12-24"]) {
        await page.locator("#calendar-date").fill(away);
        await page.locator("#calendar-date").dispatchEvent("change");
        const button = page.locator("#calendar-today-floating");
        await button.waitFor();
        await withinViewport(page, button, "Floating Today button");
        await button.click();
        assert.equal(await page.locator("#calendar-date").inputValue(), today);
        await button.waitFor({ state: "hidden" });
      }
    },
  );
  for (const resourceType of ["therapist", "room"])
    await scenario(
      `mouse moves ${resourceType} entries up, down and across columns with one PUT per drop`,
      desktop,
      async ({ page, f, open }) => {
        const first = resourceType === "room" ? "r1" : "tA",
          second = resourceType === "room" ? "r2" : "tB",
          original = calendarBlock("mouse-block", {
            start: 660,
            duration: 90,
            resourceType,
            resourceId: first,
            bed: null,
            title: "QA preparation <text>",
            note: "Preserve the complete note\nAfter a move.",
          });
        f.blocks = [structuredClone(original)];
        await open();
        await blockMoveView(
          page,
          resourceType === "room" ? "rooms" : "therapists",
          660,
        );
        for (const [index, target] of [
          { start: 655, resourceId: first },
          { start: 665, resourceId: first },
          { start: 665, resourceId: second },
          { start: 660, resourceId: first },
        ].entries()) {
          const response = page.waitForResponse(
            (r) =>
              r.request().method() === "PUT" &&
              r.url().endsWith("/api/calendar-blocks/mouse-block"),
          );
          await moveBlockPointer(
            page,
            original.id,
            resourceType,
            target.resourceId,
            target.start,
          );
          assert.equal((await response).status(), 200);
          await page
            .locator("#calendar-reschedule-bar")
            .waitFor({ state: "hidden" });
          await page
            .locator(
              `[data-resource="${target.resourceId}"] [data-calendar-block="${original.id}"]`,
            )
            .waitFor();
          assert.equal(f.blockWrites.length, index + 1);
          assert.equal(f.blockWrites[index].body.version, index + 1);
          assertBlockSnapshot(f.blocks[0], original, {
            ...target,
            resourceType,
            bed: null,
            version: index + 2,
          });
          assert.equal(f.writes.length, 0);
          assert.equal(await page.locator("#drawer").isVisible(), false);
          assert.equal(
            await page.locator("#calendar-slot-menu").isVisible(),
            false,
          );
        }
        await capture(page, `desktop-moved-${resourceType}-block`);
        await open();
        await blockMoveView(
          page,
          resourceType === "room" ? "rooms" : "therapists",
          660,
        );
        await page.locator(`[data-calendar-block="${original.id}"]`).click();
        assert.match(
          await page.locator(".calendar-block-details").textContent(),
          /11:00–12:30/,
        );
        assert.match(
          await page.locator(".calendar-block-details").textContent(),
          /Preserve the complete note/,
        );
        assert.equal(
          f.blockWrites.length,
          4,
          "A plain details click adds no write",
        );
      },
    );
  await scenario(
    "scope-changing block drops require Save and restore original table when dragged back",
    desktop,
    async ({ page, f, open }) => {
      const original = calendarBlock("scope-block", {
        start: 660,
        duration: 60,
      });
      f.blocks = [structuredClone(original)];
      await open();
      await blockMoveView(page, "all", 660);
      await moveBlockPointer(page, original.id, "room", "r2", 660);
      await page.locator("#calendar-reschedule-bar").waitFor();
      assert.equal(f.blockWrites.length, 0);
      assert.match(
        await page.locator("#calendar-reschedule-resource").textContent(),
        /QA Single.*Table 1/i,
      );
      await moveBlockPointer(page, original.id, "room", "r1", 660);
      assert.equal(f.blockWrites.length, 0);
      assert.match(
        await page.locator("#calendar-reschedule-resource").textContent(),
        /QA Couple.*Table 2/i,
      );
      await compactMoveBar(page);
      await moveBlockPointer(page, original.id, "room", "r2", 660);
      const save = async (target) => {
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === "PUT" &&
            r.url().endsWith("/api/calendar-blocks/scope-block"),
        );
        await page.locator("#calendar-reschedule-save").click();
        assert.equal((await response).status(), 200);
        await page
          .locator("#calendar-reschedule-bar")
          .waitFor({ state: "hidden" });
        assertBlockSnapshot(f.blocks[0], original, target);
        await page
          .locator(
            `[data-resource="${target.resourceId}"] [data-calendar-block="scope-block"]`,
          )
          .waitFor();
      };
      await save({ resourceType: "room", resourceId: "r2", bed: 0 });
      await moveBlockPointer(page, original.id, "therapist", "tB", 660);
      await page.locator("#calendar-reschedule-bar").waitFor();
      assert.equal(
        f.blockWrites.length,
        1,
        "Cross-kind mouse drop remains a draft",
      );
      assert.match(
        await page.locator("#calendar-reschedule-resource").textContent(),
        /QA Therapist B/,
      );
      await save({ resourceType: "therapist", resourceId: "tB", bed: null });
      await moveBlockPointer(page, original.id, "room", "r1", 660);
      await page.locator("#calendar-reschedule-bar").waitFor();
      assert.equal(f.blockWrites.length, 2);
      assert.match(
        await page.locator("#calendar-reschedule-resource").textContent(),
        /All tables/i,
      );
      await save({ resourceType: "room", resourceId: "r1", bed: null });
      assert.equal(f.writes.length, 0);
    },
  );
  for (const device of [phone, tablet])
    await scenario(
      "touch block tap and scroll stay safe; long press supports Cancel, Save once and persistent resource movement",
      device,
      async ({ page, f, open }) => {
        if (device.name === "tablet") f.role = "reception";
        const original = calendarBlock("touch-block", {
          start: 660,
          duration: 90,
          bed: null,
          blocksAvailability: false,
          title: "QA call reminder",
        });
        f.blocks = [structuredClone(original)];
        f.appointments = [booking("adjacent", "tA", "r1", 0, 600, 60)];
        await open();
        await blockMoveView(page, "rooms", 660);
        const card = page.locator('[data-calendar-block="touch-block"]');
        const before = await page
          .locator("#calendar-scroll")
          .evaluate((el) => el.scrollTop);
        const swipePoint = await bodyPoint(card),
          swipe = await touchStart(page, swipePoint);
        await swipe.move({ x: swipePoint.x, y: swipePoint.y - 40 });
        await swipe.move({ x: swipePoint.x, y: swipePoint.y - 90 });
        await swipe.end();
        await renderedFrames(page);
        assert.ok(
          (await page
            .locator("#calendar-scroll")
            .evaluate((el) => el.scrollTop)) >
            before + 20,
        );
        assert.equal(await page.locator("#calendar-reschedule-bar").count(), 0);
        assert.equal(f.blockWrites.length, 0);
        await blockMoveView(page, "rooms", 660);
        await card.tap();
        await page.locator(".calendar-block-details").waitFor();
        await page.locator("#drawer-close").click();
        assert.equal(f.blockWrites.length, 0);
        const neighbor = page.locator('[data-appointment="adjacent"]'),
          neighborBefore = await neighbor.boundingBox();
        await longPress(page, card);
        assert.equal(f.blockWrites.length, 0, "First long press only selects");
        await moveBlockPointer(page, original.id, "room", "r1", 655, true);
        await page
          .locator("#calendar-reschedule-time")
          .filter({ hasText: "10:55–12:25" })
          .waitFor();
        assert.equal(f.blockWrites.length, 0);
        assert.ok(
          (await neighbor.boundingBox()).width < neighborBefore.width * 0.7,
          "The draft reflows the neighboring appointment instead of covering it",
        );
        await capture(page, `${device.name}-selected-block-draft`);
        await page.locator("#calendar-reschedule-cancel").click();
        await page
          .locator("#calendar-reschedule-bar")
          .waitFor({ state: "hidden" });
        assert.equal(f.blockWrites.length, 0);
        assert.ok(
          Math.abs(
            (await neighbor.boundingBox()).width - neighborBefore.width,
          ) < 1,
          "Cancel restores adjacent appointment width",
        );
        assert.equal(
          await page
            .locator(".is-reschedule-source,.calendar-reschedule-preview")
            .count(),
          0,
        );
        await longPress(page, card);
        await moveBlockPointer(page, original.id, "room", "r2", 665, true);
        assert.equal(f.blockWrites.length, 0);
        const wait = deferred();
        f.blockWriteWait = wait;
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === "PUT" &&
            r.url().endsWith("/api/calendar-blocks/touch-block"),
        );
        await page.locator("#calendar-reschedule-save").click();
        assert.equal(
          await page.locator("#calendar-reschedule-save").isDisabled(),
          true,
        );
        await page.locator("#calendar-reschedule-save").dispatchEvent("click");
        wait.release();
        assert.equal((await response).status(), 200);
        f.blockWriteWait = null;
        await page
          .locator("#calendar-reschedule-bar")
          .waitFor({ state: "hidden" });
        assert.equal(f.blockWrites.length, 1);
        assert.equal(f.blockWrites[0].body.version, 1);
        assertBlockSnapshot(f.blocks[0], original, {
          start: 665,
          resourceType: "room",
          resourceId: "r2",
          bed: null,
        });
        assert.equal(f.writes.length, 0);
        await open();
        await blockMoveView(page, "rooms", 665);
        await page
          .locator('[data-resource="r2"] [data-calendar-block="touch-block"]')
          .tap();
        assert.match(
          await page.locator(".calendar-block-details").textContent(),
          /11:05–12:35/,
        );
        assert.match(
          await page.locator(".calendar-block-details").textContent(),
          /QA call reminder/,
        );
      },
    );
  await scenario(
    "occupied and stale block moves keep a recoverable draft and do not change the saved entry",
    desktop,
    async ({ page, f, open }) => {
      const original = calendarBlock("conflict-block", {
        start: 660,
        duration: 60,
        bed: null,
      });
      f.blocks = [structuredClone(original)];
      f.appointments = [booking("occupied", "tB", "r2", 0, 600, 90)];
      await open();
      await blockMoveView(page, "rooms", 660);
      const rejected = page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          r.url().endsWith("/api/calendar-blocks/conflict-block"),
      );
      await moveBlockPointer(page, original.id, "room", "r2", 600);
      assert.equal((await rejected).status(), 409);
      await page.locator("#calendar-reschedule-error").waitFor();
      assert.equal(
        await page.locator("#calendar-reschedule-save").isEnabled(),
        true,
      );
      assert.deepEqual(f.blocks[0], original);
      await page.locator("#calendar-reschedule-cancel").click();
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      await page.locator('[data-calendar-block="conflict-block"]').click();
      await page.locator("#calendar-block-reschedule").click();
      await shiftKeyboardDraft(page, "ArrowDown");
      f.blocks[0].version = 2;
      const stale = page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          r.url().endsWith("/api/calendar-blocks/conflict-block"),
      );
      await page.locator("#calendar-reschedule-save").click();
      assert.equal((await stale).status(), 409);
      await page.locator("#calendar-reschedule-error").waitFor();
      assert.match(
        await page.locator("#calendar-reschedule-error").textContent(),
        /version changed/,
      );
      assert.equal(f.blocks[0].start, original.start);
      await page.locator("#calendar-reschedule-cancel").click();
      assert.equal(f.writes.length, 0);
    },
  );
  await scenario(
    "full-day block moves clamp at midnight boundaries and retain duration through keyboard controls",
    desktop,
    async ({ page, f, open }) => {
      f.blocks = [
        calendarBlock("whole-day", {
          start: 0,
          duration: 1440,
          bed: null,
          blocksAvailability: false,
        }),
      ];
      await open();
      await blockMoveView(page, "rooms", 660);
      await page.locator('[data-calendar-block="whole-day"]').click();
      await page.locator("#calendar-block-reschedule").click();
      await shiftKeyboardDraft(page, "ArrowUp");
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /00:00–24:00/,
      );
      await shiftKeyboardDraft(page, "ArrowDown");
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /00:00–24:00/,
      );
      await page.locator("#calendar-reschedule-cancel").click();
      assert.equal(f.blockWrites.length, 0);
      f.blocks = [
        calendarBlock("midnight", {
          start: 0,
          duration: 30,
          bed: null,
          blocksAvailability: false,
        }),
      ];
      await open();
      await blockMoveView(page, "rooms", 0);
      await page.locator('[data-calendar-block="midnight"]').click();
      await page.locator("#calendar-block-reschedule").click();
      await page
        .locator('.calendar-reschedule-preview[data-calendar-block="midnight"]')
        .focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /00:10–00:40/,
        "Repeated arrow keys retain focus on the rebuilt preview",
      );
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await shiftKeyboardDraft(page, "ArrowUp");
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /00:00–00:30/,
      );
      await shiftKeyboardDraft(page, "ArrowDown");
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /00:05–00:35/,
      );
      const response = page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          r.url().endsWith("/api/calendar-blocks/midnight"),
      );
      await page.locator("#calendar-reschedule-save").click();
      assert.equal((await response).status(), 200);
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(f.blocks[0].duration, 30);
      assert.equal(f.blocks[0].start, 5);
    },
  );
  for (const device of [desktop, phone, tablet])
    await scenario(
      "grey full-day entries support selected-table create, edit, remove and reload",
      device,
      async ({ page, f, open }) => {
        if (device.name === "tablet") f.role = "reception";
        f.appointments = [booking("workday", "tA", "r1", 0)];
        f.blocks = [
          calendarBlock("late-note", {
            start: 1380,
            duration: 60,
            bed: 0,
            title: "QA late call",
            blocksAvailability: false,
          }),
        ];
        await open();
        await roomPoint(page, device, 495);
        assert.equal(
          await page.locator("#calendar-slot-menu-time").textContent(),
          "08:15",
        );
        await page.locator("#calendar-slot-add-block").click();
        await page.locator("#calendar-block-form").waitFor();
        await withinViewport(
          page,
          page.locator("#drawer"),
          "Blocked-time editor",
        );
        assert.equal(await blockControl(page, "start").inputValue(), "08:15");
        assert.equal(
          await blockControl(page, "resourceType").inputValue(),
          "room",
        );
        assert.equal(await blockControl(page, "resourceId").inputValue(), "r1");
        assert.equal(
          await blockControl(page, "bed").inputValue(),
          "",
          "Room action defaults to the whole room",
        );
        await blockControl(page, "bed").selectOption("1");
        assert.equal(
          await blockControl(page, "blocksAvailability").isChecked(),
          true,
        );
        await blockControl(page, "title").fill("QA preparation <img src=x>");
        await blockControl(page, "note").fill(
          "Call reminder <script>window.qaInjected=true</script>",
        );
        await blockControl(page, "duration").fill("45");
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(f.blockWrites.length, 1);
        assert.deepEqual(f.blockWrites[0].body, {
          date,
          start: 495,
          duration: 45,
          resourceType: "room",
          resourceId: "r1",
          bed: 1,
          title: "QA preparation <img src=x>",
          note: "Call reminder <script>window.qaInjected=true</script>",
          blocksAvailability: true,
        });
        const entry = page.locator('[data-calendar-block="block-1"]');
        await entry.waitFor();
        assert.equal(await entry.locator("img,script").count(), 0);
        assert.equal(await page.evaluate(() => window.qaInjected), undefined);
        assert.match(await entry.getAttribute("class"), /is-blocking/);
        const grey = await entry.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        const rgb = grey.match(/\d+/g).slice(0, 3).map(Number);
        assert.ok(
          Math.max(...rgb) - Math.min(...rgb) < 28,
          "Blocked-time card has a neutral grey surface",
        );
        const box = await entry.boundingBox(),
          column = await page.locator('[data-resource="r1"]').boundingBox();
        assert.ok(Math.abs(box.y - column.y - (await pixelAt(page, 495))) <= 1);
        assert.ok(
          Math.abs(box.x - column.x - 3) <= 1 &&
            Math.abs(box.width - (column.width - 6)) <= 1,
          "A lone table-specific block uses the whole room width",
        );
        await capture(page, `${device.name}-early-grey-block`);
        await entry.click();
        assert.equal(
          await page.locator("#calendar-slot-menu").isVisible(),
          false,
          "A block click opens its details, not empty-slot quick actions",
        );
        assert.match(
          await page.locator("#drawer").textContent(),
          /QA preparation <img src=x>/,
        );
        assert.equal(
          await page.locator("#drawer img,#drawer script").count(),
          0,
        );
        await page.locator("#calendar-block-edit").click();
        await blockControl(page, "blocksAvailability").uncheck();
        await blockControl(page, "title").fill("QA edited reminder");
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(f.blockWrites[1].method, "PUT");
        assert.equal(f.blockWrites[1].body.version, 1);
        assert.equal(f.blockWrites[1].body.blocksAvailability, false);
        await open();
        await selectMode(page, "rooms");
        await page.locator("#calendar-scroll").evaluate(
          (el, top) => {
            el.scrollTop = top;
          },
          await pixelAt(page, 450),
        );
        await entry.waitFor();
        assert.match(await entry.textContent(), /QA edited reminder/);
        assert.match(await entry.getAttribute("class"), /is-note-only/);
        await entry.click();
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#calendar-block-remove").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        await entry.waitFor({ state: "detached" });
        assert.equal(f.blockWrites[2].method, "DELETE");
        assert.equal(f.blockWrites[2].body.version, 2);
        // Phone toolbars make the calendar taller than the remaining page
        // viewport. Bring its outer page container into view before inspecting
        // the last inner-scroll interval, as in the full-day axis scenario.
        await page.locator("#calendar-scroll").scrollIntoViewIfNeeded();
        await page.locator("#calendar-scroll").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await renderedFrames(page);
        const late = page.locator('[data-calendar-block="late-note"]');
        await withinViewport(
          page,
          late,
          "23:00–24:00 note outside appointment working hours",
        );
        assert.match(await late.textContent(), /23:00–24:00/);
        await capture(page, `${device.name}-late-calendar-note`);
        assert.equal(
          f.writes.length,
          0,
          "Calendar-entry CRUD never creates or modifies appointments",
        );
      },
    );
  await scenario(
    "overlapping note and appointment remain visible without hiding either lane",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [booking("with-note", "tA", "r1", 0)];
      f.blocks = [
        calendarBlock("overlap", {
          start: 600,
          duration: 60,
          bed: 0,
          blocksAvailability: false,
          title: "QA call reminder",
        }),
      ];
      await open();
      await selectMode(page, "rooms");
      const appointment = page.locator('[data-appointment="with-note"]'),
        note = page.locator('[data-calendar-block="overlap"]');
      const a = await withinViewport(
          page,
          appointment,
          "Appointment beside note",
        ),
        b = await withinViewport(page, note, "Note beside appointment");
      assert.ok(Math.abs(a.y - b.y) <= 1);
      assert.ok(
        a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1,
        "Visual overlap is split into usable lanes",
      );
      await appointment.click();
      await page.locator("#appointment-summary-edit").waitFor();
      await page.locator("#drawer-close").click();
      await note.click();
      await page.locator("#calendar-block-edit").waitFor();
      await capture(page, "desktop-overlapping-note-details");
    },
  );
  await scenario(
    "booking suggestions ignore notes but honor whole-room and therapist blocking entries",
    desktop,
    async ({ page, f, open }) => {
      f.blocks = [
        calendarBlock("room-note", {
          start: 600,
          duration: 60,
          bed: null,
          blocksAvailability: false,
        }),
      ];
      await open();
      await add(page);
      await stateIs(page, "available");
      assert.equal((await selected(page)).roomId, "r1");
      await page.locator("#form-cancel").click();
      f.blocks[0].blocksAvailability = true;
      f.blocks.push(
        calendarBlock("staff-block", {
          start: 600,
          duration: 60,
          resourceType: "therapist",
          resourceId: "tA",
          bed: null,
        }),
      );
      await add(page);
      await stateIs(page, "available");
      const values = await selected(page);
      assert.equal(values.roomId, "r2");
      assert.equal(values.therapistId, "tB");
      await control(page, "roomId").selectOption("r1");
      await stateIs(page, "warning");
      assert.equal(
        (await selected(page)).roomId,
        "r1",
        "Explicit blocked choice stays visible with a warning",
      );
      assert.equal(f.writes.length, 0);
    },
  );
  for (const device of [desktop, phone])
    await scenario(
      "therapist block projection is read-only and hides over-broad free text",
      device,
      async ({ page, f, open }) => {
        f.role = "therapist";
        f.blocks = [
          calendarBlock("private-block", {
            start: 600,
            title: "Private QA client identity",
            note: "Private QA phone 060123456",
          }),
        ];
        await open();
        await selectMode(page, "rooms");
        const block = page.locator('[data-calendar-block="private-block"]');
        await block.waitFor();
        assert.doesNotMatch(
          await block.evaluate((el) => el.outerHTML),
          /Private QA|060123456/,
        );
        assert.match(await block.textContent(), /Blocked time/);
        assert.equal(await page.locator("#calendar-block-add").count(), 0);
        if (device.mobile) await block.tap();
        else await block.click();
        await page.locator(".calendar-block-details").waitFor();
        assert.doesNotMatch(
          await page.locator("#drawer").evaluate((el) => el.outerHTML),
          /Private QA|060123456/,
        );
        assert.equal(
          await page
            .locator(
              "#calendar-block-edit,#calendar-block-remove,#calendar-block-reschedule,#calendar-block-form",
            )
            .count(),
          0,
        );
        assert.equal(f.blockWrites.length, 0);
        await capture(page, `${device.name}-therapist-block-details`);
        await page.locator("#drawer-close").click();
        const point = await bodyPoint(block);
        if (device.mobile) {
          const gesture = await touchStart(page, point);
          await new Promise((done) => setTimeout(done, 520));
          await gesture.move({ x: point.x, y: point.y + 20 });
          await gesture.end();
        } else {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x, point.y + 20, { steps: 4 });
          await page.mouse.up();
        }
        assert.equal(
          await page
            .locator("#calendar-reschedule-bar,.calendar-reschedule-preview")
            .count(),
          0,
        );
        assert.equal(
          f.blockWrites.length,
          0,
          "Read-only gestures never send a mutation",
        );
      },
    );
  for (const device of [phone, tablet])
    await scenario(
      "compact calendar keeps controls usable and keyboard bands below resource headers",
      device,
      async ({ page, open }) => {
        await open();
        const header = await page.locator("#calendar-headers").boundingBox();
        if (device.name === "phone")
          assert.ok(
            header.y + header.height <= 407,
            "Visible phone grid gains at least 80px over its previous 487px top: " +
              JSON.stringify(header),
          );
        const overflow = await page.evaluate(() => ({
          actual: document.documentElement.scrollWidth,
          viewport: innerWidth,
        }));
        assert.ok(
          overflow.actual <= overflow.viewport + 1,
          "Calendar width stays inside the outer page; resources scroll within their own grid",
        );
        const compact = await mobileNavigation(page);
        const controls = compact
          ? [
              "#calendar-prev",
              "#calendar-date",
              "#calendar-next",
              "#calendar-view-options",
              "#mobile-add",
              "#mobile-more",
              '#mobile-navigation [data-mobile-page="calendar"]',
              '#mobile-navigation [data-mobile-page="clients"]',
            ]
          : [
              "#calendar-today",
              "#calendar-prev",
              "#calendar-date",
              "#calendar-next",
              "#calendar-refresh",
              "#calendar-block-add",
              "#appointment-add",
              '[data-mode="all"]',
              '[data-mode="therapists"]',
              '[data-mode="rooms"]',
            ];
        for (const selector of controls)
          await withinViewport(
            page,
            page.locator(selector),
            "Available calendar control " + selector,
          );
        if (compact) {
          assert.ok(
            header.y + header.height <= 150,
            "Schedule starts by150px in compact view",
          );
          await page.locator("#calendar-view-options").click();
          for (const selector of [
            '[data-mobile-mode="all"]',
            '[data-mobile-mode="therapists"]',
            '[data-mobile-mode="rooms"]',
            "#mobile-calendar-refresh",
          ])
            await withinViewport(
              page,
              page.locator(selector),
              "View option " + selector,
            );
          await page.keyboard.press("Escape");
          await page.locator("#drawer").waitFor({ state: "hidden" });
        }
        await capture(page, `${device.name}-compact-calendar-toolbar`);
        await selectMode(page, "rooms");
        const column = page.locator('[data-resource="r1"]');
        await column.evaluate((el) => el.focus({ preventScroll: true }));
        const initial = await page.evaluate(() => {
          const box = document
            .querySelector('[data-resource="r1"]')
            .getBoundingClientRect();
          const header = document
            .querySelector("#calendar-headers")
            .getBoundingClientRect();
          return (
            Math.floor(
              (Math.max(header.bottom, 0) + 10 - box.top) /
                (box.height / 1440) /
                15,
            ) * 15
          );
        });
        await page.keyboard.press("ArrowDown");
        await renderedFrames(page);
        const hint = column.locator(".calendar-slot-hint");
        assert.equal(
          await hint.getAttribute("data-start"),
          String(initial + 15),
        );
        assert.equal(await hint.getAttribute("data-bed"), null);
        for (const key of ["ArrowDown", "End", "Home", "PageDown"]) {
          await page.keyboard.press(key);
          await renderedFrames(page);
          const band = await withinViewport(
            page,
            hint,
            "Keyboard-selected quarter-hour band",
          );
          const currentHeader = await page
            .locator("#calendar-headers")
            .boundingBox();
          assert.ok(
            band.y >= currentHeader.y + currentHeader.height - 1,
            "Selected band remains below the actual compact header",
          );
          assert.ok(
            Math.abs(band.height - 15 * (await pixelsPerMinute(page))) <= 1,
          );
          assert.equal(Number(await hint.getAttribute("data-start")) % 15, 0);
        }
        assert.equal(await hint.getAttribute("data-start"), "30");
        assert.equal(await hint.getAttribute("data-bed"), null);
        await page.keyboard.press("Enter");
        await page.locator("#calendar-slot-menu").waitFor();
        assert.equal(
          await page.locator("#calendar-slot-menu-time").textContent(),
          "00:30",
        );
        assert.match(
          await page.locator("#calendar-slot-menu-resource").textContent(),
          /^QA Couple$/,
        );
        await withinViewport(
          page,
          page.locator("#calendar-slot-menu"),
          "Keyboard quick actions after compact-header scrolling",
        );
      },
    );
  await scenario(
    "live booking summary follows explicit resources and never fabricates an invalid end time",
    desktop,
    async ({ page, f, open }) => {
      await open();
      await add(page);
      await stateIs(page, "available");
      await control(page, "serviceId").selectOption("s90");
      await control(page, "therapistId").selectOption("tC");
      await control(page, "roomId").selectOption("r1");
      await control(page, "bed").selectOption("1");
      await stateIs(page, "available");
      await liveSummary(page, {
        time: /10:00.*11:30/,
        duration: /90/,
        treatment: /QA Longer Massage/,
        resources: [/QA Therapist C/, /QA Couple/, /Table 2/],
      });
      await control(page, "duration").fill("");
      assert.doesNotMatch(
        await page.locator("#booking-summary").textContent(),
        /11:30|NaN|undefined/,
      );
      await page.locator("#form-save").click();
      assert.equal(
        f.writes.length,
        0,
        "Native validation prevents saving an empty duration",
      );
      await control(page, "duration").fill("7");
      assert.doesNotMatch(
        await page.locator("#booking-summary").textContent(),
        /10:07|NaN|undefined/,
      );
      await page.locator("#form-save").click();
      assert.equal(f.writes.length, 0, "Off-step duration cannot be submitted");
      await control(page, "duration").fill("90");
      await control(page, "start").fill("23:30");
      await control(page, "start").press("Tab");
      assert.match(
        await page.locator("#booking-summary").textContent(),
        /end time exceeds this day/,
      );
      assert.doesNotMatch(
        await page.locator("#booking-summary").textContent(),
        /25:00|NaN/,
      );
      await control(page, "date").fill(nextDate);
      await control(page, "date").press("Tab");
      assert.match(
        await page.locator(".booking-summary-date").textContent(),
        /2 Oct 2026/,
      );
      await control(page, "start").fill("11:15");
      await control(page, "start").press("Tab");
      await stateIs(page, "available");
      await liveSummary(page, {
        time: /11:15.*12:45/,
        duration: /90/,
        treatment: /QA Longer Massage/,
        resources: [/QA Therapist C/, /QA Couple/, /Table 2/],
      });
      await page.locator("#form-save").click();
      await page.locator("#drawer").waitFor({ state: "hidden" });
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].body.date, nextDate);
      assert.equal(f.writes[0].body.start, 675);
      assert.equal(f.writes[0].body.duration, 90);
    },
  );
  for (const role of ["owner", "reception"])
    await scenario(
      `${role} booking sections preserve inline clients and the walk-in toggle`,
      phone,
      async ({ page, f, open }) => {
        f.role = role;
        await open();
        await add(page);
        await stateIs(page, "available");
        await bookingLayout(page, role);
        await liveSummary(page, {
          time: /10:00.*11:00/,
          duration: /60/,
          treatment: /QA Massage/,
          resources: [/QA Therapist A/, /QA Couple/, /Table 1/],
        });
        assert.equal(
          await page.locator('[name="grossCents"]').count(),
          role === "owner" ? 1 : 0,
        );
        assert.equal(
          await page.locator('[name="netCents"]').count(),
          role === "owner" ? 1 : 0,
        );
        await page.locator("#new-client-check").check();
        await control(page, "newName").fill("Inline QA Guest");
        await control(page, "newPhone").fill("+381600000099");
        await control(page, "newInstagram").fill("qa_example");
        await control(page, "newNote").fill("Fictional inline note");
        assert.equal(await control(page, "clientId").isDisabled(), true);
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.deepEqual(f.writes[0].body.newClient, {
          name: "Inline QA Guest",
          phone: "+381600000099",
          email: "",
          instagram: "qa_example",
          note: "Fictional inline note",
        });
        assert.equal(f.writes[0].body.clientId, null);
        assert.equal(
          Object.hasOwn(f.writes[0].body, "grossCents"),
          role === "owner",
        );
        await add(page);
        await stateIs(page, "available");
        await page.locator("#new-client-check").check();
        await control(page, "newName").fill("Discard this unsaved name");
        await page.locator("#new-client-check").uncheck();
        assert.equal(
          await page.locator("#new-client-fields").isVisible(),
          false,
        );
        assert.equal(await control(page, "clientId").isEnabled(), true);
        assert.equal(await control(page, "clientId").inputValue(), "");
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(f.writes[1].body.clientId, null);
        assert.equal(Object.hasOwn(f.writes[1].body, "newClient"), false);
      },
    );
  await scenario(
    "edited booking still reaches client profile and saves a fictional photo preview",
    phone,
    async ({ page, f, open }) => {
      f.appointments = [booking("profile-flow", "tA", "r1", 0)];
      await open();
      await selectMode(page, "rooms");
      await page.locator('[data-appointment="profile-flow"]').click();
      await page.locator("#appointment-summary-edit").click();
      await page.locator("#appointment-form").waitFor();
      await bookingLayout(page);
      assert.equal(
        await page.locator("#booking-client-photo .avatar").count(),
        1,
      );
      await page.locator("#booking-open-profile").click();
      await page.locator("#profile-back").waitFor();
      await page.locator("#profile-back").click();
      await page.locator("#appointment-form").waitFor();
      assert.equal((await selected(page)).clientId, "c1");
      await page.locator("#booking-open-profile").click();
      await page.locator("#profile-photo").click();
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 8;
        canvas.getContext("2d").fillRect(0, 0, 8, 8);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await page.getByLabel("Choose profile photo").setInputFiles({
        name: "fictional-qa.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
      await page
        .locator("[data-photo-status]")
        .filter({ hasText: "Preview ready" })
        .waitFor();
      await withinViewport(
        page,
        page.locator("#form-save"),
        "Photo save remains usable",
      );
      await page.locator("#form-save").click();
      await page.locator("#profile-back").waitFor();
      assert.equal(f.photoWrites.length, 1);
      assert.ok(f.photoWrites[0].data.length > 0);
      await page.locator("#profile-back").click();
      await page.locator("#appointment-form").waitFor();
      const image = page.locator("#booking-client-photo img");
      await image.waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector("#booking-client-photo img");
        return image.complete && image.naturalWidth > 0;
      });
      assert.equal((await selected(page)).clientId, "c1");
      assert.equal(f.writes.length, 0);
    },
  );
  for (const device of [phone, tablet])
    await scenario(
      "touch forms keep editable text readable across login and salon workflows",
      device,
      async ({ page, f, open }) => {
        f.authenticated = false;
        await page.goto(origin);
        await page.locator("#login-screen").waitFor();
        await editableFonts(page, "#login-form", "Login");
        await page
          .locator('#login-form [name="email"]')
          .fill("fictional@example.test");
        await page
          .locator('#login-form [name="password"]')
          .fill("FictionalQAOnly123");
        await page.locator('#login-form button[type="submit"]').click();
        await page
          .locator("#calendar-grid,#report-metrics .report-metric")
          .first()
          .waitFor();
        await open();
        await editableFonts(page, ".calendar-date-controls", "Calendar date");
        await noPageOverflow(page, "Touch calendar");
        await navigate(page, "clients");
        await page.locator("#client-search").waitFor();
        await editableFonts(page, "#page-content", "Client search");
        await page.locator("#client-add").click();
        await editableFonts(page, "#client-form", "Client profile");
        await page.locator("#form-cancel").click();
        await navigate(page, "services");
        await page.locator("#service-add").click();
        await editableFonts(page, "#service-form", "Treatment");
        await withinViewport(
          page,
          page.locator("#form-save"),
          "Treatment save",
        );
        await page.locator("#form-cancel").click();
        await navigate(page, "calendar");
        await openAdd(page, "block");
        await page.locator("#calendar-block-form").waitFor();
        await editableFonts(page, "#calendar-block-form", "Blocked time");
        await blockControl(page, "note").fill("Fictional mobile note");
        await noPageOverflow(page, "Blocked-time form");
        await withinViewport(
          page,
          page.locator("#form-save"),
          "Blocked-time save",
        );
        await page.locator("#form-cancel").click();
        await add(page);
        await editableFonts(
          page,
          "#appointment-form",
          "Booking and client search",
        );
        await control(page, "note").fill("Fictional touch booking note");
        await bookingLayout(page);
        await noPageOverflow(page, "Booking form");
        assert.ok(
          Math.abs((await page.evaluate(() => visualViewport.scale)) - 1) <
            0.02,
          "Field focus stays at natural scale in Chromium emulation",
        );
        await capture(page, `${device.name}-stable-booking-inputs`);
        await page.locator("#form-cancel").click();
        assert.equal(
          f.writes.length + f.blockWrites.length + f.serviceWrites.length,
          0,
          "Font and focus checks do not save test entities",
        );
      },
    );
  for (const device of [
    {
      name: "phone-narrow",
      viewport: { width: 320, height: 568 },
      mobile: true,
    },
    {
      name: "phone-landscape",
      viewport: { width: 844, height: 390 },
      mobile: true,
    },
  ])
    await scenario(
      "narrow and short touch viewports keep native time fields and save controls reachable",
      device,
      async ({ page, open }) => {
        await open();
        await noPageOverflow(page, "Narrow calendar");

        await add(page);
        await editableFonts(page, "#appointment-form", "Narrow booking fields");
        for (const name of ["date", "start", "duration"]) {
          await control(page, name).scrollIntoViewIfNeeded();
          await withinViewport(
            page,
            control(page, name),
            "Native booking field " + name,
          );
          await noPageOverflow(page, "Native booking field " + name);
        }
        await control(page, "duration").fill("90");
        await control(page, "note").fill("Narrow fictional note");
        await withinViewport(
          page,
          page.locator("#form-save"),
          "Narrow booking save",
        );
        await withinViewport(
          page,
          page.locator("#form-cancel"),
          "Narrow booking cancel",
        );
        await capture(page, `${device.name}-stable-booking-footer`);
        await page.locator("#form-cancel").click();

        await openAdd(page, "block");
        await page.locator("#calendar-block-form").waitFor();
        await editableFonts(
          page,
          "#calendar-block-form",
          "Narrow blocked-time fields",
        );
        await blockControl(page, "start").scrollIntoViewIfNeeded();
        await withinViewport(
          page,
          blockControl(page, "start"),
          "Native blocked-time field",
        );
        await noPageOverflow(page, "Narrow blocked-time form");
        await withinViewport(
          page,
          page.locator("#form-save"),
          "Narrow blocked-time save",
        );
      },
    );
  for (const device of [phone, tablet])
    await scenario(
      "empty catalogue guides owner through treatment creation and editing into a real booking selection",
      device,
      async ({ page, f, open }) => {
        f.catalogue.services = [];
        await open();
        await page.locator("#calendar-treatment-setup").waitFor();
        assert.equal(
          f.serviceWrites.length,
          0,
          "Guidance must not invent or seed treatments",
        );
        await openAdd(page, "appointment");
        await page.locator("#booking-treatment-add").waitFor();
        assert.equal(
          await page.locator("#appointment-form").count(),
          0,
          "Missing catalogue has readable guidance, not a broken booking form",
        );
        await page.locator("#booking-treatment-add").click();
        await page.locator("#service-form").waitFor();
        await page.locator("#form-cancel").click();
        await navigate(page, "calendar");
        await page.locator("#calendar-treatment-setup").waitFor();
        await page.locator('[data-resource="tA"]').waitFor();
        await page
          .locator("#calendar-headers")
          .filter({ hasText: "QA Therapist A" })
          .waitFor();
        await capture(page, `${device.name}-empty-treatment-guidance`);
        await page.locator("#calendar-treatment-add").click();
        await page.locator("#service-form").waitFor();
        await editableFonts(page, "#service-form", "Created treatment");
        await page
          .locator('#service-form [name="name"]')
          .fill("QA Newly Added Massage");
        await page.locator('#service-form [name="duration"]').fill("60");
        await page.locator('#service-form [name="price"]').fill("4700");
        await page.locator("#form-save").click();
        await page.locator('[data-service="qa-created-service"]').waitFor();
        assert.equal(f.serviceWrites.length, 1);
        assert.equal(f.serviceWrites[0].method, "POST");
        assert.equal(f.serviceWrites[0].body.priceCents, 470000);
        await page.locator('[data-service="qa-created-service"]').click();
        await page
          .locator('#service-form [name="name"]')
          .fill("QA Updated Massage");
        await page.locator('#service-form [name="duration"]').fill("90");
        await page.locator('#service-form [name="price"]').fill("5900");
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(f.serviceWrites.length, 2);
        assert.equal(f.serviceWrites[1].method, "PUT");
        assert.equal(f.serviceWrites[1].body.version, 1);
        await navigate(page, "calendar");
        await page.locator("#calendar-grid").waitFor();
        assert.equal(
          await page.locator("#calendar-treatment-setup").count(),
          0,
        );
        await add(page);
        await stateIs(page, "available");
        assert.equal(
          await control(page, "serviceId").inputValue(),
          "qa-created-service",
        );
        await liveSummary(page, {
          time: /10:00.*11:30/,
          duration: /90/,
          treatment: /QA Updated Massage/,
          resources: [/QA Therapist A/, /QA Couple/, /Table 1/],
        });
        assert.equal(await control(page, "grossCents").inputValue(), "5900.00");
        await page.locator("#form-save").click();
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(f.writes.length, 1);
        assert.equal(f.writes[0].body.serviceId, "qa-created-service");
        assert.equal(f.writes[0].body.duration, 90);
        assert.equal(f.writes[0].body.grossCents, 590000);
      },
    );
  for (const role of ["reception", "therapist"])
    await scenario(
      `${role} empty-catalogue guidance never exposes owner treatment controls`,
      phone,
      async ({ page, f, open }) => {
        f.role = role;
        f.catalogue.services = [];
        await open();
        assert.equal(await page.locator("#calendar-treatment-add").count(), 0);
        if (role === "reception") {
          await page.locator("#calendar-treatment-setup").waitFor();
          assert.match(
            await page.locator("#calendar-treatment-setup").textContent(),
            /owner/i,
          );
          await openAdd(page, "appointment");
          await page.locator("#drawer[open]").waitFor();
          assert.match(
            await page.locator("#drawer-content").textContent(),
            /owner/i,
          );
          assert.equal(
            await page
              .locator("#booking-treatment-add,#appointment-form")
              .count(),
            0,
          );
        } else
          assert.equal(
            await page
              .locator("#calendar-treatment-setup,#appointment-add")
              .count(),
            0,
          );
        assert.equal(f.serviceWrites.length, 0);
      },
    );
  for (const device of [phone, tablet])
    await scenario(
      "touch pinch has a working positive control and cannot enlarge calendar or booking form",
      device,
      async ({ page, f, open }) => {
        const controlPage = await page.context().newPage();
        try {
          await controlPage.goto(origin + "/qa-unconstrained-zoom");
          const scale = await pinch(controlPage, {
            x: device.viewport.width / 2,
            y: device.viewport.height / 2,
          });
          assert.ok(
            scale > 1.2,
            "Positive control must actually zoom; otherwise a stable application scale proves nothing: " +
              scale,
          );
        } finally {
          await controlPage.close();
        }
        await open();
        await calendarScaleStable(page);
        assert.equal(
          await page.locator("#calendar-slot-menu").isVisible(),
          false,
          "Pinching empty calendar space does not open booking actions",
        );
        assert.equal(
          f.writes.length + f.blockWrites.length,
          0,
          "Pinch never creates or moves a booking",
        );
        await selectMode(page, "all");
        const scrollBox = await page.locator("#calendar-scroll").boundingBox();
        const beforeScroll = await page
          .locator("#calendar-scroll")
          .evaluate((el) => ({
            left: el.scrollLeft,
            top: el.scrollTop,
            width: el.clientWidth,
            totalWidth: el.scrollWidth,
            height: el.clientHeight,
            totalHeight: el.scrollHeight,
          }));
        assert.ok(
          beforeScroll.totalWidth - beforeScroll.width > 100,
          "Fixture exposes horizontally scrollable resources: " +
            JSON.stringify(beforeScroll),
        );
        const point = {
          x: scrollBox.x + scrollBox.width / 2,
          y: scrollBox.y + scrollBox.height / 2,
        };
        const horizontal = await touchStart(page, point);
        await horizontal.move({ x: point.x - 40, y: point.y });
        await horizontal.move({ x: point.x - 110, y: point.y });
        await horizontal.end();
        await renderedFrames(page);
        const vertical = await touchStart(page, point);
        await vertical.move({ x: point.x, y: point.y - 40 });
        await vertical.move({ x: point.x, y: point.y - 110 });
        await vertical.end();
        await renderedFrames(page);
        const afterScroll = await page
          .locator("#calendar-scroll")
          .evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
        assert.ok(
          afterScroll.left > beforeScroll.left + 25,
          "Single-finger horizontal scrolling remains usable: " +
            JSON.stringify({ beforeScroll, afterScroll }),
        );
        assert.ok(
          afterScroll.top > beforeScroll.top + 25,
          "Single-finger vertical scrolling remains usable: " +
            JSON.stringify({ beforeScroll, afterScroll }),
        );
        const meta = await page
          .locator(
            (await page.locator(".calendar-meta").isVisible())
              ? ".calendar-meta"
              : "#calendar-headers",
          )
          .boundingBox();
        await page.touchscreen.tap(meta.x + 20, meta.y + meta.height / 2);
        await page.touchscreen.tap(meta.x + 20, meta.y + meta.height / 2);
        await renderedFrames(page);
        assert.ok(
          Math.abs((await page.evaluate(() => visualViewport.scale)) - 1) <
            0.02,
          "Double tap preserves application scale",
        );
        await add(page);
        await stateIs(page, "available");
        const summary = await page.locator("#booking-summary").boundingBox();
        const scale = await pinch(page, {
          x: summary.x + summary.width / 2,
          y: summary.y + summary.height / 2,
        });
        assert.ok(
          Math.abs(scale - 1) < 0.02,
          "Pinching the booking form preserves scale: " + scale,
        );
        await withinViewport(
          page,
          page.locator("#form-save"),
          "Save after touch gestures",
        );
        await noPageOverflow(page, "Booking after touch gestures");
      },
    );
  for (const device of [
    {
      name: "phone-short",
      viewport: { width: 390, height: 650 },
      mobile: true,
    },
    phone,
    {
      name: "phone-narrow",
      viewport: { width: 320, height: 568 },
      mobile: true,
    },
    {
      name: "phone-landscape",
      viewport: { width: 844, height: 390 },
      mobile: true,
    },
  ])
    await scenario(
      "schedule-first mobile layout shows three therapists and keeps all booking actions usable",
      device,
      async ({ page, f, open }) => {
        f.catalogue.rooms.push({
          id: "r3",
          name: "QA Second Couple",
          capacity: 2,
        });
        f.appointments = ["A", "B", "C"].flatMap((letter, index) => [
          {
            ...booking(
              "morning-" + letter,
              "t" + letter,
              index < 2 ? "r1" : "r2",
              index === 1 ? 1 : 0,
              600,
              60,
            ),
            requestedTherapistId: index === 1 ? "tB" : null,
          },
          booking(
            "afternoon-" + letter,
            "t" + letter,
            index < 2 ? "r1" : "r2",
            index === 1 ? 1 : 0,
            690,
            90,
          ),
        ]);
        await open();
        assert.equal(await mobileNavigation(page), true);
        assert.equal(
          await page.locator('.calendar-column[data-kind="therapist"]').count(),
          3,
          "Compact default is the therapist view",
        );
        assert.equal(
          await page.locator('.calendar-column[data-kind="room"]').count(),
          0,
        );
        assert.ok(
          Math.abs((await pixelsPerMinute(page)) - 1) < 0.001,
          "Compact mobile grid is 60px per hour",
        );
        const header = await page.locator("#calendar-headers").boundingBox();
        assert.ok(
          header.y + header.height <= 150,
          "Mobile schedule begins by 150px: " + JSON.stringify(header),
        );
        const grid = await withinViewport(
          page,
          page.locator("#calendar-scroll"),
          "Mobile schedule including sticky resource header",
        );
        if (device.viewport.height > 560)
          assert.ok(
            grid.height >= device.viewport.height * 0.6,
            "At least 60% of portrait screen belongs to the schedule: " +
              grid.height,
          );
        else
          assert.ok(
            grid.height >= 200,
            "Short landscape retains a usable scrollable schedule",
          );
        const axis = await page.locator(".time-axis").boundingBox();
        assert.ok(
          Math.abs(axis.width - 44) <= 1,
          "Compact time axis is 44px wide",
        );
        for (const letter of ["A", "B", "C"]) {
          const card = page.locator(`[data-appointment="morning-${letter}"]`);
          await withinViewport(page, card, "Visible morning booking " + letter);
          assert.match(await card.textContent(), /10:00.*11:00/);
        }
        for (const selector of [
          "#calendar-prev",
          "#calendar-date",
          "#calendar-next",
          "#calendar-view-options",
          "#mobile-add",
          "#mobile-more",
        ]) {
          const rect = await withinViewport(
            page,
            page.locator(selector),
            "Touch action " + selector,
          );
          assert.ok(
            rect.height >= 44 && rect.width >= 44,
            "Touch action meets 44px target: " + selector,
          );
        }
        await editableFonts(
          page,
          ".calendar-date-controls",
          "Compact calendar date",
        );
        await noPageOverflow(page, "Schedule-first calendar");
        await capture(page, `${device.name}-schedule-first-three-therapists`);
        await selectMode(page, "rooms");
        const couple = await page.locator('[data-resource="r1"]').boundingBox();
        const single = await page.locator('[data-resource="r2"]').boundingBox();
        assert.ok(
          Math.abs(couple.width - single.width) <= 1,
          "Room columns have equal widths regardless of table capacity",
        );
        await capture(page, `${device.name}-schedule-first-room-tables`);
        await openAdd(page, "appointment");
        await page.locator("#appointment-form").waitFor();
        await control(page, "duration").fill("90");
        await control(page, "note").fill("Fictional compact-screen note");
        await bookingLayout(page);
        const save = await withinViewport(
          page,
          page.locator("#form-save"),
          "Save above the bottom navigation",
        );
        assert.equal(
          await page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest("#form-save")?.id,
            { x: save.x + save.width / 2, y: save.y + save.height / 2 },
          ),
          "form-save",
          "Mobile navigation never covers modal Save",
        );
        await noPageOverflow(page, "Compact booking drawer");
        await page.locator("#form-cancel").click();
        assert.equal(f.writes.length, 0);
        f.catalogue.services = [];
        await open();
        await page.locator("#calendar-treatment-setup").waitFor();
        await page.locator('[data-resource="tA"]').waitFor();
        const emptyHeader = await page
          .locator("#calendar-headers")
          .boundingBox();
        assert.ok(
          emptyHeader.y + emptyHeader.height <= 190,
          "Setup guidance leaves schedule beginning by 190px",
        );
        const emptyGrid = await withinViewport(
          page,
          page.locator("#calendar-scroll"),
          "Schedule with empty-treatment guidance",
        );
        if (device.viewport.height > 560)
          assert.ok(
            emptyGrid.height >= device.viewport.height * 0.6,
            "Empty setup still reserves 60% portrait height for calendar including resource header",
          );
        await withinViewport(
          page,
          page.locator("#calendar-treatment-add"),
          "Reachable first-treatment action",
        );
        await capture(page, `${device.name}-schedule-first-empty-catalogue`);
      },
    );
  for (const role of ["owner", "reception", "therapist"])
    await scenario(
      `${role} mobile menus expose permitted routes and return keyboard focus`,
      phone,
      async ({ page, f, open }) => {
        f.role = role;
        f.appointments = [booking("private-menu-source", "tA", "r1", 0)];
        await open();
        await page.locator("#mobile-more").click();
        assert.equal(await page.locator("#drawer-title").textContent(), "Menu");
        const routes = await page
          .locator("#drawer [data-mobile-page]")
          .evaluateAll((nodes) =>
            nodes.map((el) => el.dataset.mobilePage).sort(),
          );
        const expected =
          role === "owner"
            ? [
                "dashboard",
                "calendar",
                "clients",
                "team",
                "services",
                "sales",
                "reports",
                "users",
              ]
            : role === "reception"
              ? ["calendar", "clients"]
              : ["calendar"];
        assert.deepEqual(routes, expected.sort());
        assert.doesNotMatch(
          await page.locator("#drawer").textContent(),
          /Fictional QA Client|Fixture only|4700|470,000/,
        );
        await capture(page, `${role}-mobile-more-menu-top`);
        for (const id of ["mobile-change-password", "mobile-sign-out"]) {
          await page.locator("#" + id).scrollIntoViewIfNeeded();
          await withinViewport(
            page,
            page.locator("#" + id),
            "Reachable account action " + id,
          );
        }
        await capture(page, `${role}-mobile-more-menu`);
        await page.keyboard.press("Escape");
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          "mobile-more",
        );
        await page.locator("#calendar-view-options").click();
        assert.equal(
          await page.locator("#drawer-title").textContent(),
          "Calendar view",
        );
        assert.match(await page.locator("#drawer").textContent(), /QA Massage/);
        await page.keyboard.press("Escape");
        await page.locator("#drawer").waitFor({ state: "hidden" });
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          "calendar-view-options",
        );
        if (role !== "therapist") {
          await page.locator("#mobile-add").click();
          assert.equal(
            await page.locator("#drawer-title").textContent(),
            "Add to calendar",
          );
          for (const id of ["mobile-add-appointment", "mobile-add-block"])
            await withinViewport(
              page,
              page.locator("#" + id),
              "Add choice " + id,
            );
          await page.keyboard.press("Escape");
          await page.locator("#drawer").waitFor({ state: "hidden" });
          assert.equal(
            await page.evaluate(() => document.activeElement.id),
            "mobile-add",
          );
          await navigate(page, "clients");
          await page.locator("#client-search").waitFor();
          await navigate(page, "calendar");
          await page.locator("#calendar-grid").waitFor();
        } else {
          assert.equal(await page.locator("#mobile-add").isVisible(), false);
          assert.equal(
            await page
              .locator('#mobile-navigation [data-mobile-page="clients"]')
              .isVisible(),
            false,
          );
        }
        assert.equal(f.writes.length + f.blockWrites.length, 0);
      },
    );
  await scenario(
    "resizing preserves a selected unsaved mobile move and converts idle logical scroll density",
    phone,
    async ({ page, f, open }) => {
      denseSchedule(f);
      await open();
      await denseView(page);
      await longPress(page, page.locator('[data-appointment="dense-target"]'));
      await shiftTouchDraft(page);
      assert.ok(Math.abs((await pixelsPerMinute(page)) - 1) < 0.001);
      await page.setViewportSize({ width: 820, height: 1180 });
      await renderedFrames(page);
      await page.locator("#calendar-reschedule-bar").waitFor();
      assert.match(
        await page.locator("#calendar-reschedule-time").textContent(),
        /18:55–20:25.*90 min/,
      );
      assert.ok(
        Math.abs((await pixelsPerMinute(page)) - 1) < 0.001,
        "Density remains frozen until the current draft resolves",
      );
      assert.equal(f.writes.length, 0);
      await capture(page, "tablet-resize-preserved-mobile-draft");
      await page.locator("#calendar-reschedule-cancel").click();
      await page.waitForFunction(
        () =>
          Math.abs(
            document.querySelector(".calendar-column").getBoundingClientRect()
              .height /
              1440 -
              2,
          ) < 0.001,
      );
      assert.equal(f.writes.length, 0, "Resize and cancel do not save a move");
      assert.match(
        await page
          .locator('[data-appointment="dense-target"] .event-time')
          .first()
          .textContent(),
        /19:00–20:30/,
      );
      const logical = await page
        .locator("#calendar-scroll")
        .evaluate((el) => el.scrollTop / 2);
      await page.setViewportSize(phone.viewport);
      await page.waitForFunction(
        () =>
          Math.abs(
            document.querySelector(".calendar-column").getBoundingClientRect()
              .height /
              1440 -
              1,
          ) < 0.001,
      );
      const restored = await page
        .locator("#calendar-scroll")
        .evaluate((el) => el.scrollTop);
      assert.ok(
        Math.abs(restored - logical) <= 2,
        "Idle orientation preserves visible logical time, not raw pixels: " +
          JSON.stringify({ logical, restored }),
      );
      await withinViewport(
        page,
        page.locator("#calendar-scroll"),
        "Restored phone schedule",
      );
    },
  );
  for (const device of [
    desktop,
    tablet,
    phone,
    {
      name: "phone-narrow",
      viewport: { width: 320, height: 568 },
      mobile: true,
    },
  ])
    await scenario(
      "three equal room columns use full-width lone cards and split only real overlaps",
      device,
      async ({ page, f, open }) => {
        f.catalogue.rooms = [
          { id: "r1", name: "QA Garden", capacity: 2 },
          { id: "r2", name: "QA Orchid", capacity: 2 },
          { id: "r3", name: "QA Quiet", capacity: 1 },
        ];
        for (const letter of ["D", "E"])
          f.catalogue.therapists.push({
            ...f.catalogue.therapists[0],
            id: "t" + letter,
            name: "QA Therapist " + letter,
          });
        f.appointments = [
          booking("room-lone-table-two", "tA", "r1", 1, 600, 60),
          booking("room-adjacent", "tA", "r1", 0, 660, 30),
          booking("room-overlap-a", "tA", "r1", 0, 690, 45),
          booking("room-overlap-b", "tE", "r1", 1, 690, 45),
          booking("room-after-overlap", "tA", "r1", 1, 735, 45),
          booking("other-overlap-a", "tB", "r2", 0, 600, 60),
          booking("other-overlap-b", "tC", "r2", 1, 600, 60),
          booking("single-room", "tD", "r3", 0, 600, 60),
        ];
        f.blocks = [
          calendarBlock("whole-room-note", {
            resourceId: "r3",
            bed: null,
            start: 690,
            duration: 45,
            blocksAvailability: false,
            title: "QA follow-up reminder",
          }),
        ];
        await open();
        await selectMode(page, "rooms");
        const columns = [];
        for (const id of ["r1", "r2", "r3"]) {
          const column = page.locator(`[data-resource="${id}"]`);
          const box = await column.boundingBox();
          columns.push(box);
          const visible = await page.evaluate(
            ({ x, width }) => x >= -1 && x + width <= innerWidth + 1,
            box,
          );
          assert.equal(
            visible,
            true,
            "All three unified room columns fit the viewport: " + id,
          );
        }
        assert.ok(
          Math.max(...columns.map((x) => x.width)) -
            Math.min(...columns.map((x) => x.width)) <=
            1,
          "Two-table and one-table rooms use equal widths",
        );
        assert.equal(
          await page.locator(".calendar-column.couple").count(),
          0,
          "Room columns have no permanent table-half class",
        );
        const dividers = await page
          .locator(".calendar-column")
          .evaluateAll((nodes) =>
            nodes.map((el) => ({
              content: getComputedStyle(el, "::after").content,
              border: getComputedStyle(el, "::after").borderLeftWidth,
            })),
          );
        assert.ok(
          dividers.every(
            (style) =>
              ["none", "normal"].includes(style.content) &&
              parseFloat(style.border) === 0,
          ),
          "Room columns have no permanent pseudo-element table divider: " +
            JSON.stringify(dividers),
        );
        const full = async (id, roomId = "r1") => {
          const card = page.locator(`[data-appointment="${id}"]`);
          const box = await withinViewport(
            page,
            card,
            "Full-width room appointment " + id,
          );
          const column = await page
            .locator(`[data-resource="${roomId}"]`)
            .boundingBox();
          assert.ok(
            Math.abs(box.x - column.x - 3) <= 1 &&
              Math.abs(box.width - column.width + 6) <= 1,
            "Only simultaneous bookings narrow a card: " + id,
          );
        };
        await full("room-lone-table-two");
        await full("room-adjacent");
        await full("room-after-overlap");
        await full("single-room", "r3");
        for (const prefix of ["room", "other"]) {
          const a = await withinViewport(
            page,
            page.locator(`[data-appointment="${prefix}-overlap-a"]`),
            "First overlapping appointment",
          );
          const b = await withinViewport(
            page,
            page.locator(`[data-appointment="${prefix}-overlap-b"]`),
            "Second overlapping appointment",
          );
          assert.ok(
            Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1,
          );
          assert.ok(
            a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1,
            "Different tables occupy separate lanes only while simultaneous",
          );
          if (device.mobile) {
            for (const suffix of ["a", "b"]) {
              const clocks = await page
                .locator(`[data-appointment="${prefix}-overlap-${suffix}"]`)
                .evaluate((card) =>
                  [".event-start", ".event-end"].map((selector) => {
                    const el = card.querySelector(selector),
                      range = document.createRange();
                    range.selectNodeContents(el);
                    const text = range.getBoundingClientRect(),
                      bounds = card.getBoundingClientRect();
                    return {
                      text: el.textContent,
                      visible:
                        getComputedStyle(el).display !== "none" &&
                        text.left >= bounds.left - 1 &&
                        text.right <= bounds.right + 1 &&
                        text.bottom <= bounds.bottom + 1,
                    };
                  }),
                );
              assert.ok(
                clocks.every((clock) => clock.visible),
                "Start and end clocks fit actual narrow overlapping cards: " +
                  JSON.stringify(clocks),
              );
            }
          }
        }
        const note = page.locator('[data-calendar-block="whole-room-note"]');
        assert.equal(
          await note.count(),
          1,
          "Whole-room notes render once instead of once per table",
        );
        const noteBox = await withinViewport(page, note, "Whole-room note");
        assert.ok(Math.abs(noteBox.width - columns[2].width + 6) <= 1);
        await noPageOverflow(page, "Three-room unified calendar");
        await capture(page, `${device.name}-unified-three-room-calendar`);
        await page.locator('[data-appointment="room-lone-table-two"]').click();
        await page.locator("#appointment-summary-edit").click();
        await page.locator("#appointment-form").waitFor();
        assert.equal(
          await control(page, "bed").inputValue(),
          "1",
          "Full-width display preserves the real Table 2 assignment",
        );
        await page.locator("#form-cancel").click();
        assert.equal(f.writes.length + f.blockWrites.length, 0);
      },
    );
  for (const device of [desktop, phone])
    await scenario(
      "either side of an empty room selects the room and later allocates its free table",
      device,
      async ({ page, f, open }) => {
        f.appointments = [booking("later-table-one", "tA", "r1", 0, 720, 60)];
        await open();
        for (const side of [0, 1]) {
          await roomPoint(page, device, 600, "r1", side);
          assert.equal(
            await page.locator("#calendar-slot-menu-resource").textContent(),
            "QA Couple",
          );
          await page.locator("#calendar-slot-add").click();
          await page.locator("#appointment-form").waitFor();
          await stateIs(page, "available");
          let values = await selected(page);
          assert.equal(values.roomId, "r1");
          assert.equal(
            values.bed,
            "0",
            "Pointer x does not lock Table 2 when Table 1 is free",
          );
          await control(page, "start").fill("12:00");
          await control(page, "start").press("Tab");
          await stateIs(page, "available");
          values = await selected(page);
          assert.equal(values.roomId, "r1");
          assert.equal(
            values.bed,
            "1",
            "Room-only selection can allocate Table 2 when Table 1 is busy",
          );
          await page.locator("#form-cancel").click();
        }
        assert.equal(f.writes.length, 0);
      },
    );
  await scenario(
    "unified room move selects free capacity independently of x and keeps cancel and conflict recovery",
    desktop,
    async ({ page, f, open }) => {
      f.appointments = [
        booking("room-move", "tA", "r2", 0, 1140, 90),
        booking("occupied-table-one", "tB", "r1", 0, 1135, 90),
      ];
      await open();
      await selectMode(page, "rooms");
      await page.locator("#calendar-scroll").evaluate(
        (el, top) => {
          el.scrollTop = top;
        },
        await pixelAt(page, 1080),
      );
      const move = async (fraction) => {
        await page.locator('[data-appointment="room-move"]').click();
        await page.locator("#appointment-summary-reschedule").click();
        const source = await bodyPoint(
          page.locator(
            '.calendar-reschedule-preview[data-appointment="room-move"]',
          ),
        );
        const destination = await page
          .locator('[data-resource="r1"]')
          .boundingBox();
        await page.mouse.move(source.x, source.y);
        await page.mouse.down();
        await page.mouse.move(
          destination.x + destination.width * fraction,
          source.y - 10,
          { steps: 8 },
        );
        await page.mouse.up();
        assert.match(
          await page.locator("#calendar-reschedule-time").textContent(),
          /18:55–20:25.*90 min/,
        );
        assert.match(
          await page.locator("#calendar-reschedule-resource").textContent(),
          /QA Couple.*Table 2/,
        );
        const preview = await page
          .locator('[data-resource="r1"] .calendar-reschedule-preview')
          .boundingBox();
        const busy = await page
          .locator('[data-appointment="occupied-table-one"]')
          .boundingBox();
        assert.ok(
          preview.x + preview.width <= busy.x + 1 ||
            busy.x + busy.width <= preview.x + 1,
          "Provisional moved card stays beside its concurrent booking",
        );
      };
      await move(0.25);
      await page.locator("#calendar-reschedule-cancel").click();
      const restoredNeighbor = page.locator(
        '[data-appointment="occupied-table-one"]',
      );
      const restoredBox = await restoredNeighbor.boundingBox();
      const restoredRoom = await page
        .locator('[data-resource="r1"]')
        .boundingBox();
      assert.ok(
        Math.abs(restoredBox.x - restoredRoom.x - 3) <= 1 &&
          Math.abs(restoredBox.width - restoredRoom.width + 6) <= 1,
        "Cancel restores the neighbor's original full room width",
      );
      assert.equal(
        await restoredNeighbor.evaluate((el) =>
          el.classList.contains("is-overlapping"),
        ),
        false,
        "Cancel also restores the neighbor's time-label layout",
      );
      assert.equal(f.writes.length, 0);
      assert.equal(
        f.appointments.find((a) => a.id === "room-move").roomId,
        "r2",
      );
      await move(0.75);
      f.failNextWrite = true;
      await page.locator("#calendar-reschedule-save").click();
      await page
        .locator("#calendar-reschedule-error")
        .filter({ hasText: "already booked" })
        .waitFor();
      assert.equal(
        await page.locator("#calendar-reschedule-bar").isVisible(),
        true,
      );
      assert.equal(
        f.appointments.find((a) => a.id === "room-move").roomId,
        "r2",
      );
      await page.locator("#calendar-reschedule-save").click();
      await page
        .locator("#calendar-reschedule-bar")
        .waitFor({ state: "hidden" });
      assert.equal(
        f.writes.length,
        2,
        "One rejected attempt and one explicit retry",
      );
      for (const write of f.writes) {
        assert.equal(write.method, "PUT");
        assert.equal(write.body.roomId, "r1");
        assert.equal(write.body.bed, 1);
        assert.equal(write.body.start, 1135);
        assert.equal(write.body.duration, 90);
      }
    },
  );
  assert.ok(passed > 0, "No browser acceptance scenarios ran");
  assert.deepEqual(
    failures,
    [],
    `${failures.length} browser acceptance scenario(s) failed; ${passed} passed`,
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `Calendar browser acceptance: ${passed} passed. Chromium emulation only; physical touch devices are not certified.`,
);
