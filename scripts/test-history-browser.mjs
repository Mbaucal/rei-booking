// Independent rendered acceptance. Only fictional data and loopback HTTP are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeHistoryRows } from "../src/history-normalize.mjs";
import { planHistoryImport } from "../src/history-import-plan.mjs";

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
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
const desktop = { name: "desktop", viewport: { width: 1440, height: 1050 } };
const phone = {
  name: "phone",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
const client = {
  id: "history-qa-client",
  name: "Nora Example",
  phone: "+381600000001",
  email: "nora@example.test",
  instagram: "nora_example",
  note: "Fictional profile; preserve this note.",
  version: 3,
};
function fixture() {
  return {
    role: "owner",
    requests: [],
    writes: [],
    unexpected: [],
    waits: [],
    clientRevision: 0,
    clients: [
      structuredClone(client),
      {
        ...client,
        id: "history-qa-twin",
        phone: "+381600000002",
        email: "twin@example.test",
        instagram: "nora_twin",
      },
      {
        ...client,
        id: "history-qa-other",
        name: "Milo Example",
        phone: "+381600000003",
        email: "milo@example.test",
        instagram: "milo_example",
      },
    ],
    catalogue: { therapists: [], rooms: [], services: [] },
    previews: new Map(),
    archive: [],
    archiveReviews: new Map(),
    archiveReceipts: new Map(),
    failures: new Map(),
    delays: new Map(),
  };
}
function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixtureAPI(f, url, method, body, json) {
  if (url.pathname === "/api/session")
    return json({
      user: { id: "fictional-owner", name: "Fictional QA Owner", role: f.role },
      csrf: "fixture-csrf",
      mustChangePassword: false,
    });
  if (url.pathname === "/api/catalogue") return json(f.catalogue);
  if (url.pathname === "/api/reports/appointments")
    return json({
      options: { from: "2026-01-15", to: "2026-01-15" },
      comparison: null,
      totals: { revenueCents: 0, completed: 0, totalMinutes: 0 },
    });
  if (url.pathname === "/api/appointments" && method === "GET")
    return json({ appointments: [], blocks: [] });
  if (url.pathname === "/api/clients" && method === "GET")
    return json({ clients: f.clients });
  if (
    /^\/api\/clients\/[^/]+\/history$/.test(url.pathname) &&
    method === "GET"
  ) {
    if (f.role === "therapist") return json({ error: "Access denied" }, 403);
    const id = url.pathname.split("/")[3],
      page = Number(url.searchParams.get("page") || 0);
    const records = f.archive.filter((r) => r.clientId === id);
    return json({
      clientId: id,
      page,
      pageSize: 25,
      total: records.length,
      totalPages: Math.ceil(records.length / 25),
      statusCounts: statusCounts(records),
      rows: records.slice(page * 25, (page + 1) * 25).map((row) => ({
        id: row.id,
        date: row.date,
        start: row.start,
        duration: row.duration,
        serviceName: row.serviceName,
        therapistName: row.therapistName,
        roomName: null,
        sourceStatus: row.sourceStatus,
        completionState: row.record?.completionState || "unknown",
        requestState: "unknown",
        importedAt: "2026-10-02T12:00:00.000Z",
        ...(f.role === "owner"
          ? {
              record: row.record || null,
              provenance: {
                source: "fictional-source",
                sourceAppointmentRef: row.key,
              },
              sourceNetSalesMinor: null,
              currency: null,
            }
          : {}),
      })),
    });
  }
  if (/^\/api\/clients\/[^/]+$/.test(url.pathname) && method === "GET") {
    const found = f.clients.find(
      (c) => c.id === url.pathname.split("/").at(-1),
    );
    return found
      ? json({ client: found, appointments: [] })
      : json({ error: "Unknown fictional client" }, 404);
  }
  if (url.pathname.startsWith("/api/history/imports/"))
    return archiveAPI(f, url, method, body, json);
  // The history fixture follows the published preview route contract.
  return historyAPI(f, url, method, body, json);
}
function statusCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const status = row.sourceStatus || "Unknown";
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return [...counts].map(([status, count]) => ({ status, count }));
}
// This small fictional service drives UI responses, not database safety assertions.
// Real Worker/D1 tests independently cover atomicity and permanent uniqueness.
async function archiveAPI(f, url, method, body, json) {
  if (f.role !== "owner") return json({ error: "Owner access required" }, 403);
  assert.equal(method, "POST");
  assert.match(body.requestId, /^[a-f0-9-]{36}$/i);
  assert.ok(body.rows.length > 0 && body.rows.length <= 50);
  if (url.pathname === "/api/history/imports/review") {
    const preview = f.previews.get(body.previewId);
    assert.ok(preview, "Review uses an existing fictional preview");
    assert.equal(body.version, preview.version);
    const rows = body.rows.map((number) => {
      const entry = preview.plan.rows.find((r) => r.record.row === number);
      assert.ok(entry, "Review selects a real source row");
      const record = entry.record;
      const choice = preview.choices.get(number);
      const client = f.clients.find((c) => c.id === choice?.clientId);
      const key = record.source + "/" + record.sourceAppointmentRef;
      const fingerprint = JSON.stringify({
        raw: record.raw,
        clientId: client?.id,
      });
      const existing = f.archive.find((r) => r.key === key);
      const issues = [];
      if (!client)
        issues.push({
          code: "client_unresolved",
          message: "Choose a current client explicitly.",
        });
      if (!record.sourceAppointmentRef)
        issues.push({
          code: "reference_missing",
          message: "A stable source reference is required.",
        });
      if (choice && choice.clientVersion !== client?.version)
        issues.push({
          code: "client_changed",
          message: "The chosen client changed. Review again.",
        });
      if (existing && existing.fingerprint !== fingerprint)
        issues.push({
          code: "archive_conflict",
          message:
            "This source reference has changed content or another client. Existing history was not changed.",
        });
      return {
        row: number,
        client: client ? structuredClone(client) : null,
        sourceStatus: record.sourceStatus,
        date: record.scheduledLocalDate,
        start: record.startMinute,
        duration: record.durationMinutes,
        serviceName: record.sourceServiceLabel,
        therapistName: record.sourceTherapistLabel,
        disposition: issues.length
          ? "blocked"
          : existing
            ? "duplicate"
            : "import",
        issues,
        nativeOverlapIds: [],
        // Internal fixture-only evidence is removed from the HTTP response.
        fixtureEvidence: { key, fingerprint, record, existing },
      };
    });
    const response = {
      reviewId: "fictional-review-" + body.requestId,
      confirmationToken: "fictional-token-" + body.requestId,
      expiresAt: Date.now() + 600000,
      ...structuredClone(body),
      canConfirm: rows.every((row) => row.disposition !== "blocked"),
      counts: {
        selected: rows.length,
        importable: rows.filter((r) => r.disposition === "import").length,
        duplicates: rows.filter((r) => r.disposition === "duplicate").length,
        blocked: rows.filter((r) => r.disposition === "blocked").length,
      },
      statusCounts: statusCounts(rows),
      rows: rows.map(({ fixtureEvidence, ...row }) => row),
      warnings: [
        "Original source statuses are retained; this does not update live appointments or financial reports.",
        "Unverified appointment references are reserved conservatively. Source timezone is unconfirmed; local time is retained without an instant.",
      ],
    };
    f.archiveReviews.set(body.requestId, {
      request: structuredClone(body),
      response,
      rows,
      clientRevision: f.clientRevision,
    });
    return json(response);
  }
  if (url.pathname === "/api/history/imports/confirm") {
    const receipt = f.archiveReceipts.get(body.requestId);
    if (receipt) {
      assert.deepEqual(
        body,
        receipt.request,
        "Lost acknowledgement repeats the exact confirmation request",
      );
      return json({ ...receipt.response, repeated: true });
    }
    const review = f.archiveReviews.get(body.requestId);
    assert.ok(review, "Confirmation follows an explicit review");
    assert.equal(body.confirmationToken, review.response.confirmationToken);
    assert.equal(body.acknowledgeReview, true);
    for (const field of ["previewId", "version", "rows", "requestId"])
      assert.deepEqual(body[field], review.request[field]);
    assert.equal(
      review.response.canConfirm,
      true,
      "Blocked rows are never confirmed",
    );
    if (f.rejectConfirm || review.clientRevision !== f.clientRevision) {
      f.rejectConfirm = false;
      return json(
        {
          error:
            "History or client data changed. Review the selected rows again.",
        },
        409,
      );
    }
    const result = [];
    for (const row of review.rows) {
      const evidence = row.fixtureEvidence;
      if (row.disposition === "import") {
        const id = "fictional-archive-" + (f.archive.length + 1);
        f.archive.push({
          ...evidence,
          id,
          clientId: row.client.id,
          sourceStatus: row.sourceStatus,
          date: row.date,
          start: row.start,
          duration: row.duration,
          serviceName: row.serviceName,
          therapistName: row.therapistName,
        });
        result.push({ row: row.row, id, disposition: "imported" });
      } else
        result.push({
          row: row.row,
          id: evidence.existing.id,
          disposition: "duplicate",
        });
    }
    const response = {
      importId: "fictional-import-" + body.requestId,
      created: review.response.counts.importable,
      duplicates: review.response.counts.duplicates,
      statusCounts: review.response.statusCounts,
      rows: result,
      repeated: false,
    };
    f.archiveReceipts.set(body.requestId, {
      request: structuredClone(body),
      response,
    });
    if (f.loseArchiveAcknowledgement) {
      f.loseArchiveAcknowledgement = false;
      f.previews.delete(body.previewId);
      return json(
        {
          error:
            "Fictional lost import acknowledgement. Check the result safely.",
        },
        503,
      );
    }
    return json(response);
  }
  f.unexpected.push(`${method} ${url.pathname}`);
  return json({ error: "Unexpected archive fixture route" }, 404);
}
async function historyAPI(f, url, method, body, json) {
  const prefix = "/api/history/previews";
  if (url.pathname.startsWith(prefix)) {
    if (f.role !== "owner")
      return json({ error: "Owner access required" }, 403);
    const metadata = (p) => ({
      id: p.id,
      version: p.version,
      total: p.config.total,
      uploaded: p.cells.length,
      phase: p.phase,
      expiresAt: Date.now() + 86400000,
      fileDigest: p.config.fileDigest,
      source: p.config.source,
      config: p.config,
      fileBytes: p.config.fileBytes,
      totalPages: Math.ceil(p.config.total / 50),
      indexedClients: p.indexedClients,
      imported: false,
    });
    if (url.pathname === prefix && method === "GET")
      return json({ previews: [...f.previews.values()].map(metadata) });
    if (url.pathname === prefix + "/start" && method === "POST") {
      const p = {
        id: "history-qa-preview-" + (f.previews.size + 1),
        version: 1,
        phase: "upload",
        config: body,
        cells: [],
        plan: null,
        choices: new Map(),
        choiceRequests: new Map(),
        indexedClients: 0,
        clientRevision: f.clientRevision,
      };
      f.previews.set(p.id, p);
      return json(metadata(p), 201);
    }
    const [id, action] = url.pathname.slice(prefix.length + 1).split("/"),
      p = f.previews.get(id);
    if (!p)
      return json(
        { error: "Preview expired or unavailable. Start a new preview." },
        404,
      );
    if (action === "upload" && method === "POST") {
      assert.ok(
        body.rows.length <= 100,
        "Browser chunks respect the server row limit",
      );
      if (body.offset < p.cells.length) {
        assert.deepEqual(
          p.cells.slice(body.offset, body.offset + body.rows.length),
          body.rows,
          "A retried upload is identical",
        );
        return json({ ...metadata(p), repeated: true });
      }
      assert.equal(body.offset, p.cells.length);
      p.cells.push(...body.rows);
      return json(metadata(p));
    }
    if (action === "finalize" && method === "POST") {
      assert.equal(p.cells.length, p.config.total);
      if (p.clientRevision !== f.clientRevision) {
        p.indexedClients = 0;
        p.clientRevision = f.clientRevision;
      }
      p.indexedClients = Math.min(f.clients.length, p.indexedClients + 1000);
      if (p.indexedClients < f.clients.length) {
        p.phase = "indexing";
        return json(metadata(p));
      }
      p.plan = planHistoryImport({
        rows: normalizeHistoryRows({ ...p.config, rows: p.cells }).rows,
        clients: f.clients,
        referenceMode: p.config.referenceMode,
      });
      p.phase = "ready";
      p.version++;
      return json(metadata(p));
    }
    if (action === "page" && method === "GET") {
      if (p.clientRevision !== f.clientRevision)
        return json(
          {
            error:
              "Client list changed. Rebuild this preview before reviewing matches.",
          },
          409,
        );
      const page = Number(url.searchParams.get("page") || 0);
      assert.ok(p.plan, "Only completed previews are paged");
      return json({
        ...metadata(p),
        page,
        pageSize: 50,
        summary: {
          total: p.config.total,
          uploaded: p.cells.length,
          invalidRows: p.plan.summary.invalid,
          sourceConflictRows: p.plan.rows.filter((row) =>
            row.issues.some((i) => i.code === "source_payload_conflict"),
          ).length,
          duplicateRows: p.plan.summary.duplicate,
          draftChoices: p.choices.size,
        },
        pageSummary: planHistoryImport({
          rows: p.plan.rows
            .slice(page * 50, (page + 1) * 50)
            .map((row) => row.record),
          clients: f.clients,
          referenceMode: p.config.referenceMode,
        }).summary,
        rows: p.plan.rows.slice(page * 50, (page + 1) * 50).map((entry) => ({
          ...entry,
          row: entry.record.row,
          candidates: entry.identity.candidates.map((id) =>
            f.clients.find((c) => c.id === id),
          ),
          draftChoice: p.choices.has(entry.record.row)
            ? {
                ...p.choices.get(entry.record.row),
                stale:
                  f.clients.find(
                    (client) =>
                      client.id === p.choices.get(entry.record.row).clientId,
                  )?.version !== p.choices.get(entry.record.row).clientVersion,
              }
            : null,
        })),
      });
    }
    if (action === "clients" && method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return json({
        clients: f.clients.filter((c) =>
          [c.name, c.phone, c.email, c.instagram].some((value) =>
            value.toLowerCase().includes(q),
          ),
        ),
        hasMore: false,
      });
    }
    if (action === "choices" && method === "POST") {
      if (p.choiceRequests.has(body.requestId)) {
        assert.deepEqual(
          body,
          p.choiceRequests.get(body.requestId),
          "A choice retry preserves the complete idempotent request",
        );
        return json(metadata(p));
      }
      assert.equal(
        body.version,
        p.version,
        "Choices use the current preview revision",
      );
      assert.match(
        body.requestId,
        /^[a-f0-9-]{36}$/i,
        "Choices carry an idempotency request ID",
      );
      assert.ok(body.choices.length > 0 && body.choices.length <= 50);
      for (const choice of body.choices) {
        assert.ok(p.plan.rows.some((row) => row.record.row === choice.row));
        if (choice.clientId === null) p.choices.delete(choice.row);
        else {
          const current = f.clients.find((c) => c.id === choice.clientId);
          assert.ok(current, "An existing fictional profile is selected");
          assert.equal(choice.clientVersion, current.version);
          p.choices.set(choice.row, {
            clientId: current.id,
            clientVersion: current.version,
            name: current.name,
            stale: false,
          });
        }
      }
      p.version++;
      p.choiceRequests.set(body.requestId, structuredClone(body));
      if (f.loseChoiceResponse) {
        f.loseChoiceResponse = false;
        return json(
          {
            error:
              "Fictional lost acknowledgement; retry the same draft choice.",
          },
          503,
        );
      }
      return json(metadata(p));
    }
    if (!action && method === "DELETE") {
      assert.equal(body.version, p.version);
      f.previews.delete(id);
      return json({ ok: true });
    }
    if (!action && method === "GET") return json(metadata(p));
  }
  f.unexpected.push(`${method} ${url.pathname}`);
  return json({ error: "Unexpected fictional API route" }, 404);
}
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", csp);
  const url = new URL(req.url, "http://localhost"),
    f = fixtures.get(req.headers["x-rei-fixture"]);
  const json = (data, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    if (url.pathname.startsWith("/api/")) {
      if (!f) return json({ error: "Unknown fictional session" }, 401);
      let raw = "";
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : undefined;
      f.requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        body,
      });
      if (!["GET", "HEAD"].includes(req.method)) {
        assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
        assert.equal(req.headers.origin, origin);
        f.writes.push({ method: req.method, path: url.pathname, body });
      }
      const key = `${req.method} ${url.pathname}`,
        delay = f.delays.get(key);
      if (delay) await delay.promise;
      const failure = f.failures.get(key);
      if (failure) {
        f.failures.delete(key);
        return json({ error: failure.message }, failure.status);
      }
      return await fixtureAPI(f, url, req.method, body, json);
    }
    const file = resolve(
      publicRoot,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    if (!file.startsWith(publicRoot + sep)) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(await readFile(file));
  } catch (error) {
    if (f) f.unexpected.push(error.message);
    if (!res.headersSent) json({ error: "Fixture server error" }, 500);
    else res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let passed = 0;
const failures = [];
async function capture(page, name) {
  if (!process.env.REI_BROWSER_ARTIFACTS) return;
  const directory = resolve(process.env.REI_BROWSER_ARTIFACTS);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name + ".png") });
}
async function navigate(page, target) {
  const desktop = page.locator(`nav [data-page="${target}"]`);
  if (await desktop.isVisible()) return desktop.click();
  const mobile = page.locator(
    `#mobile-navigation [data-mobile-page="${target}"]`,
  );
  if (await mobile.isVisible()) return mobile.click();
  await page.locator("#mobile-more").click();
  await page.locator(`#drawer [data-mobile-page="${target}"]`).click();
}
async function openApp(page, f) {
  await page.goto(origin);
  const compact = await page.evaluate(
    () =>
      matchMedia("(max-width:700px), (max-height:560px) and (pointer:coarse)")
        .matches,
  );
  if (f.role === "owner" && !compact)
    await page.locator("#report-metrics .report-metric").first().waitFor();
  else await page.locator("#calendar-grid").waitFor();
}
async function openHistory(page, f) {
  await openApp(page, f);
  await navigate(page, "clients");
  await page.locator("#history-preview-open").click();
  await page.locator("#history-csv").waitFor();
}
function fictionalCSV(count = 3, changes = {}) {
  const headers = [
    "Appt. ref.",
    "Client",
    "Team member",
    "Status",
    "Created date",
    "Scheduled date",
    "Cancelled date",
    "Service",
    "Duration (mins)",
    "Appt. slot",
    "Net sales",
    "Requested",
  ];
  const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
  const rows = Array.from({ length: count }, (_, index) => [
    "QA-" + String(index + 1).padStart(6, "0"),
    client.name,
    "Former QA Therapist",
    "Started",
    "04 Jan 2026, 5:43pm",
    "15 Jan 2026, 10:00am",
    "",
    "Historical QA treatment",
    "1h 0min",
    "10:00:00-11:00:00",
    "5900",
    "",
  ]);
  for (const [index, value] of Object.entries(changes))
    Object.assign(rows[index], value);
  return Buffer.from(
    [headers, ...rows].map((row) => row.map(quote).join(",")).join("\r\n"),
    "utf8",
  );
}
async function readColumns(
  page,
  bytes = fictionalCSV(),
  filename = "fictional-history.csv",
) {
  await page.locator("#history-csv").setInputFiles({
    name: filename,
    mimeType: "text/csv",
    buffer: bytes,
  });
  await page.locator("#history-read-columns").click();
  await page.locator("#history-map").waitFor();
}
async function buildPreview(page) {
  await page.locator("#history-build-preview").click();
  await page.locator("[data-history-row]").first().waitFor();
}
function archiveCSV({
  reordered = false,
  changedStatus = false,
  missingReference = false,
} = {}) {
  const content = fictionalCSV(3, {
    0: {
      0: missingReference ? "" : "ARCHIVE-0001",
      3: "No Show",
      7: "Original no-show treatment",
    },
    1: {
      0: "ARCHIVE-0002",
      3: "Cancelled",
      6: "14 Jan 2026, 5:43pm",
      7: "Original cancelled treatment",
    },
    2: {
      0: "ARCHIVE-0003",
      3: changedStatus ? "Confirmed" : "Started",
      7: "Original started treatment",
    },
  }).toString();
  const [header, ...rows] = content.split("\r\n");
  return Buffer.from(
    [header, ...(reordered ? rows.reverse() : rows)].join("\r\n"),
  );
}
async function prepareArchivePreview(
  page,
  {
    bytes = archiveCSV(),
    filename,
    clientId = client.id,
    referenceMode = "unverified",
  } = {},
) {
  await readColumns(page, bytes, filename);
  if (!(await page.locator("#history-advanced").evaluate((node) => node.open)))
    await page.locator("#history-advanced > summary").click();
  await page.locator("#history-reference-mode").selectOption(referenceMode);
  await buildPreview(page);
  for (const row of [2, 3, 4])
    await page.locator(`[data-history-select="${row}"]`).check();
  await page.locator("#history-choose-client").click();
  await page
    .locator("#history-client-search")
    .fill(clientId === "history-qa-other" ? "Milo" : "Nora");
  await page.locator("#history-client-search-button").click();
  await page.locator(`[data-history-client-id="${clientId}"]`).check();
  await page.locator("#history-apply-choice").click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-history-row="2"]')
      ?.textContent.includes("Draft match:"),
  );
  for (const row of [2, 3, 4])
    await page.locator(`[data-history-select="${row}"]`).check();
}
function seedProfileArchive(f) {
  for (let i = 0; i < 28; i++)
    f.archive.push({
      id: `profile-archive-${i}`,
      key: `profile-ref-${i}`,
      clientId: client.id,
      date: "2026-01-" + String(i + 1).padStart(2, "0"),
      start: 600,
      duration: 60,
      serviceName:
        i === 27
          ? "Final paginated source treatment"
          : `Archived source treatment ${i + 1}`,
      therapistName: "Former QA Therapist",
      sourceStatus: ["No Show", "Cancelled", "Started", "Confirmed"][i % 4],
      record: {
        completionState: i % 4 < 2 ? "not_completed" : "unknown",
        raw: {
          netSales: "OWNER-ONLY-SOURCE-RAW",
          clientName: "Historical source label",
        },
      },
    });
}
async function openClientHistory(page) {
  await navigate(page, "clients");
  await page.locator(`[data-profile="${client.id}"]`).click();
  await page.locator("#drawer[open] .client-history").waitFor();
  await page.locator("#client-history-summary").waitFor();
}
async function reviewArchive(page) {
  await page.locator("#history-review-import").click();
  await page.locator("#history-import-review").waitFor({ state: "visible" });
}
async function confirmArchive(page) {
  await page.locator("#history-import-ack").check();
  await page.locator("#history-confirm-import").click();
  await page.locator("#history-import-receipt").waitFor({ state: "visible" });
}
async function inViewport(page, locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox(),
    viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0, label + " renders");
  assert.ok(
    box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    label + " remains inside the viewport",
  );
}
async function noHorizontalOverflow(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "The page does not overflow horizontally",
  );
}
async function scenario(name, device, run) {
  const f = fixture(),
    id = `${device.name}-${name}`;
  fixtures.set(id, f);
  const context = await browser.newContext({
    viewport: device.viewport,
    isMobile: device.isMobile || false,
    hasTouch: device.hasTouch || false,
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
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await run({ page, f });
    assert.deepEqual(
      errors,
      [],
      "The real application emits no browser exceptions",
    );
    assert.deepEqual(
      f.unexpected,
      [],
      "No unexpected API route or fixture error",
    );
    assert.ok(
      f.writes.every((request) => request.path.startsWith("/api/history/")),
      "Preview interaction never writes clients, appointments or financial records",
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
    for (const delay of f.delays.values()) delay.release();
    for (const wait of f.waits) wait.release();
    await context.close();
    fixtures.delete(id);
  }
}

try {
  for (const device of [desktop, phone]) {
    await scenario(
      "large CSV stays preview-only with mapping, complete indexing and paged candidates",
      device,
      async ({ page, f }) => {
        f.clients.unshift(
          ...Array.from({ length: 1001 }, (_, i) => ({
            id: `filler-${i}`,
            name: `Fictional unrelated client ${i}`,
            phone: "",
            email: "",
            instagram: "",
            version: 1,
          })),
        );
        const beforeClients = structuredClone(f.clients);
        await openHistory(page, f);
        assert.match(
          await page.locator(".history-preview").innerText(),
          /Review before import/,
        );
        await readColumns(
          page,
          fictionalCSV(1205, {
            0: { 7: '<img data-history-injected="yes" src="x">' },
          }),
        );
        assert.equal(
          await page.locator('[data-history-column="clientName"]').inputValue(),
          "1",
        );
        assert.equal(
          await page
            .locator('[data-history-column="scheduledDate"]')
            .inputValue(),
          "5",
        );
        assert.equal(
          await page.locator('[data-history-column="duration"]').inputValue(),
          "8",
        );
        await page
          .locator('[data-history-column="duration"]')
          .selectOption("5");
        await page.locator("#history-build-preview").click();
        assert.match(
          await page.locator("#history-error-text").innerText(),
          /only once/,
        );
        assert.equal(
          f.writes.length,
          0,
          "Invalid mapping never starts an upload",
        );
        await page
          .locator('[data-history-column="duration"]')
          .selectOption("8");
        assert.equal(await page.locator("#history-timezone").inputValue(), "");
        assert.equal(await page.locator("#history-currency").inputValue(), "");
        await inViewport(
          page,
          page.locator("#history-build-preview"),
          "Prepare preview button",
        );
        await noHorizontalOverflow(page);
        await capture(page, device.name + "-history-column-mapping");
        await buildPreview(page);
        assert.equal(
          f.writes.filter((r) => r.path.endsWith("/upload")).length,
          13,
        );
        assert.equal(
          f.writes.filter((r) => r.path.endsWith("/finalize")).length,
          2,
          "UI finishes indexing beyond the first1000clients",
        );
        assert.equal(await page.locator("[data-history-row]").count(), 50);
        assert.match(
          await page.locator("#history-summary").innerText(),
          /On this page[\s\S]*Across the file/,
        );
        assert.match(
          await page.locator("#history-work").innerText(),
          /1,205 source rows/,
        );
        assert.equal(
          await page.locator("[data-history-injected]").count(),
          0,
          "Source markup is escaped",
        );
        await page.locator('[data-history-details="2"]').click();
        const detail = page.locator("#history-row-detail-2");
        await detail.waitFor({ state: "visible" });
        assert.equal(
          await detail.locator("[data-history-use-candidate]").count(),
          2,
          "Both same-name candidates remain explicit alternatives",
        );
        assert.match(await detail.innerText(), /Unknown/);
        assert.equal(
          await page.locator("[data-history-select]:checked").count(),
          0,
          "Name matches never preselect rows",
        );
        await inViewport(
          page,
          detail.locator("[data-history-profile]").first(),
          "Candidate profile action",
        );
        await noHorizontalOverflow(page);
        await capture(page, device.name + "-history-candidates");
        await detail.locator("[data-history-profile]").first().click();
        await page.locator("#drawer[open]").waitFor();
        assert.match(
          await page.locator("#drawer-content").innerText(),
          /Fictional profile; preserve this note/,
        );
        await page.locator("#drawer-close").click();
        await page.locator("#history-next").click();
        await page.locator('[data-history-row="52"]').waitFor();
        assert.equal(await page.locator('[data-history-row="2"]').count(), 0);
        await page.locator("#history-prev").click();
        await page.locator('[data-history-row="2"]').waitFor();
        assert.deepEqual(f.clients, beforeClients);
        assert.ok([...f.previews.values()].every((p) => p.choices.size === 0));
        await page.locator("#history-summary").scrollIntoViewIfNeeded();
        await capture(page, device.name + "-history-paged-preview");
      },
    );

    await scenario(
      "explicit draft choices survive lost acknowledgement and resume without linking history",
      device,
      async ({ page, f }) => {
        const beforeClients = structuredClone(f.clients);
        await openHistory(page, f);
        await readColumns(page);
        await buildPreview(page);
        await page.locator('[data-history-select="2"]').check();
        await page.locator('[data-history-select="3"]').check();
        await page.locator("#history-choose-client").click();
        await page.locator("#history-client-search").fill("Milo");
        await page.locator("#history-client-search-button").click();
        await page
          .locator('[data-history-client-id="history-qa-other"]')
          .check();
        assert.match(
          await page.locator("#history-choice-summary").innerText(),
          /2 selected rows[\s\S]*No permanent client link/,
        );
        await inViewport(
          page,
          page.locator("#history-apply-choice"),
          "Save draft match",
        );
        await capture(page, device.name + "-history-explicit-draft-choice");
        f.loseChoiceResponse = true;
        await page.locator("#history-apply-choice").click();
        await page.locator("#history-error").waitFor({ state: "visible" });
        assert.equal([...f.previews.values()][0].choices.size, 2);
        await page.locator("#history-retry").click();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-history-row="2"]')
            ?.textContent.includes("Draft match: Milo Example"),
        );
        const choices = f.writes.filter((r) => r.path.endsWith("/choices"));
        assert.equal(choices.length, 2);
        assert.deepEqual(
          choices[0].body,
          choices[1].body,
          "Retry preserves the lost acknowledgement request",
        );
        assert.deepEqual(
          choices[0].body.choices.map((c) => c.row),
          [2, 3],
        );
        assert.match(
          await page.locator('[data-history-row="2"]').innerText(),
          /Needs review/,
          "Draft choice does not falsify source readiness",
        );
        await page.locator("#history-back").click();
        await page.locator("#history-preview-open").click();
        await page.locator("[data-history-open]").click();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-history-row="2"]')
            ?.textContent.includes("Draft match: Milo Example"),
        );
        await page.locator('[data-history-select="2"]').check();
        await page.locator("#history-clear-choices").click();
        await page.waitForFunction(
          () =>
            !document
              .querySelector('[data-history-row="2"]')
              ?.textContent.includes("Draft match:"),
        );
        assert.equal([...f.previews.values()][0].choices.size, 1);
        assert.deepEqual(f.clients, beforeClients);
        await page.locator("#history-discard").click();
        await page.locator("#history-csv").waitFor({ state: "visible" });
        assert.equal(f.previews.size, 0);
      },
    );
  }

  await scenario(
    "preparation failure is retryable and cancellation prevents late replacement",
    desktop,
    async ({ page, f }) => {
      await openHistory(page, f);
      await readColumns(page);
      f.failures.set(
        "POST /api/history/previews/history-qa-preview-1/finalize",
        { status: 503, message: "Fictional preparation outage" },
      );
      await page.locator("#history-build-preview").click();
      await page.locator("#history-error").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#history-cancel-upload").isEnabled(),
        true,
        "Failed preparation remains cancellable",
      );
      await page.locator("#history-retry").click();
      await page.locator('[data-history-row="2"]').waitFor();
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/upload")).length,
        1,
        "Retry does not upload the completed file again",
      );
      await page.locator("#history-new-file").click();
      await readColumns(page, fictionalCSV(101));
      const delay = deferred();
      f.waits.push(delay);
      f.delays.set("POST /api/history/previews/start", delay);
      await page.locator("#history-build-preview").click();
      await page.locator("#history-cancel-upload").click();
      assert.match(
        await page.locator("#history-progress-text").textContent(),
        /Preparation stopped/,
      );
      assert.equal(
        await page.locator("#history-back-columns").isEnabled(),
        true,
      );
      await page.locator("#history-preparation-files").click();
      await page.locator("#history-csv").waitFor({ state: "visible" });
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/history/previews/start"),
      );
      delay.release();
      await response;
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      assert.equal(await page.locator("#history-csv").isVisible(), true);
      assert.equal(await page.locator("[data-history-row]").count(), 0);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/upload")).length,
        1,
        "A cancelled late start never begins uploading",
      );
    },
  );

  await scenario(
    "late page response cannot replace another app page and late search cannot reopen cancelled choices",
    phone,
    async ({ page, f }) => {
      await openHistory(page, f);
      await readColumns(page);
      await buildPreview(page);
      await page.locator('[data-history-select="2"]').check();
      await page.locator("#history-choose-client").click();
      const searchDelay = deferred();
      f.waits.push(searchDelay);
      const id = [...f.previews.keys()][0];
      f.delays.set(`GET /api/history/previews/${id}/clients`, searchDelay);
      await page.locator("#history-client-search").fill("Nora");
      await page.locator("#history-client-search-button").click();
      await page.locator("#history-cancel-choice").click();
      const searchResponse = page.waitForResponse((r) =>
        r.url().includes(`/${id}/clients?`),
      );
      searchDelay.release();
      await searchResponse;
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(done)),
      );
      assert.equal(
        await page.locator("#history-choice-panel").isVisible(),
        false,
      );
      const pageDelay = deferred();
      f.waits.push(pageDelay);
      f.delays.set(`GET /api/history/previews/${id}/page`, pageDelay);
      await page.locator("#history-refresh").click();
      await navigate(page, "calendar");
      await page.locator("#calendar-grid").waitFor();
      const pageResponse = page.waitForResponse((r) =>
        r.url().includes(`/${id}/page?`),
      );
      pageDelay.release();
      await pageResponse;
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      assert.equal(await page.locator("#calendar-grid").isVisible(), true);
      assert.equal(await page.locator(".history-preview").count(), 0);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/choices")).length,
        0,
      );
    },
  );

  await scenario(
    "changed client snapshot rebuilds the review and marks the old draft choice stale",
    desktop,
    async ({ page, f }) => {
      await openHistory(page, f);
      await readColumns(page);
      await buildPreview(page);
      await page.locator('[data-history-details="2"]').click();
      await page
        .locator(
          '#history-row-detail-2 [data-history-use-candidate="history-qa-client"]',
        )
        .click();
      await page.locator("#history-apply-choice").click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-history-row="2"]')
          ?.textContent.includes("Draft match:"),
      );
      f.clients[0].version++;
      f.clientRevision++;
      await page.locator("#history-refresh").click();
      await page.locator("#history-error").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#history-error-text").innerText(),
        /Client list changed/,
      );
      await page.locator("#history-retry").click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-history-row="2"]')
          ?.textContent.includes("review changed profile"),
      );
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/finalize")).length,
        2,
        "Stale index is rebuilt rather than repeatedly reading it",
      );
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/choices")).length,
        1,
        "Rebuild never silently reapproves the changed profile",
      );
    },
  );

  for (const device of [desktop, phone]) {
    await scenario(
      "archive requires acknowledgement, preserves original statuses and keeps client data unchanged",
      device,
      async ({ page, f }) => {
        const beforeClients = structuredClone(f.clients);
        await openHistory(page, f);
        await prepareArchivePreview(page);
        await reviewArchive(page);
        assert.equal(f.archive.length, 0, "Review never writes archived rows");
        assert.equal(
          await page.locator("#history-confirm-import").isEnabled(),
          false,
          "Confirmation needs explicit acknowledgement",
        );
        for (const status of ["No Show", "Cancelled", "Started"])
          assert.ok(
            (
              await page.locator("#history-import-status-counts").innerText()
            ).includes(status),
          );
        assert.match(
          await page.locator("#history-import-review").innerText(),
          /original|source status/i,
        );
        await inViewport(
          page,
          page.locator("#history-import-ack"),
          "Archive acknowledgement",
        );
        await noHorizontalOverflow(page);
        await capture(page, device.name + "-history-archive-confirmation");
        await confirmArchive(page);
        assert.equal(f.archive.length, 3);
        assert.deepEqual(
          f.archive.map((row) => row.sourceStatus),
          ["No Show", "Cancelled", "Started"],
        );
        assert.deepEqual(
          f.archive.map((row) => row.record.completionState),
          ["not_completed", "not_completed", "unknown"],
        );
        assert.ok(
          f.archive.every((row) => row.record.scheduledAt === null),
          "Unknown source timezone remains unknown",
        );
        assert.deepEqual(
          f.clients,
          beforeClients,
          "Archive confirmation never rewrites client notes or contacts",
        );
        assert.equal(
          f.writes.filter((r) => r.path.endsWith("/confirm")).length,
          1,
        );
        await inViewport(
          page,
          page.locator("#history-import-receipt"),
          "Archive receipt",
        );
        await capture(page, device.name + "-history-archive-receipt");
        await openClientHistory(page);
        await page.waitForFunction(
          () =>
            document.querySelectorAll("[data-client-history-row]").length === 3,
        );
        const archived = await page.locator(".client-history").innerText();
        for (const status of ["No Show", "Cancelled", "Started"])
          assert.ok(archived.includes(status));
        assert.match(archived, /Original no-show treatment/);
        assert.match(
          await page.locator("#drawer-content").innerText(),
          /0 completed visits/,
        );
        await page.locator("#client-history-summary").scrollIntoViewIfNeeded();
        await noHorizontalOverflow(page);
        await capture(page, device.name + "-history-newly-archived-profile");
      },
    );
  }

  await scenario(
    "renamed and reordered reports show duplicates while changed status and client remain visible conflicts",
    desktop,
    async ({ page, f }) => {
      await openHistory(page, f);
      await prepareArchivePreview(page);
      await reviewArchive(page);
      await confirmArchive(page);
      await page.locator("#history-new-file").click();
      await prepareArchivePreview(page, {
        bytes: archiveCSV({ reordered: true }),
        filename: "overlapping-renamed-report.csv",
      });
      await reviewArchive(page);
      const repeated = [...f.archiveReviews.values()].at(-1).response;
      assert.deepEqual(repeated.counts, {
        selected: 3,
        importable: 0,
        duplicates: 3,
        blocked: 0,
      });
      assert.match(
        await page.locator("#history-import-counts").innerText(),
        /Already imported/i,
      );
      assert.equal(f.archive.length, 3);
      await page.locator("#history-cancel-import-review").click();
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        1,
        "Cancelling duplicate review does not reconfirm",
      );
      await reviewArchive(page);
      await confirmArchive(page);
      assert.equal(
        f.archive.length,
        3,
        "An all-duplicate confirmation does not append records",
      );
      assert.match(
        await page.locator("#history-import-receipt").innerText(),
        /0 imported[\s\S]*3 already imported/,
      );
      await page.locator("#history-new-file").click();
      await prepareArchivePreview(page, {
        bytes: archiveCSV({ changedStatus: true }),
        filename: "updated-report.csv",
      });
      await reviewArchive(page);
      assert.match(
        await page.locator("#history-import-review").innerText(),
        /changed content|conflict/i,
      );
      assert.equal(
        await page.locator("#history-confirm-import").isEnabled(),
        false,
      );
      assert.deepEqual(
        f.archive.map((r) => r.sourceStatus),
        ["No Show", "Cancelled", "Started"],
      );
      await capture(page, "desktop-history-archive-conflict");
      await page.locator("#history-cancel-import-review").click();
      await page.locator("#history-new-file").click();
      await prepareArchivePreview(page, { clientId: "history-qa-other" });
      await reviewArchive(page);
      assert.equal(
        [...f.archiveReviews.values()].at(-1).response.counts.blocked,
        3,
      );
      assert.equal(
        await page.locator("#history-confirm-import").isEnabled(),
        false,
      );
      assert.ok(f.archive.every((r) => r.clientId === client.id));
      await page.locator("#history-cancel-import-review").click();
      await page.locator("#history-new-file").click();
      await prepareArchivePreview(page, {
        bytes: archiveCSV({ missingReference: true }),
      });
      await reviewArchive(page);
      assert.match(
        await page.locator("#history-import-review").innerText(),
        /stable source reference/i,
      );
      assert.equal(
        await page.locator("#history-confirm-import").isEnabled(),
        false,
      );
      assert.equal(
        f.archive.length,
        3,
        "A missing reference cannot append ambiguous history",
      );
    },
  );

  await scenario(
    "lost archive acknowledgement retries the exact request after preview removal",
    phone,
    async ({ page, f }) => {
      await openHistory(page, f);
      await prepareArchivePreview(page);
      await reviewArchive(page);
      f.loseArchiveAcknowledgement = true;
      await page.locator("#history-import-ack").check();
      await page.locator("#history-confirm-import").click();
      await page.locator("#history-error").waitFor({ state: "visible" });
      assert.equal(f.archive.length, 3);
      assert.equal(
        f.previews.size,
        0,
        "Expired or removed preview does not invalidate a stored receipt",
      );
      await page.locator("#history-retry").click();
      await page
        .locator("#history-import-receipt")
        .waitFor({ state: "visible" });
      await page
        .locator("#history-after-import-new-file")
        .waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#history-error").isVisible(),
        false,
        "A recovered receipt is success even when its temporary preview is gone",
      );
      assert.equal(
        await page.locator("[data-history-receipt-client]").first().isEnabled(),
        true,
      );
      const requests = f.writes.filter((r) => r.path.endsWith("/confirm"));
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].body, requests[1].body);
      assert.equal(f.archive.length, 3);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/review")).length,
        1,
        "Checking receipt does not create a new confirmation",
      );
    },
  );

  await scenario(
    "expired review renews its request, stale confirmation stays uncommitted and delayed review cannot replace navigation",
    phone,
    async ({ page, f }) => {
      await openHistory(page, f);
      await prepareArchivePreview(page);
      f.failures.set("POST /api/history/imports/review", {
        status: 410,
        message: "This import review expired. Prepare a new review.",
      });
      await page.locator("#history-review-import").click();
      await page.locator("#history-error").waitFor({ state: "visible" });
      const expiredRequest = f.writes
        .filter((r) => r.path.endsWith("/review"))
        .at(-1).body.requestId;
      await page.locator("#history-retry").click();
      await page.locator('[data-history-row="2"]').waitFor();
      await reviewArchive(page);
      assert.notEqual(
        f.writes.filter((r) => r.path.endsWith("/review")).at(-1).body
          .requestId,
        expiredRequest,
        "An expired review cannot trap the user on its old request ID",
      );
      f.rejectConfirm = true;
      await page.locator("#history-import-ack").check();
      await page.locator("#history-confirm-import").click();
      await page.locator("#history-error").waitFor({ state: "visible" });
      assert.equal(f.archive.length, 0);
      assert.match(
        await page.locator("#history-error-text").innerText(),
        /changed/,
      );
      assert.equal(
        await page.locator("#history-import-review").isVisible(),
        false,
        "A stale confirmation cannot keep an actionable old review",
      );
      const delay = deferred();
      f.waits.push(delay);
      f.delays.set("POST /api/history/imports/review", delay);
      await page.locator("#history-review-import").click();
      await navigate(page, "calendar");
      await page.locator("#calendar-grid").waitFor();
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/history/imports/review"),
      );
      delay.release();
      await response;
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      assert.equal(await page.locator("#calendar-grid").isVisible(), true);
      assert.equal(await page.locator("#history-import-review").count(), 0);
      assert.equal(f.archive.length, 0);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        1,
      );
    },
  );

  for (const role of ["owner", "reception"]) {
    await scenario(
      `${role} client profile pages original source statuses without implying completed visits`,
      phone,
      async ({ page, f }) => {
        f.role = role;
        seedProfileArchive(f);
        await openApp(page, f);
        await openClientHistory(page);
        await page.locator("[data-client-history-row]").first().waitFor();
        assert.equal(
          await page.locator("[data-client-history-row]").count(),
          25,
        );
        const summary = await page
          .locator("#client-history-summary")
          .innerText();
        for (const status of ["No Show", "Cancelled", "Started", "Confirmed"])
          assert.ok(summary.includes(status));
        assert.ok(summary.includes("28"));
        assert.match(
          await page.locator("#drawer-content").innerText(),
          /0 completed visits/,
          "Native completed visits are not inflated by historical source statuses",
        );
        assert.equal(await page.locator("#history-confirm-import").count(), 0);
        if (role === "reception") {
          assert.doesNotMatch(
            await page.locator(".client-history").innerText(),
            /OWNER-ONLY-SOURCE-RAW|source net sales/i,
          );
          assert.equal(await page.locator("#history-preview-open").count(), 0);
        }
        await inViewport(
          page,
          page.locator("#client-history-next"),
          "Next source-history page",
        );
        await page.locator("#client-history-next").click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll("[data-client-history-row]").length === 3,
        );
        assert.match(
          await page.locator(".client-history").innerText(),
          /Final paginated source treatment/,
        );
        await noHorizontalOverflow(page);
        await page.locator("#client-history-summary").scrollIntoViewIfNeeded();
        await capture(page, `phone-${role}-archived-profile-history`);
        await page.locator("#client-history-prev").click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll("[data-client-history-row]").length ===
            25,
        );
        assert.equal(
          f.writes.length,
          0,
          "Viewing profile history performs no mutations",
        );
      },
    );
  }

  for (const role of ["reception", "therapist"]) {
    await scenario(
      `${role} has no history entry or history requests`,
      phone,
      async ({ page, f }) => {
        f.role = role;
        await openApp(page, f);
        if (role === "reception") {
          await navigate(page, "clients");
          await page.locator("#client-results").waitFor();
        }
        assert.equal(await page.locator("#history-preview-open").count(), 0);
        assert.equal(await page.locator(".history-preview").count(), 0);
        assert.equal(
          f.requests.filter((r) => r.path.startsWith("/api/history/")).length,
          0,
        );
      },
    );
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
if (failures.length)
  throw new Error(
    `${failures.length} history browser scenarios failed: ${JSON.stringify(failures)}`,
  );
console.log(
  `History browser acceptance: ${passed} passed. Chromium emulation and fictional API fixtures only.`,
);
