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
    jobs: new Map(),
    jobStarts: new Map(),
    jobTransitions: [],
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
  if (url.pathname.startsWith("/api/history/jobs"))
    return jobAPI(f, url, method, body, json);
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
function archiveRow(f, preview, number) {
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
    disposition: issues.length ? "blocked" : existing ? "duplicate" : "import",
    issues,
    nativeOverlapIds: [],
    // Internal fixture-only evidence is removed from the HTTP response.
    fixtureEvidence: { key, fingerprint, record, existing },
  };
}
// Fictional bounded jobs drive the UI; real Worker/D1 tests prove transaction safety.
function jobMetadata(j) {
  const { previewSnapshot, rows, requests, clientRevision, ...metadata } = j;
  return structuredClone(metadata);
}
function archiveCommit(f, entry) {
  if (entry.disposition === "duplicate") return;
  const evidence = entry.fixtureEvidence;
  assert.ok(
    !f.archive.some((r) => r.key === evidence.key),
    "Fixture job cannot append the same source key twice",
  );
  f.archive.push({
    ...evidence,
    id: "fictional-archive-" + (f.archive.length + 1),
    clientId: entry.client.id,
    sourceStatus: entry.sourceStatus,
    date: entry.date,
    start: entry.start,
    duration: entry.duration,
    serviceName: entry.serviceName,
    therapistName: entry.therapistName,
  });
}
async function jobAPI(f, url, method, body, json) {
  if (f.role !== "owner") return json({ error: "Owner access required" }, 403);
  const prefix = "/api/history/jobs";
  if (url.pathname === prefix && method === "GET")
    return json({ jobs: [...f.jobs.values()].map(jobMetadata) });
  if (url.pathname === prefix && method === "POST") {
    assert.deepEqual(Object.keys(body).sort(), [
      "previewId",
      "requestId",
      "version",
    ]);
    assert.match(body.requestId, /^[a-f0-9-]{36}$/i);
    const prior = f.jobStarts.get(body.requestId);
    if (prior) {
      assert.deepEqual(body, prior.body);
      return json({ job: jobMetadata(f.jobs.get(prior.id)) });
    }
    if (
      [...f.jobs.values()].filter((j) =>
        ["reviewing", "ready", "importing"].includes(j.phase),
      ).length >= 3
    )
      return json(
        {
          error:
            "Three import jobs are already active. Cancel an unused job first.",
        },
        409,
      );
    const preview = f.previews.get(body.previewId);
    assert.ok(preview, "A whole-report job starts from an existing preview");
    assert.equal(body.version, preview.version);
    const j = {
      id: "fictional-job-" + (f.jobs.size + 1),
      previewId: preview.id,
      version: 1,
      source: preview.config.source,
      phase: "reviewing",
      total: preview.plan.rows.length,
      reviewed: 0,
      processed: 0,
      created: 0,
      duplicates: 0,
      counts: {
        selected: preview.plan.rows.length,
        importable: 0,
        duplicates: 0,
        blocked: 0,
        unmatched: 0,
        conflicts: 0,
        invalid: 0,
      },
      statusCounts: [],
      canConfirm: false,
      confirmationToken: null,
      expiresAt: Date.now() + 86400000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reason: null,
      requiresNewReview: false,
      clientRevision: f.clientRevision,
      previewSnapshot: structuredClone(preview),
      rows: [],
      requests: new Map(),
    };
    f.jobs.set(j.id, j);
    f.jobStarts.set(body.requestId, { body: structuredClone(body), id: j.id });
    return json({ job: jobMetadata(j) }, 201);
  }
  const [id, action] = url.pathname.slice(prefix.length + 1).split("/");
  const j = f.jobs.get(id);
  if (!j) return json({ error: "Import job not found" }, 404);
  if (!action && method === "GET") {
    const page = Number(url.searchParams.get("page") || 0);
    const filter = url.searchParams.get("filter") || "all";
    assert.ok(["all", "blocked"].includes(filter));
    const filteredRows =
      filter === "blocked"
        ? j.rows.filter((row) => row.disposition === "blocked")
        : j.rows;
    return json({
      job: jobMetadata(j),
      page,
      pageSize: 50,
      filter,
      filteredTotal: filter === "blocked" ? filteredRows.length : j.total,
      totalPages: Math.ceil(
        (filter === "blocked" ? filteredRows.length : j.total) / 50,
      ),
      rows: filteredRows
        .slice(page * 50, (page + 1) * 50)
        .map(({ fixtureEvidence, ...row }) => ({
          ...row,
          result:
            row.row - 2 < j.processed
              ? {
                  id: "fixture-archive-result",
                  disposition:
                    row.disposition === "import" ? "imported" : "duplicate",
                }
              : null,
        })),
    });
  }
  assert.equal(method, "POST");
  assert.match(body.requestId, /^[a-f0-9-]{36}$/i);
  const key = action + ":" + body.requestId,
    prior = j.requests.get(key);
  if (prior) {
    assert.deepEqual(
      body,
      prior.body,
      "Uncertain job mutation is retried with its exact body and ID",
    );
    return json({ job: jobMetadata(j), repeated: true });
  }
  if (body.version !== j.version)
    return json({ error: "Job version changed. Reload the saved job." }, 409);
  if (action === "confirm") {
    assert.equal(j.phase, "ready");
    assert.equal(j.canConfirm, true);
    assert.equal(body.confirmationToken, j.confirmationToken);
    assert.equal(body.acknowledgeReview, true);
    if (f.rejectConfirm) {
      f.rejectConfirm = false;
      return json(
        { error: "Client data changed. Review the full report again." },
        409,
      );
    }
    j.phase = "importing";
    j.canConfirm = false;
    j.expiresAt = null;
    j.confirmationToken = null;
  } else if (action === "cancel") {
    j.phase = "cancelled";
    j.canConfirm = false;
  } else if (action === "step") {
    assert.deepEqual(Object.keys(body).sort(), ["requestId", "version"]);
    const gate = f.jobStepGate;
    if (
      gate &&
      gate.phase === j.phase &&
      gate.offset === (j.phase === "reviewing" ? j.reviewed : j.processed)
    ) {
      f.jobStepGate = null;
      gate.entered.release();
      await gate.wait.promise;
    }
    if (
      j.clientRevision !== f.clientRevision ||
      (j.phase === "importing" && f.invalidateJobAt === j.processed)
    ) {
      j.phase = "paused";
      j.reason =
        "Client or archive data changed. Start a new review; already imported records remain saved.";
      j.requiresNewReview = true;
      j.canConfirm = false;
    } else if (j.phase === "reviewing") {
      const numbers = j.previewSnapshot.plan.rows
        .slice(j.reviewed, j.reviewed + 50)
        .map((r) => r.record.row);
      const rows = numbers.map((n) => archiveRow(f, j.previewSnapshot, n));
      for (const r of rows) {
        if (r.disposition !== "import") continue;
        const prior = [
          ...j.rows,
          ...rows.filter((other) => other.row < r.row),
        ].find(
          (other) =>
            other.fixtureEvidence.key === r.fixtureEvidence.key &&
            other.fixtureEvidence.fingerprint ===
              r.fixtureEvidence.fingerprint &&
            other.disposition !== "blocked",
        );
        if (prior) r.disposition = "duplicate";
      }
      j.rows.push(...rows);
      j.reviewed += rows.length;
      for (const r of rows) {
        if (r.disposition === "import") j.counts.importable++;
        else if (r.disposition === "duplicate") j.counts.duplicates++;
        else {
          j.counts.blocked++;
          if (r.issues.some((issue) => issue.code === "client_unresolved"))
            j.counts.unmatched++;
          else if (r.issues.some((issue) => issue.code === "archive_conflict"))
            j.counts.conflicts++;
          else j.counts.invalid++;
        }
      }
      j.statusCounts = statusCounts(j.rows);
      if (j.reviewed === j.total) {
        j.phase = "ready";
        j.canConfirm = j.counts.blocked === 0;
        j.confirmationToken = "fixture-token-" + j.id;
      }
    } else if (j.phase === "importing") {
      const rows = j.rows.slice(j.processed, j.processed + 50);
      for (const row of rows) {
        archiveCommit(f, row);
        if (row.disposition === "import") j.created++;
        else j.duplicates++;
      }
      j.processed += rows.length;
      if (j.processed === j.total) j.phase = "completed";
    } else
      return json(
        { error: "This saved job cannot process another step." },
        409,
      );
  } else throw new Error("Unknown job action: " + action);
  j.version++;
  j.updatedAt = new Date().toISOString();
  const response = { job: jobMetadata(j) };
  j.requests.set(key, {
    body: structuredClone(body),
    response: structuredClone(response),
  });
  f.jobTransitions.push({ id: j.id, action, ...jobMetadata(j) });
  if (action === "step" && f.loseJobStepAt === j.processed && j.processed > 0) {
    f.loseJobStepAt = null;
    if (f.expirePreviewOnLostStep) f.previews.delete(j.previewId);
    return json(
      {
        error:
          "Fictional connection lost after the import step. Resume the saved job safely.",
      },
      503,
    );
  }
  return json(response);
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
function bulkCSV(count, first = 0, duplicateAcrossBoundary = false) {
  const changes = {};
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  for (let i = 0; i < count; i++) {
    const n = first + i,
      date = new Date(Date.UTC(2022, 0, 1 + n));
    const localDate = `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    const status = ["No Show", "Cancelled", "Started", "Confirmed"][n % 4];
    changes[i] = {
      0: "BULK-" + String(n + 1).padStart(6, "0"),
      3: status,
      4: "04 Jan 2021, 5:43pm",
      5: localDate + ", 10:00am",
      6: status === "Cancelled" ? localDate + ", 9:00am" : "",
      7: "Archived fictional treatment " + ((n % 4) + 1),
    };
  }
  if (duplicateAcrossBoundary) changes[50] = { ...changes[0] };
  return fictionalCSV(count, changes);
}
async function prepareBulkPreview(
  page,
  f,
  count,
  first = 0,
  duplicateAcrossBoundary = false,
) {
  await readColumns(
    page,
    bulkCSV(count, first, duplicateAcrossBoundary),
    "whole-fictional-report.csv",
  );
  await buildPreview(page);
  const preview = [...f.previews.values()].at(-1);
  assert.equal(
    preview.cells.length,
    count,
    "The actual UI uploaded every CSV row",
  );
  // Represents earlier owner-approved matches in a saved preview. Matching endpoints
  // and their 50-row limits retain their independent browser and D1 coverage.
  for (const entry of preview.plan.rows)
    preview.choices.set(entry.record.row, {
      clientId: client.id,
      clientVersion: client.version,
      name: client.name,
      stale: false,
    });
  preview.version++;
  await page.locator("#history-refresh").click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-history-row="2"]')
      ?.textContent.includes("Draft match:"),
  );
  return preview;
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
  const ready = page.waitForResponse(
    async (response) =>
      /\/api\/history\/jobs\/[^/]+\/step$/.test(
        new URL(response.url()).pathname,
      ) &&
      response.ok() &&
      (await response.json()).job?.phase === "ready",
  );
  await page.locator("#history-review-import").click();
  await ready;
  await page.locator("#history-confirm-import").waitFor({ state: "visible" });
}
async function completedJobResponse(page) {
  return page.waitForResponse(
    async (response) =>
      /\/api\/history\/jobs\/[^/]+\/step$/.test(
        new URL(response.url()).pathname,
      ) &&
      response.ok() &&
      (await response.json()).job?.phase === "completed",
  );
}
async function confirmArchive(page) {
  await page.locator("#history-import-ack").check();
  const completed = completedJobResponse(page);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/api\/history\/jobs\/[^/]+\/confirm$/.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "POST",
    ),
    page.locator("#history-confirm-import").click(),
  ]);
  assert.ok(response.ok(), "The current confirmation succeeds");
  const confirmed = (await response.json()).job;
  assert.equal(confirmed.phase, "importing");
  const receipt = (await (await completed).json()).job;
  assert.equal(receipt.id, confirmed.id);
  await page.waitForFunction(
    (id) =>
      document.querySelector(
        "#history-import-receipt .history-receipt-id strong",
      )?.textContent === id,
    receipt.id,
  );
  await page.locator("#history-import-receipt").waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector("[data-history-receipt-client]")?.disabled ===
      false,
  );
  return { ...receipt, importId: receipt.id };
}
async function backToMatches(page) {
  await page.locator("#history-job-back-matches").click();
  await page.locator("#history-review-import").waitFor({ state: "visible" });
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
      const firstReceipt = await confirmArchive(page);
      await page.locator("#history-job-new-file").click();
      assert.equal(
        await page.locator("#history-import-receipt").count(),
        0,
        "A new report clears the preceding receipt",
      );
      await prepareArchivePreview(page, {
        bytes: archiveCSV({ reordered: true }),
        filename: "overlapping-renamed-report.csv",
      });
      await reviewArchive(page);
      const repeated = [...f.jobs.values()].at(-1);
      assert.deepEqual(
        Object.fromEntries(
          ["selected", "importable", "duplicates", "blocked"].map((k) => [
            k,
            repeated.counts[k],
          ]),
        ),
        {
          selected: 3,
          importable: 0,
          duplicates: 3,
          blocked: 0,
        },
      );
      assert.match(
        await page.locator("#history-import-counts").innerText(),
        /Duplicates to skip/i,
      );
      assert.equal(f.archive.length, 3);
      await backToMatches(page);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        1,
        "Cancelling duplicate review does not reconfirm",
      );
      await reviewArchive(page);
      const duplicateReceipt = await confirmArchive(page);
      assert.notEqual(duplicateReceipt.importId, firstReceipt.importId);
      assert.equal(duplicateReceipt.created, 0);
      assert.equal(duplicateReceipt.duplicates, 3);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        2,
        "The second confirmation response is consumed before checking its receipt",
      );
      assert.equal(
        f.archive.length,
        3,
        "An all-duplicate confirmation does not append records",
      );
      assert.match(
        await page.locator("#history-import-receipt").innerText(),
        /0 imported[\s\S]*3 duplicates skipped/,
      );
      await page.locator("#history-job-new-file").click();
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
      await backToMatches(page);
      await page.locator("#history-new-file").click();
      await prepareArchivePreview(page, { clientId: "history-qa-other" });
      await reviewArchive(page);
      assert.equal([...f.jobs.values()].at(-1).counts.blocked, 3);
      assert.equal(
        await page.locator("#history-confirm-import").isEnabled(),
        false,
      );
      assert.ok(f.archive.every((r) => r.clientId === client.id));
      await backToMatches(page);
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
      f.loseJobStepAt = 3;
      f.expirePreviewOnLostStep = true;
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
      await page.locator("#history-job-new-file").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#history-error").isVisible(),
        false,
        "A recovered receipt is success even when its temporary preview is gone",
      );
      assert.equal(
        await page.locator("[data-history-receipt-client]").first().isEnabled(),
        true,
      );
      const requests = f.writes.filter((r) => r.path.endsWith("/step"));
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[1].body, requests[2].body);
      assert.equal(f.archive.length, 3);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        1,
        "Resuming an uncertain step does not create another confirmation",
      );
    },
  );

  await scenario(
    "expired review renews its request, stale confirmation stays uncommitted and delayed review cannot replace navigation",
    phone,
    async ({ page, f }) => {
      await openHistory(page, f);
      await prepareArchivePreview(page);
      f.failures.set("POST /api/history/jobs", {
        status: 410,
        message: "This import review expired. Prepare a new review.",
      });
      await page.locator("#history-review-import").click();
      await page.locator("#history-error").waitFor({ state: "visible" });
      const expiredRequest = f.writes
        .filter((r) => r.path === "/api/history/jobs")
        .at(-1).body.requestId;
      await page.locator("#history-retry").click();
      await page.locator('[data-history-row="2"]').waitFor();
      await reviewArchive(page);
      assert.notEqual(
        f.writes.filter((r) => r.path === "/api/history/jobs").at(-1).body
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
        await page.locator("#history-confirm-import").isEnabled(),
        false,
        "A stale confirmation cannot leave an enabled confirmation",
      );
      await backToMatches(page);
      const delay = deferred();
      f.waits.push(delay);
      f.delays.set("POST /api/history/jobs", delay);
      await page.locator("#history-review-import").click();
      await navigate(page, "calendar");
      await page.locator("#calendar-grid").waitFor();
      const response = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/history/jobs",
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

  for (const device of [desktop, phone]) {
    await scenario(
      "one confirmation imports 1205 report rows in bounded steps and overlapping reports skip duplicates",
      device,
      async ({ page, f }) => {
        const before = structuredClone(f.clients);
        await openHistory(page, f);
        await prepareBulkPreview(page, f, 1205, 0, true);
        await page.locator("#history-next").click();
        await page.locator('[data-history-row="52"]').waitFor();
        assert.equal(
          await page.locator("[data-history-select]:checked").count(),
          0,
        );
        await reviewArchive(page);
        const job = [...f.jobs.values()].at(-1);
        assert.equal(job.total, 1205);
        assert.equal(job.reviewed, 1205);
        assert.equal(job.counts.importable, 1204);
        assert.equal(
          job.counts.duplicates,
          1,
          "Duplicate at rows 2/52 spans the first processing boundary",
        );
        assert.equal(job.counts.blocked, 0);
        assert.equal(
          f.archive.length,
          0,
          "Reviewing the entire report never writes archive rows",
        );
        assert.equal(
          await page.locator("#history-confirm-import").isEnabled(),
          false,
        );
        assert.equal(
          await page.locator("[data-history-import-row]").count(),
          50,
          "Large review DOM stays paged",
        );
        await inViewport(
          page,
          page.locator("#history-import-ack"),
          "Whole-report acknowledgement",
        );
        await noHorizontalOverflow(page);
        await capture(page, device.name + "-history-whole-report-confirmation");
        const receipt = await confirmArchive(page);
        assert.equal(receipt.processed, 1205);
        assert.equal(receipt.created, 1204);
        assert.equal(receipt.duplicates, 1);
        assert.equal(f.archive.length, 1204);
        assert.equal(new Set(f.archive.map((r) => r.key)).size, 1204);
        assert.equal(
          f.writes.filter((r) => r.path.endsWith("/confirm")).length,
          1,
        );
        const transitions = f.jobTransitions.filter(
          (t) => t.id === job.id && t.action === "step",
        );
        let reviewed = 0,
          processed = 0;
        for (const t of transitions) {
          assert.ok(
            t.reviewed >= reviewed && t.reviewed - reviewed <= 50,
            "Review progress advances by at most 50",
          );
          assert.ok(
            t.processed >= processed && t.processed - processed <= 50,
            "Saved progress advances by at most 50",
          );
          assert.equal(
            t.created + t.duplicates,
            t.processed,
            "Counters reconcile at every step",
          );
          reviewed = t.reviewed;
          processed = t.processed;
        }
        assert.equal(
          transitions.length,
          50,
          "1205 rows require 25 review and 25 import steps",
        );
        for (const r of f.writes.filter((r) =>
          r.path.startsWith("/api/history/jobs"),
        ))
          assert.ok(
            Buffer.byteLength(JSON.stringify(r.body)) < 1000,
            "Job requests do not resend the complete report",
          );
        assert.deepEqual(f.clients, before);
        assert.ok(
          f.writes.every((r) => r.path.startsWith("/api/history/")),
          "No clients or live bookings are written",
        );
        await inViewport(
          page,
          page.locator("#history-import-receipt"),
          "Whole report receipt",
        );
        await capture(page, device.name + "-history-whole-report-receipt");
        await page.locator("#history-job-new-file").click();
        await prepareBulkPreview(page, f, 137, 1150);
        await reviewArchive(page);
        const overlap = [...f.jobs.values()].at(-1);
        assert.equal(overlap.counts.importable, 82);
        assert.equal(overlap.counts.duplicates, 55);
        const next = await confirmArchive(page);
        assert.equal(next.created, 82);
        assert.equal(next.duplicates, 55);
        assert.equal(
          f.archive.length,
          1286,
          "The overlapping report adds only its genuinely new references",
        );
      },
    );
  }
  await scenario(
    "a saved import pauses after an in-flight step and resumes after reload without another confirmation",
    phone,
    async ({ page, f }) => {
      await openHistory(page, f);
      await prepareBulkPreview(page, f, 137);
      await reviewArchive(page);
      const job = [...f.jobs.values()].at(-1);
      const gate = {
        phase: "importing",
        offset: 50,
        entered: deferred(),
        wait: deferred(),
      };
      f.jobStepGate = gate;
      f.waits.push(gate.wait);
      await page.locator("#history-import-ack").check();
      await page.locator("#history-confirm-import").click();
      let gateTimeout;
      try {
        await Promise.race([
          gate.entered.promise,
          new Promise((_, reject) => {
            gateTimeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Import did not reach the controlled in-flight step",
                  ),
                ),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(gateTimeout);
      }
      assert.equal(f.archive.length, 50);
      await page.locator("#history-job-pause").click();
      gate.wait.release();
      await page.locator("#history-job-resume").waitFor({ state: "visible" });
      assert.equal(
        job.processed,
        100,
        "A permitted in-flight step settles before local pause",
      );
      assert.equal(f.archive.length, 100);
      assert.match(
        await page.locator("#history-job-progress-text").innerText(),
        /100 of 137 processed/,
      );
      await inViewport(
        page,
        page.locator("#history-job-resume"),
        "Resume saved import",
      );
      await noHorizontalOverflow(page);
      await capture(page, "phone-history-paused-whole-report");
      f.previews.delete(job.previewId);
      await page.reload();
      await navigate(page, "clients");
      await page.locator("#history-preview-open").click();
      await page.locator(`[data-history-job-open="${job.id}"]`).waitFor();
      assert.equal(
        f.archive.length,
        100,
        "Closing/reloading does not claim unattended background completion",
      );
      const done = completedJobResponse(page);
      await page.locator(`[data-history-job-open="${job.id}"]`).click();
      await done;
      await page.locator("#history-import-receipt").waitFor();
      assert.equal(job.processed, 137);
      assert.equal(f.archive.length, 137);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        1,
      );
      assert.equal(
        f.writes.filter((r) => r.path === "/api/history/jobs").length,
        1,
      );
      assert.equal(
        f.previews.size,
        0,
        "Confirmed frozen job survives preview removal",
      );
    },
  );
  await scenario(
    "an unmatched row beyond the first thousand blocks whole-report confirmation and remains discoverable",
    desktop,
    async ({ page, f }) => {
      await openHistory(page, f);
      const preview = await prepareBulkPreview(page, f, 1205);
      preview.choices.delete(1001);
      preview.version++;
      const refreshed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith("/page") &&
          response.request().method() === "GET",
      );
      await page.locator("#history-refresh").click();
      await refreshed;
      await page.waitForFunction(
        () =>
          document.querySelector("#history-review-import")?.disabled === false,
      );
      await reviewArchive(page);
      const job = [...f.jobs.values()].at(-1);
      assert.equal(job.reviewed, 1205);
      assert.equal(job.counts.blocked, 1);
      assert.equal(
        await page.locator("#history-confirm-import").isEnabled(),
        false,
      );
      assert.equal(await page.locator("#history-import-ack").count(), 0);
      await page.locator("#history-job-page").fill("20");
      await page.locator("#history-job-jump button").click();
      await page.locator('[data-history-import-row="952"]').waitFor();
      const issue = page.locator('[data-history-import-row="1001"]');
      assert.match(
        await issue.innerText(),
        /No saved client match|Choose a current client explicitly/,
      );
      await page.locator("#history-job-filter").selectOption("blocked");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-history-import-row]").length === 1,
      );
      assert.equal(
        await issue.count(),
        1,
        "Blocked-only view finds an issue beyond the first thousand rows",
      );
      assert.equal(
        job.total,
        1205,
        "Filtering does not redefine the report confirmation scope",
      );
      await inViewport(page, issue, "Later unmatched source row");
      await capture(page, "desktop-history-late-unmatched-row");
      assert.equal(f.archive.length, 0);
      assert.equal(
        f.writes.filter((r) => r.path.endsWith("/confirm")).length,
        0,
      );
    },
  );
  await scenario(
    "changed data after partial import exposes honest counts and requires a fresh review",
    desktop,
    async ({ page, f }) => {
      await openHistory(page, f);
      await prepareBulkPreview(page, f, 137);
      await reviewArchive(page);
      f.invalidateJobAt = 50;
      await page.locator("#history-import-ack").check();
      await page.locator("#history-confirm-import").click();
      await page
        .locator('#history-import-review[data-job-phase="paused"]')
        .waitFor();
      const stopped = [...f.jobs.values()].at(-1);
      assert.equal(stopped.phase, "paused");
      assert.equal(stopped.requiresNewReview, true);
      assert.equal(stopped.processed, 50);
      assert.equal(f.archive.length, 50);
      assert.match(
        await page.locator("#history-import-review").innerText(),
        /50 already imported[\s\S]*saved records remain/i,
      );
      assert.equal(
        await page.locator("#history-job-resume").count(),
        0,
        "An invalidated frozen plan cannot silently resume",
      );
      await capture(page, "desktop-history-partial-import-needs-review");
      f.invalidateJobAt = null;
      await backToMatches(page);
      await reviewArchive(page);
      const fresh = [...f.jobs.values()].at(-1);
      assert.notEqual(fresh.id, stopped.id);
      assert.equal(fresh.counts.duplicates, 50);
      assert.equal(fresh.counts.importable, 87);
      const done = await confirmArchive(page);
      assert.equal(done.created, 87);
      assert.equal(done.duplicates, 50);
      assert.equal(f.archive.length, 137);
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
