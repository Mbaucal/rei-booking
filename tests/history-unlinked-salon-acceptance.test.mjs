import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { digest, token } from "../src/security.mjs";
import {
  parseHistoryCSV,
  freshaHistoryPreset,
} from "../public/history-preview-helpers.js";

// Fictional export, including a repeated reference after the first 50-row step.
// Exercise the real preset, upload, bulk archive, catalogue and report APIs.
const headers = [
  "Appt. ref.",
  "Client",
  "Team member",
  "Status",
  "Created date",
  "Scheduled date",
  "Cancelled date",
  "Category",
  "Service",
  "Duration (mins)",
  "Appt. slot",
  "Created by",
  "Cancelled by",
  "Location",
  "Net sales",
  "Cancellation reason",
  "Fees charged",
  "Upfront payments",
];
const statuses = ["New", "Confirmed", "Started", "Cancelled", "No Show"];
const uniqueRows = Array.from({ length: 52 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 0, index + 1)).toLocaleDateString(
    "en-GB",
    { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" },
  );
  return [
    `000${index}`,
    `Fictional Client ${String(index).padStart(2, "0")}`,
    `Fictional Therapist ${index % 3}`,
    statuses[index % statuses.length],
    "",
    `${date}, 10:00am`,
    "",
    "Fictional category",
    `Fictional Treatment ${index % 2}`,
    index % 2 ? "1h 30min" : "1h 0min",
    index % 2 ? "10:00:00-11:30:00" : "10:00:00-11:00:00",
    "",
    "",
    "Fictional salon",
    String(1000 + index),
    "",
    "",
    "",
  ];
});
const csv = (rows) =>
  [headers, ...rows]
    .map((row) =>
      row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","),
    )
    .join("\r\n");

function statements(input) {
  const result = [];
  let current = "";
  for (const line of input.split("\n")) {
    current += `${line}\n`;
    if (
      current.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    result.push(current.trim());
    current = "";
  }
  assert.equal(current.trim(), "");
  return result;
}

test("Unlinked full-report history actually feeds salon proposals and reports without manufacturing clients", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-unlinked-acceptance-"));
  const origin = "https://unlinked-acceptance.example";
  const options = convertV4MiniflareOptions({
    modules: (await readdir("src"))
      .filter((f) => f.endsWith(".mjs"))
      .sort((a, b) =>
        a === "worker.mjs" ? -1 : b === "worker.mjs" ? 1 : a.localeCompare(b),
      )
      .map((f) => ({ type: "ESModule", path: resolve("src", f) })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: origin, APP_ENV: "test", EMAIL_ENABLED: "false" },
    d1Databases: { DB: "unlinked-acceptance" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  const mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  const db = await mf.getD1Database("DB");
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  for (const query of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(query).run();
  const now = new Date().toISOString();
  await sql(
    "INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    "same-name-client",
    "Fictional Client 00",
    now,
    now,
  ).run();
  const sessions = {};
  for (const role of ["owner", "reception"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      role,
      `${role}@example.test`,
      role,
      "unused",
      role,
      now,
    ).run();
    await sql(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      role,
      csrf,
      Date.now() + 3600000,
      now,
    ).run();
  }
  async function request(
    path,
    method = "GET",
    body,
    expected = 200,
    role = "owner",
  ) {
    const session = sessions[role];
    const response = await mf.dispatchFetch(`${origin}/api${path}`, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        cookie: `__Host-rei_session=${session.raw}`,
        "x-csrf-token": session.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: ${JSON.stringify(result)}`,
    );
    return result;
  }
  const count = async (table) =>
    (await sql(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  async function sourcePreview(rows) {
    const text = csv(rows),
      parsed = parseHistoryCSV(text);
    const preset = freshaHistoryPreset(parsed.headers);
    let preview = await request(
      "/history/previews/start",
      "POST",
      {
        source: "fictional-fresha",
        fileDigest: digest(text),
        fileBytes: Buffer.byteLength(text),
        total: parsed.rows.length,
        headers: parsed.headers,
        ...preset,
        referenceMode: "unverified",
      },
      201,
    );
    for (let offset = 0; offset < parsed.rows.length; offset += 100)
      preview = await request(
        `/history/previews/${preview.id}/upload`,
        "POST",
        {
          offset,
          rows: parsed.rows.slice(offset, offset + 100),
        },
      );
    for (let i = 0; i < 5 && preview.phase !== "ready"; i++)
      preview = await request(
        `/history/previews/${preview.id}/finalize`,
        "POST",
        {},
      );
    assert.equal(preview.phase, "ready");
    return preview;
  }
  async function readyJob(preview, allowUnlinkedClients) {
    const body = {
      previewId: preview.id,
      version: preview.version,
      requestId: randomUUID(),
      ...(allowUnlinkedClients === undefined ? {} : { allowUnlinkedClients }),
    };
    let { job } = await request("/history/jobs", "POST", body, 201);
    for (let i = 0; i < 4 && job.phase === "reviewing"; i++)
      ({ job } = await request(`/history/jobs/${job.id}/step`, "POST", {
        version: job.version,
        requestId: randomUUID(),
      }));
    assert.equal(job.phase, "ready");
    assert.equal(job.reviewed, preview.total);
    return { job, body };
  }
  async function finish(job, acknowledgeUnlinkedClients) {
    const confirm = {
      version: job.version,
      requestId: randomUUID(),
      confirmationToken: job.confirmationToken,
      acknowledgeReview: true,
      ...(acknowledgeUnlinkedClients
        ? { acknowledgeUnlinkedClients: true }
        : {}),
    };
    ({ job } = await request(
      `/history/jobs/${job.id}/confirm`,
      "POST",
      confirm,
    ));
    let firstStep;
    for (let i = 0; i < 4 && job.phase === "importing"; i++) {
      const body = { version: job.version, requestId: randomUUID() };
      firstStep ??= body;
      ({ job } = await request(`/history/jobs/${job.id}/step`, "POST", body));
    }
    assert.equal(job.phase, "completed");
    return { job, firstStep };
  }

  await t.test(
    "a cold report initializes the effective-history view before any import route is visited",
    async () => {
      const report = await request(
        "/reports/appointments?preset=custom&from=2026-01-01&to=2026-02-28&source=all",
      );
      assert.equal(report.totals.historicalRows, 0);
      assert.equal(report.totals.revenueCents, 0);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM history_archive_effective",
          ).first()
        ).n,
        0,
      );
      const profile = await request("/clients/same-name-client/history");
      assert.equal(profile.total, 0);
    },
  );

  const source = [...uniqueRows, [...uniqueRows[0]]];
  const preview = await sourcePreview(source);
  await t.test(
    "unlinked mode and its separate acknowledgement must be explicitly authorized",
    async () => {
      const { job, body } = await readyJob(preview);
      assert.equal(job.canConfirm, false);
      assert.ok(job.counts.blocked > 0);
      await request(
        "/history/jobs",
        "POST",
        { ...body, allowUnlinkedClients: true },
        409,
      );
      await request(`/history/jobs/${job.id}/cancel`, "POST", {
        version: job.version,
        requestId: randomUUID(),
      });
      assert.equal(await count("history_archive"), 0);
    },
  );

  let savedEvidence, reimportPreview;
  await t.test(
    "actual bulk steps preserve unmatched source rows and deduplicate across the step boundary",
    async () => {
      const { job } = await readyJob(preview, true);
      assert.equal(job.allowUnlinkedClients, true);
      assert.equal(job.counts.importable, 52);
      assert.equal(job.counts.unlinked, 52);
      assert.equal(job.counts.linked, 0);
      assert.equal(job.counts.duplicates, 1);
      assert.equal(job.counts.blocked, 0);
      await request(
        `/history/jobs/${job.id}/confirm`,
        "POST",
        {
          version: job.version,
          requestId: randomUUID(),
          confirmationToken: job.confirmationToken,
          acknowledgeReview: true,
        },
        400,
      );
      assert.equal(await count("history_archive"), 0);
      const completed = await finish(job, true);
      assert.equal(completed.job.created, 52);
      assert.equal(completed.job.duplicates, 1);
      const replay = await request(
        `/history/jobs/${job.id}/step`,
        "POST",
        completed.firstStep,
      );
      assert.equal(replay.repeated, true);
      assert.equal(replay.job.created, 52);
      savedEvidence = (
        await sql(
          "SELECT id,source,ref_hash,line_key,evidence_hash,record_json,source_status,client_id FROM history_archive ORDER BY id",
        ).all()
      ).results;
      assert.equal(savedEvidence.length, 52);
      assert.ok(savedEvidence.every((row) => row.client_id === null));
      assert.equal(await count("clients"), 1);
      assert.equal(await count("appointments"), 0);
      assert.equal(await count("booking_slots"), 0);
      assert.equal(await count("services"), 0);
      assert.equal(await count("therapists"), 0);
      const profile = await request("/clients/same-name-client/history");
      assert.equal(
        profile.total,
        0,
        "An exact name is not permission to merge source history into this profile",
      );
    },
  );

  await t.test(
    "the same bulk archive supplies real treatment/team proposals and separately labelled historical reports",
    async () => {
      const setup = await request(
        "/history/salon/preview?currency=RSD&minorUnitDigits=2&timeZone=Europe%2FBelgrade",
      );
      assert.equal(setup.summary.rows, 52);
      assert.equal(setup.services.length, 2);
      assert.equal(setup.therapists.length, 3);
      assert.deepEqual(
        setup.services.map((s) => [s.label, s.duration]).sort(),
        [
          ["Fictional Treatment 0", 60],
          ["Fictional Treatment 1", 90],
        ],
      );
      for (const item of setup.services) {
        assert.equal(item.latestNet.currency, "RSD");
        assert.equal(item.latestNet.minorUnitDigits, 2);
        assert.equal(
          item.latestNet.amountMinor,
          item.duration === 60 ? 105000 : 105100,
        );
      }
      assert.equal(
        await count("services"),
        0,
        "Reading proposals does not apply them",
      );
      const choices = [...setup.services, ...setup.therapists].map((item) => ({
        key: item.key,
        action: "create",
        name: item.label,
        ...(item.kind === "service"
          ? { duration: item.duration, priceMinor: 990000, active: true }
          : {}),
      }));
      const body = {
        previewId: setup.previewId,
        token: setup.token,
        fingerprint: setup.fingerprint,
        requestId: randomUUID(),
        acknowledgeReview: true,
        settings: {
          currency: "RSD",
          minorUnitDigits: 2,
          timeZone: "Europe/Belgrade",
        },
        choices,
      };
      const applied = await request("/history/salon/apply", "POST", body, 201);
      assert.equal(applied.createdServices, 2);
      assert.equal(applied.createdTherapists, 3);
      await request("/history/salon/apply", "POST", body);
      const therapists = (
        await sql("SELECT active,weekly_json FROM therapists").all()
      ).results;
      assert.ok(
        therapists.every(
          (item) =>
            !item.active &&
            JSON.parse(item.weekly_json).every((day) => !day.enabled),
        ),
      );
      assert.equal(await count("users"), 2);
      assert.equal(await count("clients"), 1);
      assert.equal(await count("appointments"), 0);
      assert.equal(await count("booking_slots"), 0);
      const path =
        "/reports/appointments?preset=custom&from=2026-01-01&to=2026-02-28&source=history&group=therapist";
      const report = await request(path);
      const eligible = uniqueRows.filter(
        (row) => !["Cancelled", "No Show"].includes(row[3]),
      );
      assert.equal(report.totals.historicalRows, 52);
      assert.equal(report.totals.historicalVisits, eligible.length);
      assert.equal(report.totals.includedTreatments, eligible.length);
      assert.equal(report.totals.revenueCents, 0);
      assert.deepEqual(report.totals.sourceNetSales, [
        {
          currency: "RSD",
          minorUnitDigits: 2,
          amountMinor: eligible.reduce(
            (sum, row) => sum + Number(row[14]) * 100,
            0,
          ),
          rows: eligible.length,
        },
      ]);
      assert.equal(report.details.length, 52);
      assert.ok(
        report.details.some(
          (row) => row.sourceStatus === "No Show" && !row.included,
        ),
      );
      assert.ok(
        report.details.some(
          (row) => row.sourceStatus === "Cancelled" && !row.included,
        ),
      );
      assert.ok(
        report.details
          .filter((row) => row.sourceStatus === "New")
          .every((row) => row.included && row.completionState === "unknown"),
      );
      assert.doesNotMatch(
        JSON.stringify(report),
        /Fictional Client|same-name-client/,
      );
      await request(path, "GET", undefined, 403, "reception");
      await request(
        "/history/salon/preview",
        "GET",
        undefined,
        403,
        "reception",
      );
      assert.deepEqual(
        (
          await sql(
            "SELECT id,source,ref_hash,line_key,evidence_hash,record_json,source_status,client_id FROM history_archive ORDER BY id",
          ).all()
        ).results,
        savedEvidence,
      );
    },
  );

  await t.test(
    "reordered repeats cannot duplicate history and changed evidence remains blocked",
    async () => {
      const repeatedPreview = await sourcePreview([...uniqueRows].reverse());
      reimportPreview = repeatedPreview;
      const { job } = await readyJob(repeatedPreview, true);
      assert.equal(job.counts.duplicates, 52);
      assert.equal(job.counts.importable, 0);
      assert.equal(job.counts.unlinked, 0);
      const completed = await finish(job, false);
      assert.equal(completed.job.created, 0);
      assert.equal(completed.job.duplicates, 52);
      const changed = uniqueRows.map((row, i) =>
        i === 0
          ? row.map((cell, col) => (col === 3 ? "Cancelled" : cell))
          : [...row],
      );
      const changedPreview = await sourcePreview(changed);
      const conflict = (await readyJob(changedPreview, true)).job;
      assert.equal(conflict.counts.blocked, 1);
      assert.equal(conflict.canConfirm, false);
      await request(
        `/history/jobs/${conflict.id}/confirm`,
        "POST",
        {
          version: conflict.version,
          requestId: randomUUID(),
          confirmationToken: conflict.confirmationToken,
          acknowledgeReview: true,
          acknowledgeUnlinkedClients: true,
        },
        409,
      );
      assert.deepEqual(
        (
          await sql(
            "SELECT id,source,ref_hash,line_key,evidence_hash,record_json,source_status,client_id FROM history_archive ORDER BY id",
          ).all()
        ).results,
        savedEvidence,
      );
      assert.equal(await count("clients"), 1);
      assert.equal(await count("appointments"), 0);
    },
  );

  await t.test("a later reviewed client link updates profile attribution without rewriting history or adding report visits", async () => {
    const groups = await request("/history/links/groups?offset=0&limit=30");
    assert.equal(groups.unlinkedRows, 52);
    const group = groups.groups.find((item) => item.label === "Fictional Client 00");
    assert.ok(group, "The unmatched source label remains available for later review");
    const review = await request(`/history/links/review?groupKey=${encodeURIComponent(group.key)}&offset=0`);
    assert.equal(review.rows.length, 1);
    assert.equal(review.rows[0].clientLabel, "Fictional Client 00");
    const client = review.candidates.find((item) => item.id === "same-name-client");
    assert.ok(client, "Matching names may be proposed, but this explicit action is required");
    const body = {
      reviewId: review.reviewId, token: review.token, fingerprint: review.fingerprint,
      requestId: randomUUID(), clientId: client.id, clientVersion: client.version,
      archiveIds: review.rows.map((item) => item.id), acknowledgeReview: true,
    };
    const linked = await request("/history/links/apply", "POST", body);
    assert.equal(linked.linked, 1);
    const replay = await request("/history/links/apply", "POST", body);
    assert.equal(replay.repeated, true);
    assert.equal(await count("history_archive_client_links"), 1);
    assert.equal((await request("/history/links/groups?offset=0&limit=30")).unlinkedRows, 51);
    assert.deepEqual((await sql(
      "SELECT id,source,ref_hash,line_key,evidence_hash,record_json,source_status,client_id FROM history_archive ORDER BY id",
    ).all()).results, savedEvidence);
    const profile = await request("/clients/same-name-client/history");
    assert.equal(profile.total, 1);
    assert.equal(profile.visitCount, 1);
    assert.equal(profile.rows[0].sourceStatus, "New");
    const reception = await request("/clients/same-name-client/history", "GET", undefined, 200, "reception");
    assert.equal(reception.total, 1);
    assert.equal(Object.hasOwn(reception.rows[0], "record"), false);
    assert.equal(Object.hasOwn(reception.rows[0], "sourceNetSalesMinor"), false);
    const report = await request("/reports/appointments?preset=custom&from=2026-01-01&to=2026-02-28&source=history");
    assert.equal(report.totals.historicalRows, 52);
    assert.equal(report.totals.historicalVisits, 32);
    const repeated = (await readyJob(reimportPreview, true)).job;
    assert.equal(repeated.counts.duplicates, 52);
    assert.equal(repeated.counts.blocked, 0);
    await finish(repeated, false);
    assert.equal((await request("/clients/same-name-client/history")).total, 1);
    assert.equal(await count("history_archive"), 52);
    assert.equal(await count("clients"), 1);
    assert.equal(await count("appointments"), 0);
  });
});
