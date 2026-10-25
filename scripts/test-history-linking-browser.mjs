// Render the shipped linking module with fictional loopback API responses only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.REI_PLAYWRIGHT_MODULE)
  throw new Error(
    "Set REI_PLAYWRIGHT_MODULE to the isolated Playwright index.mjs.",
  );
const { chromium } = await import(
  pathToFileURL(resolve(process.env.REI_PLAYWRIGHT_MODULE)).href
);
const publicRoot = resolve("public"),
  fixtures = new Map();
const exampleClient = {
  id: "client-example",
  name: "Alex Example",
  phone: "+381600000001",
  email: "alex@example.test",
  version: 3,
};
const otherClient = {
  id: "client-other",
  name: "Other Example",
  phone: "+381600000002",
  email: "other@example.test",
  version: 2,
};
const group = {
  key: "a".repeat(64),
  source: "fictional",
  label: "Alex <img src=x onerror=alert(1)>",
  count: 102,
  from: "2025-01-01",
  to: "2025-12-31",
};
function row(index) {
  return {
    id: `archive-${index}`,
    clientLabel: group.label,
    sourceClientId: "source-" + "x".repeat(80),
    date: "2025-06-01",
    startMinute: 600,
    duration: 60,
    serviceName: `Example treatment ${index}`,
    therapistName: "Example Therapist",
    status: index % 2 ? "Confirmed" : "No Show",
    phone: "+381600000001",
  };
}
function fixture() {
  return {
    writes: [],
    requests: [],
    unexpected: [],
    receipts: new Map(),
    commits: 0,
    revision: 1,
    lost: false,
    stale: false,
    loadFail: false,
    delays: new Map(),
  };
}
const harness = `import { renderHistoryLinking } from '/history-linking.js';
const root = document.querySelector('#test-root');
let active = true;
const api = async (path, {method='GET',body}={}) => {
  const response = await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error); error.status=response.status; throw error; }
  return data;
};
const esc = (v) => String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanup = renderHistoryLinking({root,api,esc,isCurrent:()=>active,back:()=>{active=false;cleanup();root.textContent='Back to history';},openProfile:(id)=>{root.textContent='Opened profile '+id;}});
document.querySelector('#leave').onclick=()=>{active=false;cleanup();root.textContent='Another screen';};`;
let origin;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    f = fixtures.get(req.headers["x-fixture"]);
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'",
  );
  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  try {
    if (url.pathname.startsWith("/api/")) {
      assert.ok(f);
      let raw = "";
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : undefined;
      f.requests.push({
        path: url.pathname,
        query: url.search,
        method: req.method,
      });
      if (req.method === "POST") f.writes.push(structuredClone(body));
      if (f.delays.has(url.pathname)) await f.delays.get(url.pathname).promise;
      if (url.pathname === "/api/history/links/groups") {
        if (f.loadFail) {
          f.loadFail = false;
          return json({ error: "Temporary read failure" }, 503);
        }
        const offset = Number(url.searchParams.get("offset"));
        return json({
          groups: offset
            ? [{ ...group, key: "b".repeat(64), label: "Last group" }]
            : Array.from({ length: 30 }, (_, i) => ({
                ...group,
                key: i ? String(i).padStart(64, "0") : group.key,
              })),
          total: 31,
          unlinkedRows: 132,
        });
      }
      if (url.pathname === "/api/history/links/review") {
        const offset = Number(url.searchParams.get("offset"));
        return json({
          reviewId: `review-${f.revision}-${offset}`,
          token: `token-${f.revision}`,
          fingerprint: "f".repeat(64),
          expiresAt: "2099-01-01T00:00:00Z",
          archiveRevision: 2,
          clientRevision: 3,
          group,
          total: 102,
          offset,
          hasMore: offset === 0,
          rows: Array.from({ length: offset ? 2 : 100 }, (_, i) =>
            row(i + offset),
          ),
          candidates: [exampleClient],
          ambiguous: true,
        });
      }
      if (url.pathname === "/api/clients")
        return json({ clients: [otherClient] });
      if (url.pathname === "/api/history/links/apply") {
        assert.equal(body.acknowledgeReview, true);
        assert.ok(body.archiveIds.length > 0);
        assert.equal(body.token, `token-${f.revision}`);
        if (f.stale) {
          f.stale = false;
          return json({ error: "Archive changed. Refresh review." }, 409);
        }
        const saved = f.receipts.get(body.requestId);
        if (saved) {
          assert.deepEqual(saved.body, body);
          return json({ ...saved.result, repeated: true });
        }
        const result = {
          linked: body.archiveIds.length,
          remaining: 102 - body.archiveIds.length,
          client:
            body.clientId === otherClient.id ? otherClient : exampleClient,
          repeated: false,
        };
        f.receipts.set(body.requestId, { body: structuredClone(body), result });
        f.commits++;
        if (f.lost) {
          f.lost = false;
          return json({ error: "Lost confirmation response" }, 503);
        }
        return json(result);
      }
      f.unexpected.push(`${req.method} ${url.pathname}`);
      return json({ error: "Unexpected route" }, 404);
    }
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/history-preview.css"></head><body><main style="padding:16px"><button id="leave" class="btn">Another screen</button><div id="test-root"></div></main><script type="module" src="/harness.js"></script></body></html>',
      );
    }
    if (url.pathname === "/harness.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(harness);
    }
    const file = resolve(publicRoot, "." + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(publicRoot + sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch (error) {
    f?.unexpected.push(error.message);
    if (!res.headersSent) json({ error: error.message }, 500);
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
const desktop = { name: "desktop", viewport: { width: 1280, height: 900 } },
  phone = {
    name: "phone",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  };
let passed = 0;
const failures = [];
function deferred() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}
async function openReview(page) {
  await page.goto(origin);
  await page.locator('[data-link-group="0"]').click();
  await page.locator("#links-form").waitFor();
}
async function choose(page) {
  await page.locator('[data-link-row="0"]').check();
  await page.locator('[data-link-client="0"]').click();
  await page.locator("#links-ack").check();
}
async function saved(page) {
  await page
    .getByRole("heading", { name: "Visits linked", exact: true })
    .waitFor();
}
async function scenario(name, device, run) {
  const f = fixture(),
    id = `${device.name}-${name}`;
  fixtures.set(id, f);
  const context = await browser.newContext({
    viewport: device.viewport,
    isMobile: !!device.isMobile,
    hasTouch: !!device.hasTouch,
    extraHTTPHeaders: { "x-fixture": id },
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
    assert.deepEqual(errors, []);
    assert.deepEqual(f.unexpected, []);
    passed++;
    console.log(`PASS ${device.name}: ${name}`);
  } catch (error) {
    failures.push(`${device.name}: ${name}: ${error.message}`);
    console.error(error.stack);
    if (process.env.REI_BROWSER_ARTIFACTS) {
      await mkdir(resolve(process.env.REI_BROWSER_ARTIFACTS), {
        recursive: true,
      });
      await page
        .screenshot({
          path: resolve(
            process.env.REI_BROWSER_ARTIFACTS,
            id.replace(/[^a-z0-9]+/gi, "-") + ".png",
          ),
        })
        .catch(() => {});
    }
  } finally {
    for (const delay of f.delays.values()) delay.release();
    await context.close();
    fixtures.delete(id);
  }
}
try {
  for (const device of [desktop, phone])
    await scenario(
      "explicit visit and client selection with source evidence",
      device,
      async ({ page, f }) => {
        await openReview(page);
        assert.equal(await page.locator(".history-linking img").count(), 0);
        assert.match(
          await page.locator("#links-rows").innerText(),
          /Source client ID: source-/,
        );
        assert.match(
          await page.locator("#links-content").innerText(),
          /may refer to more than one client/,
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          "Visit evidence fits the viewport",
        );
        assert.match(
          await page.locator("#links-chosen").innerText(),
          /No client selected/,
        );
        await page.locator("#links-apply").click();
        assert.match(
          await page.locator("#links-error").innerText(),
          /Select visits/,
        );
        assert.equal(f.writes.length, 0);
        await choose(page);
        await page.locator('[data-link-row="1"]').check();
        assert.equal(await page.locator("#links-ack").isChecked(), false);
        await page.locator("#links-apply").click();
        assert.equal(f.writes.length, 0);
        await page.locator("#links-ack").check();
        await page.locator("#links-apply").click();
        await saved(page);
        assert.deepEqual(f.writes[0].archiveIds, ["archive-0", "archive-1"]);
        assert.equal(f.writes[0].clientId, exampleClient.id);
        assert.equal(f.writes[0].clientVersion, 3);
        assert.equal(f.commits, 1);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          "Page fits narrow viewport",
        );
        await page.locator("#links-open-profile").click();
        assert.match(
          await page.locator("#test-root").innerText(),
          /Opened profile client-example/,
        );
      },
    );
  await scenario(
    "name candidates never override explicit searched client",
    desktop,
    async ({ page, f }) => {
      await openReview(page);
      await page.locator("#links-search").fill("Other");
      await page.locator("#links-search-button").click();
      await page
        .locator("#links-clients")
        .getByText("Other Example", { exact: true })
        .waitFor();
      await choose(page);
      await page.locator("#links-apply").click();
      await saved(page);
      assert.equal(f.writes[0].clientId, otherClient.id);
      assert.equal(f.writes[0].clientVersion, 2);
    },
  );
  await scenario(
    "lost response freezes choices and retries exact receipt",
    phone,
    async ({ page, f }) => {
      f.lost = true;
      await openReview(page);
      await choose(page);
      await page.locator("#links-apply").click();
      await page
        .getByRole("button", { name: "Check result / retry" })
        .waitFor();
      assert.equal(f.commits, 1);
      assert.equal(
        await page.locator('[data-link-row="0"]').isDisabled(),
        true,
      );
      assert.equal(await page.locator("#links-refresh").isDisabled(), true);
      await page.locator("#links-apply").click();
      await saved(page);
      assert.deepEqual(f.writes[0], f.writes[1]);
      assert.equal(f.commits, 1);
    },
  );
  await scenario(
    "stale review refresh preserves visit choices and requires acknowledgement",
    desktop,
    async ({ page, f }) => {
      f.stale = true;
      await openReview(page);
      await choose(page);
      await page.locator("#links-apply").click();
      await page.locator("#links-error").waitFor({ state: "visible" });
      assert.equal(f.commits, 0);
      f.revision++;
      await page.locator("#links-refresh").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#test-root")?.getAttribute("aria-busy") ===
          "false",
      );
      assert.equal(await page.locator('[data-link-row="0"]').isChecked(), true);
      assert.equal(await page.locator("#links-ack").isChecked(), false);
      await page.locator("#links-ack").check();
      await page.locator("#links-apply").click();
      await saved(page);
      assert.equal(f.writes[1].reviewId, "review-2-0");
      assert.notEqual(f.writes[0].requestId, f.writes[1].requestId);
    },
  );
  await scenario(
    "bounded group and visit pages never submit invisible visits",
    phone,
    async ({ page, f }) => {
      await page.goto(origin);
      await page.locator("#links-groups-next").click();
      await page.getByText("Last group", { exact: true }).waitFor();
      await page.locator('[data-link-group="0"]').click();
      await page.locator("#links-rows-next").click();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-link-row]").length === 2,
      );
      await page.locator("#links-select-page").check();
      await page.locator('[data-link-client="0"]').click();
      await page.locator("#links-ack").check();
      await page.locator("#links-apply").click();
      await saved(page);
      assert.deepEqual(f.writes[0].archiveIds, ["archive-100", "archive-101"]);
    },
  );
  await scenario(
    "read retry and disposal reject late rendered responses",
    desktop,
    async ({ page, f }) => {
      f.loadFail = true;
      await page.goto(origin);
      await page.locator("#links-load-retry").click();
      await page.locator('[data-link-group="0"]').waitFor();
      const gate = deferred();
      f.delays.set("/api/history/links/review", gate);
      const requested = page.waitForRequest((request) =>
        request.url().includes("/history/links/review"),
      );
      await page.locator('[data-link-group="0"]').click();
      await requested;
      await page.locator("#leave").click();
      const responded = page.waitForResponse((response) =>
        response.url().includes("/history/links/review"),
      );
      gate.release();
      await responded;
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      assert.equal(
        await page.locator("#test-root").innerText(),
        "Another screen",
      );
      assert.equal(f.writes.length, 0);
    },
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `${passed} linking browser scenarios passed; ${failures.length} failed.`,
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
