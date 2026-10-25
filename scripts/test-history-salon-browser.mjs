// Independent rendered acceptance: production app/assets, fictional loopback APIs only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildReport, reportOptions } from "../src/reports.mjs";

if (!process.env.REI_PLAYWRIGHT_MODULE)
  throw new Error(
    "Set REI_PLAYWRIGHT_MODULE to the isolated Playwright index.mjs.",
  );
const { chromium } = await import(
  pathToFileURL(resolve(process.env.REI_PLAYWRIGHT_MODULE)).href
);
const publicRoot = resolve("public"),
  fixtures = new Map();
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const desktop = { name: "desktop", viewport: { width: 1440, height: 1050 } };
const phone = {
  name: "phone",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
const catalogue = {
  therapists: [
    {
      id: "existing-therapist",
      name: "Ari Example",
      active: false,
      version: 4,
      weekly: Array.from({ length: 7 }, () => ({
        enabled: false,
        start: 600,
        end: 1320,
      })),
      timeOff: [],
    },
  ],
  services: [
    {
      id: "existing-service",
      name: "Existing treatment",
      duration: 60,
      priceMinor: 640000,
      priceCents: 640000,
      active: true,
      version: 3,
    },
  ],
  rooms: [
    {
      id: "room-one",
      name: "Example room",
      capacity: 1,
      active: true,
      version: 1,
    },
  ],
};
function candidate(index) {
  return {
    key: `service-${index}`,
    kind: "service",
    source: "fictional-source",
    label: `Historical treatment ${String(index).padStart(2, "0")}`,
    duration: 60,
    count: 5,
    existingLink: null,
    match: null,
    matchCandidates: [],
    issues: [],
    latestNet: {
      raw: "4500",
      amountMinor: 450000,
      currency: "RSD",
      minorUnitDigits: 2,
      basis: "draft-assumption",
      date: "2026-01-15",
    },
  };
}
function preview() {
  const services = Array.from({ length: 34 }, (_, i) => candidate(i));
  services[0].existingLink = "existing-service";
  services[0].match = {
    id: "existing-service",
    name: "Existing treatment",
    version: 3,
  };
  services[1].label = "Unknown price <img src=x onerror=alert(1)>";
  services[1].latestNet = {
    raw: "",
    amountMinor: null,
    currency: null,
    minorUnitDigits: null,
    basis: "unknown",
    date: "2026-01-16",
  };
  services[2].label = "Known JPY treatment";
  services[2].latestNet = {
    raw: "5000",
    amountMinor: 5000,
    currency: "JPY",
    minorUnitDigits: 0,
    basis: "source",
    date: "2026-01-17",
  };
  services[3].label = "Four decimal RSD treatment";
  services[3].latestNet = {
    raw: "12.3456",
    amountMinor: 123456,
    currency: "RSD",
    minorUnitDigits: 4,
    basis: "source",
    date: "2026-01-18",
  };
  return {
    previewId: "review-1",
    token: "fictional-review-token",
    fingerprint: "a".repeat(64),
    archiveRevision: 7,
    catalogueRevision: 4,
    summary: { rows: 337, from: "2025-11-01", to: "2026-01-31" },
    settings: {
      currency: "RSD",
      minorUnitDigits: 2,
      timeZone: "Europe/Belgrade",
      version: 0,
    },
    settingsConfirmed: false,
    services,
    therapists: [
      {
        key: "therapist-1",
        kind: "therapist",
        source: "fictional-source",
        label: "Former Example Therapist",
        count: 337,
        duration: null,
        existingLink: null,
        match: null,
        matchCandidates: [],
        issues: [],
      },
    ],
    catalogue: structuredClone(catalogue),
    warnings: ["Draft source settings do not change saved evidence."],
  };
}
function reportRows() {
  const historical = {
    id: "history:example-new",
    report_source: "history",
    source: "fictional-source",
    visit_key: '["fictional-source","ref-001"]',
    therapist_id: "history-therapist",
    therapist_name: "Former Example Therapist",
    service_id: "history-service",
    service_name: "Archived example treatment",
    date: "2026-01-15",
    start_minute: 600,
    duration: 60,
    status: "booked",
    source_status: "New",
    completion_state: "unknown",
    counts_as_visit: true,
    request_state: "unknown",
    source_net_sales_minor: 450000,
    currency: "RSD",
    minor_unit_digits: 2,
    money_basis: "source",
    source_time_zone: null,
    native_overlap: false,
  };
  const native = {
    id: "native-example-done",
    therapist_id: "existing-therapist",
    therapist_name: "Ari Example",
    service_id: "existing-service",
    service_name: "Existing treatment",
    date: "2026-01-15",
    start_minute: 900,
    duration: 60,
    created_at: "2026-01-01T10:00:00Z",
    cancelled_at: null,
    gross_cents: 120000,
    net_cents: 120000,
    status: "done",
    requested_therapist_id: null,
    bonus_regular_cents_hour: 10000,
    bonus_requested_cents_hour: 20000,
  };
  return [
    native,
    historical,
    {
      ...historical,
      id: "history:example-cancelled",
      visit_key: "ref-002",
      source_status: "Cancelled",
      status: "cancelled",
      completion_state: "not_completed",
      counts_as_visit: false,
    },
    {
      ...historical,
      id: "history:example-no-show",
      visit_key: "ref-003",
      source_status: "No Show",
      status: "no_show",
      completion_state: "not_completed",
      counts_as_visit: false,
    },
  ];
}
function fixture() {
  return {
    role: "owner",
    preview: preview(),
    requests: [],
    writes: [],
    unexpected: [],
    receipts: new Map(),
    commits: 0,
    replies: [],
    delays: new Map(),
    failures: new Map(),
    waits: [],
    lostApply: false,
  };
}
function deferred() {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
}
async function api(f, url, method, body, json) {
  const path = url.pathname;
  if (path === "/api/session")
    return json({
      user: { id: "fictional-owner", name: "Fictional Owner", role: f.role },
      csrf: "fictional-csrf",
      mustChangePassword: false,
    });
  if (path === "/api/catalogue") return json(catalogue);
  if (path === "/api/appointments" && method === "GET")
    return json({ appointments: [], blocks: [] });
  if (path === "/api/clients" && method === "GET") return json({ clients: [] });
  if (path === "/api/reports/appointments") {
    const report = buildReport(
      f.withHistoryReports ? reportRows() : [],
      reportOptions(url.searchParams),
    );
    report.history = {
      totalRows: 337,
      minDate: "2025-11-01",
      maxDate: "2026-01-31",
      loadedRows: 0,
      nativeOverlapRows: 0,
      ambiguousMoneyRows: 0,
    };
    report.filters = {
      therapists: [
        ...catalogue.therapists,
        { id: "history-therapist", name: "Former Example Therapist" },
      ],
      services: [
        ...catalogue.services,
        {
          id: "history-service",
          name: "Archived example treatment",
          duration: 60,
        },
      ],
    };
    return json(report);
  }
  if (path === "/api/history/previews") return json({ previews: [] });
  if (path === "/api/history/jobs") return json({ jobs: [] });
  if (path === "/api/history/salon/preview" && method === "GET") {
    assert.equal(f.role, "owner");
    assert.equal(url.searchParams.get("currency"), "RSD");
    assert.equal(url.searchParams.get("minorUnitDigits"), "2");
    assert.equal(url.searchParams.get("timeZone"), "Europe/Belgrade");
    return json(f.preview);
  }
  if (path === "/api/history/salon/apply" && method === "POST") {
    assert.equal(body.previewId, f.preview.previewId);
    assert.equal(body.token, f.preview.token);
    assert.equal(body.fingerprint, f.preview.fingerprint);
    assert.equal(body.acknowledgeReview, true);
    assert.deepEqual(body.settings, {
      currency: "RSD",
      minorUnitDigits: 2,
      timeZone: "Europe/Belgrade",
    });
    const old = f.receipts.get(body.requestId);
    if (old) {
      assert.deepEqual(
        old.body,
        body,
        "Exact receipt retry preserves the whole body",
      );
      return json(old.result);
    }
    assert.deepEqual(
      body.choices.map((c) => c.key).sort(),
      [...f.preview.services, ...f.preview.therapists].map((c) => c.key).sort(),
    );
    const result = {
      createdServices: body.choices.filter(
        (c) => c.action === "create" && c.key.startsWith("service-"),
      ).length,
      createdTherapists: body.choices.filter(
        (c) => c.action === "create" && c.key.startsWith("therapist-"),
      ).length,
      skipped: body.choices.filter((c) => c.action === "skip").length,
    };
    f.receipts.set(body.requestId, { body: structuredClone(body), result });
    f.commits++;
    if (f.lostApply) {
      f.lostApply = false;
      return json(
        { error: "Simulated lost confirmation response. Retry unchanged." },
        503,
      );
    }
    return json(result);
  }
  f.unexpected.push(`${method} ${path}`);
  return json({ error: "Unexpected fictional route" }, 404);
}
let origin;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", csp);
  const url = new URL(req.url, "http://localhost"),
    f = fixtures.get(req.headers["x-rei-fixture"]);
  const json = (data, status = 200) => {
    if (f) f.replies.push({ path: url.pathname, status });
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    if (url.pathname.startsWith("/api/")) {
      assert.ok(f, "Only fictional sessions are accepted");
      let raw = "";
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : undefined;
      f.requests.push({
        path: url.pathname,
        query: url.search,
        method: req.method,
        body,
      });
      if (!["GET", "HEAD"].includes(req.method)) {
        assert.equal(req.headers["x-csrf-token"], "fictional-csrf");
        assert.equal(req.headers.origin, origin);
        f.writes.push({ path: url.pathname, method: req.method, body });
      }
      const key = `${req.method} ${url.pathname}`;
      if (f.delays.has(key)) await f.delays.get(key).promise;
      const failure = f.failures.get(key);
      if (failure) {
        f.failures.delete(key);
        return json({ error: failure.message }, failure.status);
      }
      return await api(f, url, req.method, body, json);
    }
    const file = resolve(
      publicRoot,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    assert.ok(file.startsWith(publicRoot + sep));
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
        }[extname(file)] || "application/octet-stream",
    });
    res.end(await readFile(file));
  } catch (e) {
    f?.unexpected.push(e.message);
    if (!res.headersSent)
      json({ error: "Fictional server assertion failed" }, 500);
    else res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.REI_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.REI_CHROMIUM_EXECUTABLE }
    : {}),
});
let passed = 0;
const failures = [];
async function capture(page, name) {
  if (!process.env.REI_BROWSER_ARTIFACTS) return;
  await mkdir(resolve(process.env.REI_BROWSER_ARTIFACTS), { recursive: true });
  await page.screenshot({
    path: resolve(process.env.REI_BROWSER_ARTIFACTS, name + ".png"),
  });
}
async function navigate(page, target) {
  const desktopControl = page.locator(`nav [data-page="${target}"]`);
  if (await desktopControl.isVisible()) return desktopControl.click();
  const mobileControl = page.locator(
    `#mobile-navigation [data-mobile-page="${target}"]`,
  );
  if (await mobileControl.isVisible()) return mobileControl.click();
  await page.locator("#mobile-more").click();
  await page.locator(`#drawer [data-mobile-page="${target}"]`).click();
}
async function openApp(page) {
  await page.goto(origin);
  await page.locator("#app").waitFor({ state: "visible" });
}
async function openSalon(page, wait = true) {
  await openApp(page);
  await navigate(page, "clients");
  await page.locator("#history-preview-open").click();
  await page.locator("#history-salon-open").click();
  if (wait) await page.locator("#salon-form").waitFor();
}
const card = (page, index) =>
  page.locator(`.salon-candidate[data-candidate="${index}"]`);
async function acknowledge(page) {
  await page.locator("#salon-source-confirm").check();
  await page.locator("#salon-review-confirm").check();
}
async function saved(page) {
  await page
    .getByRole("heading", { name: "Salon setup saved", exact: true })
    .waitFor();
}
async function visibleControl(page, locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box, label);
  const viewport = page.viewportSize();
  assert.ok(
    box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    `${label} fits the viewport: ${JSON.stringify(box)}`,
  );
  const unobscured = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      b.x + b.width / 2,
      b.y + b.height / 2,
    );
    return top === el || el.contains(top);
  });
  assert.ok(unobscured, `${label} is not obscured by bottom navigation`);
}
async function noOverflow(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "No horizontal page overflow",
  );
}
async function scenario(name, device, run) {
  const f = fixture(),
    id = `${device.name}-${name}`;
  fixtures.set(id, f);
  const context = await browser.newContext({
    viewport: device.viewport,
    isMobile: !!device.isMobile,
    hasTouch: !!device.hasTouch,
    timezoneId: "Europe/Belgrade",
    extraHTTPHeaders: { "x-rei-fixture": id },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await run({ page, f });
    assert.deepEqual(errors, [], "No production browser exceptions");
    assert.deepEqual(f.unexpected, [], "Only expected fictional API routes");
    assert.ok(
      f.writes.every((r) => r.path === "/api/history/salon/apply"),
      "Setup never writes clients, archive rows, appointments or accounts directly",
    );
    passed++;
    console.log(`PASS ${device.name}: ${name}`);
  } catch (e) {
    failures.push(`${device.name}: ${name}: ${e.message}`);
    console.error(`FAIL ${device.name}: ${name}\n${e.stack}`);
    await capture(page, id.replace(/[^a-z0-9]+/gi, "-") + "-failure").catch(
      () => {},
    );
  } finally {
    for (const gate of f.delays.values()) gate.release();
    for (const gate of f.waits) gate.release();
    await context.close();
    fixtures.delete(id);
  }
}
try {
  for (const device of [desktop, phone])
    await scenario(
      "saved archive choices survive pagination and require explicit current prices",
      device,
      async ({ page, f }) => {
        await openSalon(page);
        assert.equal(
          f.writes.length,
          0,
          "Opening a saved archive never applies automatically",
        );
        assert.equal(
          f.requests.some((r) => /upload|finalize/.test(r.path)),
          false,
          "No file reupload or preview preparation",
        );
        assert.match(
          await page.locator(".history-salon").innerText(),
          /337 saved rows/,
        );
        assert.equal(
          await card(page, 0).locator("[data-field=action]").isDisabled(),
          true,
        );
        assert.equal(
          await card(page, 0).locator("[data-field=entityId]").inputValue(),
          "existing-service",
        );
        assert.equal(
          await card(page, 1).locator("img").count(),
          0,
          "Untrusted source label is escaped",
        );
        for (const index of [1, 2, 3])
          assert.equal(
            await card(page, index).locator("[data-field=action]").inputValue(),
            "skip",
          );
        assert.match(await card(page, 2).innerText(), /5000 JPY/);
        assert.match(await card(page, 3).innerText(), /12\.3456 RSD/);
        await card(page, 1)
          .locator("[data-field=action]")
          .selectOption("create");
        assert.equal(
          await card(page, 1).locator("[data-field=price]").inputValue(),
          "",
        );
        await card(page, 4).locator("[data-field=price]").fill("6123.45");
        await page.locator("#salon-next").click();
        assert.match(
          await page.locator("#salon-page").innerText(),
          /31–34 of 34/,
        );
        await card(page, 1).locator("[data-field=action]").selectOption("skip");
        await page.locator("#salon-therapists").click();
        await card(page, 0)
          .locator("[data-field=name]")
          .fill("Reviewed Former Therapist");
        await acknowledge(page);
        await page.locator("#salon-save").click();
        await page.locator("#salon-error").waitFor({ state: "visible" });
        assert.match(
          await page.locator("#salon-error").innerText(),
          /current price|duration/,
        );
        assert.equal(
          f.writes.length,
          0,
          "Invalid price on another page prevents the entire apply",
        );
        await page.locator("#salon-services").click();
        assert.equal(
          await card(page, 4).locator("[data-field=price]").inputValue(),
          "6123.45",
        );
        await card(page, 1)
          .locator("[data-field=name]")
          .fill("Reviewed Example Treatment");
        await card(page, 1).locator("[data-field=price]").fill("5200");
        assert.equal(
          await page.locator("#salon-review-confirm").isChecked(),
          false,
          "An edit invalidates the previous acknowledgement",
        );
        await page.locator("#salon-search").fill("Historical treatment 04");
        assert.equal(
          await card(page, 0).locator("[data-field=price]").inputValue(),
          "6123.45",
        );
        await noOverflow(page);
        await capture(page, device.name + "-salon-reviewed-price");
        await acknowledge(page);
        await visibleControl(page, page.locator("#salon-save"), "Save setup");
        await capture(page, device.name + "-salon-confirmation");
        await page.locator("#salon-save").click();
        await saved(page);
        assert.equal(f.commits, 1);
        const body = f.writes[0].body,
          choices = new Map(body.choices.map((c) => [c.key, c]));
        assert.deepEqual(choices.get("service-0"), {
          key: "service-0",
          action: "link",
          entityId: "existing-service",
        });
        assert.equal(choices.get("service-1").priceMinor, 520000);
        assert.equal(choices.get("service-4").priceMinor, 612345);
        assert.equal(choices.get("service-31").action, "skip");
        assert.deepEqual(
          choices.get("therapist-1"),
          {
            key: "therapist-1",
            action: "create",
            name: "Reviewed Former Therapist",
          },
          "No account, bonus or activation fields are inferred",
        );
        await noOverflow(page);
        await capture(page, device.name + "-salon-saved");
      },
    );
  await scenario(
    "lost apply acknowledgement retries the exact reviewed body once",
    desktop,
    async ({ page, f }) => {
      f.lostApply = true;
      await openSalon(page);
      await acknowledge(page);
      await page.locator("#salon-save").click();
      await page.locator("#salon-error").waitFor({ state: "visible" });
      assert.equal(f.commits, 1);
      await page.locator("#salon-save").click();
      await saved(page);
      assert.equal(f.writes.length, 2);
      assert.deepEqual(f.writes[0].body, f.writes[1].body);
      assert.equal(f.commits, 1);
    },
  );
  await scenario(
    "stale review refreshes tokens and requires a fresh confirmation",
    phone,
    async ({ page, f }) => {
      await openSalon(page);
      f.failures.set("POST /api/history/salon/apply", {
        status: 409,
        message: "Catalogue changed. Refresh review.",
      });
      await acknowledge(page);
      await page.locator("#salon-save").click();
      await page.locator("#salon-error").waitFor({ state: "visible" });
      assert.equal(f.commits, 0);
      f.preview.previewId = "review-2";
      f.preview.token = "new-fictional-token";
      f.preview.fingerprint = "b".repeat(64);
      await page.locator("#salon-refresh").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#salon-source-confirm")?.checked === false &&
          document
            .querySelector(".history-salon")
            ?.getAttribute("aria-busy") !== "true",
      );
      assert.equal(
        await page.locator("#salon-review-confirm").isChecked(),
        false,
      );
      assert.equal(f.writes.length, 1);
      await acknowledge(page);
      await page.locator("#salon-save").click();
      await saved(page);
      assert.notEqual(f.writes[0].body.requestId, f.writes[1].body.requestId);
      assert.equal(f.writes[1].body.previewId, "review-2");
    },
  );
  await scenario(
    "load retry and navigation discard late review responses",
    desktop,
    async ({ page, f }) => {
      f.failures.set("GET /api/history/salon/preview", {
        status: 503,
        message: "Temporary read failure",
      });
      await openSalon(page, false);
      await page.locator("#salon-reload").waitFor();
      await page.locator("#salon-reload").click();
      await page.locator("#salon-form").waitFor();
      const gate = deferred();
      f.delays.set("GET /api/history/salon/preview", gate);
      const requestSeen = page.waitForRequest((r) =>
        r.url().includes("/history/salon/preview"),
      );
      await page.locator("#salon-refresh").click();
      await requestSeen;
      await navigate(page, "clients");
      await page.locator("#history-preview-open").waitFor();
      const responseSeen = page.waitForResponse((r) =>
        r.url().includes("/history/salon/preview"),
      );
      gate.release();
      await responseSeen;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert.equal(await page.locator("#salon-form").count(), 0);
      assert.equal(f.writes.length, 0);
    },
  );
  await scenario(
    "empty permanent archive directs to import without pretending a preview is saved history",
    phone,
    async ({ page, f }) => {
      f.preview.summary = { rows: 0, from: null, to: null };
      f.preview.services = [];
      f.preview.therapists = [];
      await openSalon(page, false);
      await page.locator("#salon-import").waitFor();
      assert.match(
        await page.locator("#salon-content").innerText(),
        /confirm the import first/,
      );
      assert.equal(await page.locator("#salon-save").count(), 0);
      assert.equal(f.writes.length, 0);
      await visibleControl(
        page,
        page.locator("#salon-import"),
        "Open history import",
      );
      await capture(page, "phone-salon-empty-history");
      await page.locator("#salon-import").click();
      await page.locator("#history-csv").waitFor();
    },
  );
  for (const device of [desktop, phone])
    await scenario(
      "past reports expose imported dates, original statuses and separate native money",
      device,
      async ({ page, f }) => {
        f.withHistoryReports = true;
        await openSalon(page);
        await page.locator("#salon-reports").click();
        await page.locator("#report-show-history-dates").waitFor();
        assert.equal(
          await page.locator("#report-filter [name=preset]").inputValue(),
          "last30",
        );
        assert.equal(
          await page.locator("#report-filter [name=source]").inputValue(),
          "all",
        );
        assert.match(
          await page.locator("#report-period").innerText(),
          /2025-11-01.*2026-01-31/,
        );
        await page.locator("#report-show-history-dates").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#report-metrics")
            ?.textContent.includes("Imported visits"),
        );
        assert.equal(
          await page.locator("#report-filter [name=from]").inputValue(),
          "2025-11-01",
        );
        assert.equal(
          await page.locator("#report-filter [name=to]").inputValue(),
          "2026-01-31",
        );
        const metric = (label) =>
          page
            .locator(".report-metric")
            .filter({ has: page.locator("span", { hasText: label }) })
            .locator("strong");
        assert.equal(await metric("Included treatments").innerText(), "2");
        assert.equal(await metric("Imported visits").innerText(), "1");
        assert.match(
          await metric("Rei treatment revenue").innerText(),
          /^RSD\s+1,200(?:\.00)?$/,
        );
        assert.match(
          await metric("Imported source net sales").innerText(),
          /4,500\.00/,
        );
        await page.locator("[name=view]").selectOption("details");
        await page.locator("#report-table tbody tr").first().waitFor();
        const historicalRows = page
          .locator("#report-table tbody tr")
          .filter({ hasText: "Archived example treatment" });
        assert.equal(await historicalRows.count(), 3);
        for (const text of ["New", "Cancelled", "No Show"])
          assert.match(
            (await historicalRows.allInnerTexts()).join(" "),
            new RegExp(text),
          );
        assert.match(
          (await historicalRows.allInnerTexts()).join(" "),
          /Unavailable/,
        );
        assert.match(
          (await historicalRows.allInnerTexts()).join(" "),
          /Unknown/,
        );
        await page.locator("#report-metrics").scrollIntoViewIfNeeded();
        await noOverflow(page);
        await capture(page, device.name + "-reports-imported-source-metrics");
        await page
          .locator("#report-filter [name=source]")
          .selectOption("native");
        await page.locator("#report-filter button[type=submit]").click();
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#report-metrics")
              ?.textContent.includes("Imported visits"),
        );
        assert.equal(
          await page
            .locator("#report-table tbody tr")
            .filter({ hasText: "Archived example treatment" })
            .count(),
          0,
        );
        assert.equal(
          f.writes.length,
          0,
          "Reading existing history and reports performs no activation or import",
        );
      },
    );
  for (const role of ["reception", "therapist"])
    await scenario(
      `${role} has no owner setup entry or source money request`,
      phone,
      async ({ page, f }) => {
        f.role = role;
        await openApp(page);
        await page.locator("#calendar-grid").waitFor();
        if (role === "reception") {
          await navigate(page, "clients");
          await page.locator("#client-search").waitFor();
        }
        assert.equal(
          await page
            .locator(
              "#history-preview-open,#history-salon-open,#team-history,#service-history",
            )
            .count(),
          0,
        );
        await page.locator("#mobile-more").click();
        assert.equal(
          await page
            .locator(
              "#drawer [data-mobile-page=services],#drawer [data-mobile-page=team]",
            )
            .count(),
          0,
        );
        assert.equal(
          f.requests.some((r) => r.path.includes("/history/salon/")),
          false,
        );
        assert.equal(f.writes.length, 0);
      },
    );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `History salon browser acceptance: ${passed} passed, ${failures.length} failed`,
);
if (failures.length) throw new Error(failures.join("\n"));
