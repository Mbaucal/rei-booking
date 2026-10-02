import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { HISTORY_BULK_SCHEMA } from "../src/history-bulk-schema.mjs";

function statements(sql) {
  const out = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
    if (
      current.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    out.push(current.trim());
    current = "";
  }
  assert.equal(current.trim(), "");
  return out;
}
const headers = [
  "Ref",
  "Client",
  "Date",
  "Slot",
  "Duration",
  "Status",
  "Service",
  "Team",
  "Resource",
  "Line",
  "Created",
  "Cancelled",
  "Net",
  "Client ID",
  "Phone",
];
const mapping = {
  appointmentRef: 0,
  clientName: 1,
  scheduledDate: 2,
  slot: 3,
  duration: 4,
  status: 5,
  serviceName: 6,
  therapistName: 7,
  roomName: 8,
  serviceLineRef: 9,
  createdAt: 10,
  cancelledAt: 11,
  netSales: 12,
  clientSourceId: 13,
  phone: 14,
};
const format = {
  dateTimeFormat: "fresha-en",
  slotFormat: "HH:mm:ss-HH:mm:ss",
  durationFormat: "hours-minutes",
};
const row = (ref, status = "New", changes = {}) =>
  Object.assign(
    [
      ref,
      "Synthetic One",
      "27 Jan 2026, 10:00am",
      "10:00:00-11:00:00",
      "1h 0min",
      status,
      "Source treatment",
      "Source team",
      "No resource",
      "",
      "",
      "",
      "4700",
      "",
      "",
    ],
    changes,
  );

test("bulk automatic schema matches the additive migration", async () => {
  assert.equal(
    await readFile("migrations/0014_history_bulk.sql", "utf8"),
    HISTORY_BULK_SCHEMA.join(";\n\n") + ";\n",
  );
});

test("Whole-report history jobs: complete review, durable progress and exactly-once import", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-archive-")),
    origin = "https://archive.example";
  const options = convertV4MiniflareOptions({
    modules: [
      "worker.mjs",
      ...(await readdir("src")).filter(
        (f) => f.endsWith(".mjs") && f !== "worker.mjs",
      ),
    ].map((f) => ({ type: "ESModule", path: resolve("src", f) })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: origin, APP_ENV: "test", EMAIL_ENABLED: "false" },
    d1Databases: { DB: "archive-tests" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  let mf = new Miniflare(options),
    db = await mf.getD1Database("DB");
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  const sql = (q, ...args) => db.prepare(q).bind(...args);
  for (const q of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(q).run();
  const ts = new Date().toISOString();
  await sql(
    "INSERT INTO therapists(id,name,weekly_json,created_at,updated_at) VALUES(?,?,?,?,?)",
    "therapist",
    "Synthetic team",
    JSON.stringify(defaultWeek()),
    ts,
    ts,
  ).run();
  await sql(
    "INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    "service",
    "Current treatment",
    60,
    500000,
    ts,
    ts,
  ).run();
  for (const [id, name, phone, key] of [
    ["c1", "Synthetic One", "0611111111", "381611111111"],
    ["c2", "Synthetic Two", "0622222222", "381622222222"],
  ])
    await sql(
      "INSERT INTO clients(id,name,phone,phone_key,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      id,
      name,
      phone,
      key,
      ts,
      ts,
    ).run();
  const sessions = {};
  for (const role of [
    "owner",
    "other-owner",
    "password-owner",
    "reception",
    "therapist",
  ]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,therapist_id,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,?)",
      role,
      role + "@example.test",
      role,
      "unused",
      role.includes("owner") ? "owner" : role,
      role === "therapist" ? "therapist" : null,
      role === "password-owner" ? 1 : 0,
      ts,
    ).run();
    await sql(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      role,
      csrf,
      Date.now() + 3600000,
      ts,
    ).run();
  }
  async function request(
    path,
    method = "GET",
    body,
    role = "owner",
    extra = {},
  ) {
    const s = sessions[role];
    const r = await mf.dispatchFetch(origin + "/api" + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(s
          ? { cookie: "__Host-rei_session=" + s.raw, "x-csrf-token": s.csrf }
          : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json(), headers: r.headers };
  }
  async function expect(
    path,
    method,
    body,
    status = 200,
    role = "owner",
    extra = {},
  ) {
    const r = await request(path, method, body, role, extra);
    assert.equal(r.status, status, JSON.stringify(r.data));
    return r.data;
  }
  async function preview(rows, extra = {}, choices = true) {
    const { keep = false, ...config } = extra;
    if (!keep) await sql("DELETE FROM history_previews").run();
    let p = await expect(
      "/history/previews/start",
      "POST",
      {
        source: "fresha",
        fileDigest: digest(randomUUID()),
        fileBytes: 3000,
        total: rows.length,
        headers,
        mapping,
        format,
        referenceMode: "unverified",
        ...config,
      },
      201,
    );
    for (let offset = 0; offset < rows.length;) {
      let end = Math.min(rows.length, offset + 100);
      while (
        end > offset + 1 &&
        Buffer.byteLength(JSON.stringify(rows.slice(offset, end))) > 350000
      )
        end--;
      p = await expect("/history/previews/" + p.id + "/upload", "POST", {
        offset,
        rows: rows.slice(offset, end),
      });
      offset = end;
    }
    do {
      p = await expect("/history/previews/" + p.id + "/finalize", "POST", {});
    } while (p.phase !== "ready");
    if (choices) {
      const v = (await sql("SELECT version FROM clients WHERE id='c1'").first())
        .version;
      for (let offset = 0; offset < rows.length; offset += 50)
        p = await expect("/history/previews/" + p.id + "/choices", "POST", {
          version: p.version,
          requestId: randomUUID(),
          choices: rows.slice(offset, offset + 50).map((_, i) => ({
            row: offset + i + 2,
            clientId: "c1",
            clientVersion: v,
          })),
        });
    }
    return p;
  }
  async function review(p, rows = [2], requestId = randomUUID()) {
    const body = { previewId: p.id, version: p.version, rows, requestId };
    const r = await expect("/history/imports/review", "POST", body);
    return {
      ...r,
      body,
      confirmBody: {
        ...body,
        confirmationToken: r.confirmationToken,
        acknowledgeReview: true,
      },
    };
  }
  const confirm = (r, status = 201) =>
    expect("/history/imports/confirm", "POST", r.confirmBody, status);
  const count = async (table) =>
    (await sql(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  await expect("/history/jobs", "GET");
  const start = async (p, requestId = randomUUID()) =>
    (
      await expect(
        "/history/jobs",
        "POST",
        { previewId: p.id, version: p.version, requestId },
        201,
      )
    ).job;
  const advance = async (j) =>
    (
      await expect(`/history/jobs/${j.id}/step`, "POST", {
        version: j.version,
        requestId: randomUUID(),
      })
    ).job;
  const readyJob = async (p) => {
    let j = await start(p);
    while (j.phase === "reviewing") j = await advance(j);
    assert.equal(j.phase, "ready", j.reason);
    return j;
  };
  const accept = async (j) =>
    (
      await expect(`/history/jobs/${j.id}/confirm`, "POST", {
        version: j.version,
        confirmationToken: j.confirmationToken,
        acknowledgeReview: true,
        requestId: randomUUID(),
      })
    ).job;
  const finish = async (j) => {
    while (j.phase === "importing") j = await advance(j);
    assert.equal(j.phase, "completed", j.reason);
    return j;
  };
  const cancelJob = async (j) =>
    (
      await expect(`/history/jobs/${j.id}/cancel`, "POST", {
        version: j.version,
        requestId: randomUUID(),
      })
    ).job;
  await t.test(
    "all job endpoints retain owner, session, password, CSRF, origin and owner-isolation gates",
    async () => {
      const p = await preview([row("bulk-auth")]),
        j = await start(p);
      for (const role of [
        "anonymous",
        "reception",
        "therapist",
        "password-owner",
      ])
        for (const [path, method] of [
          ["/history/jobs", "GET"],
          ["/history/jobs", "POST"],
          [`/history/jobs/${j.id}`, "GET"],
          [`/history/jobs/${j.id}/step`, "POST"],
          [`/history/jobs/${j.id}/confirm`, "POST"],
          [`/history/jobs/${j.id}/cancel`, "POST"],
        ])
          await expect(
            path,
            method,
            method === "POST"
              ? { version: 1, requestId: randomUUID() }
              : undefined,
            role === "anonymous" ? 401 : 403,
            role,
          );
      await expect(
        `/history/jobs/${j.id}`,
        "GET",
        undefined,
        404,
        "other-owner",
      );
      assert.deepEqual(
        (await expect("/history/jobs", "GET", undefined, 200, "other-owner"))
          .jobs,
        [],
      );
      await expect(
        `/history/jobs/${j.id}/step`,
        "POST",
        { version: j.version, requestId: randomUUID() },
        403,
        "owner",
        { "x-csrf-token": "wrong" },
      );
      await expect(
        `/history/jobs/${j.id}/step`,
        "POST",
        { version: j.version, requestId: randomUUID() },
        403,
        "owner",
        { origin: "https://elsewhere.example" },
      );
      await cancelJob(j);
    },
  );
  await t.test(
    "complete review counts duplicates across chunks; one confirmation imports all unique rows with safe exact retries",
    async () => {
      const data = Array.from({ length: 121 }, (_, i) => row(`multi-${i}`));
      data[70] = data[0];
      data[120] = data[30];
      const p = await preview(data);
      let j = await start(p);
      const initial = j;
      const stepBody = { version: j.version, requestId: randomUUID() };
      j = (await expect(`/history/jobs/${j.id}/step`, "POST", stepBody)).job;
      assert.equal(j.reviewed, 50);
      assert.equal(j.phase, "reviewing");
      assert.equal(j.created, 0);
      assert.equal(
        (await expect(`/history/jobs/${j.id}/step`, "POST", stepBody)).job
          .reviewed,
        50,
      );
      await expect(
        `/history/jobs/${j.id}/step`,
        "POST",
        { ...stepBody, version: 999 },
        409,
      );
      await expect(
        `/history/jobs/${j.id}/confirm`,
        "POST",
        {
          version: j.version,
          requestId: randomUUID(),
          acknowledgeReview: true,
          confirmationToken: j.confirmationToken,
        },
        409,
      );
      while (j.phase === "reviewing") j = await advance(j);
      assert.deepEqual(j.counts, {
        selected: 121,
        importable: 119,
        duplicates: 2,
        blocked: 0,
        unmatched: 0,
        conflicts: 0,
        invalid: 0,
      });
      const detail = await expect(`/history/jobs/${j.id}?page=1`, "GET");
      assert.equal(detail.rows.length, 50);
      assert.equal(detail.totalPages, 3);
      assert.equal(
        detail.rows.find((r) => r.row === 72).disposition,
        "duplicate",
      );
      const cb = {
        version: j.version,
        requestId: randomUUID(),
        confirmationToken: j.confirmationToken,
        acknowledgeReview: true,
      };
      j = (await expect(`/history/jobs/${j.id}/confirm`, "POST", cb)).job;
      assert.equal(j.phase, "importing");
      assert.equal(j.expiresAt, null);
      j = await finish(j);
      assert.equal(j.created, 119);
      assert.equal(j.duplicates, 2);
      assert.equal(j.processed, 121);
      assert.equal(
        (await expect(`/history/jobs/${j.id}/confirm`, "POST", cb)).job.phase,
        "completed",
      );
      assert.equal(
        (await expect(`/history/jobs/${j.id}/step`, "POST", stepBody)).job
          .processed,
        121,
      );
      await expect(
        `/history/jobs/${j.id}/step`,
        "POST",
        { version: initial.version, requestId: randomUUID() },
        409,
      );
      assert.equal(
        (await expect(`/history/jobs/${j.id}?page=2`, "GET")).rows[20].result
          .disposition,
        "duplicate",
      );
      const p2 = await preview([...data].reverse());
      let d = await readyJob(p2);
      assert.equal(d.counts.importable, 0);
      assert.equal(d.counts.duplicates, 121);
      d = await finish(await accept(d));
      assert.equal(d.created, 0);
      assert.equal(d.duplicates, 121);
    },
  );
  await t.test(
    "blocked and changed references anywhere in report prevent one complete confirmation, including unmatched later rows",
    async () => {
      const data = Array.from({ length: 70 }, (_, i) => row("ambiguous-" + i));
      data[68] = row("ambiguous-0", "Cancelled");
      const p = await preview(data);
      let j = await readyJob(p);
      assert.ok(j.counts.conflicts >= 2);
      const attention = await expect(
        `/history/jobs/${j.id}?filter=blocked`,
        "GET",
      );
      assert.equal(attention.filteredTotal, j.counts.blocked);
      assert.equal(attention.totalPages, 1);
      assert.ok(attention.rows.every((r) => r.disposition === "blocked"));
      assert.ok(attention.rows.some((r) => r.row === 70));
      assert.equal(j.canConfirm, false);
      await expect(
        `/history/jobs/${j.id}/confirm`,
        "POST",
        {
          version: j.version,
          requestId: randomUUID(),
          confirmationToken: j.confirmationToken,
          acknowledgeReview: true,
        },
        409,
      );
      await cancelJob(j);
      const p2 = await preview([row("unmatched")], {}, false);
      j = await readyJob(p2);
      assert.equal(j.counts.unmatched, 1);
      await cancelJob(j);
      const p3 = await preview([row("multi-0", "Cancelled")]);
      j = await readyJob(p3);
      assert.equal(j.counts.conflicts, 1);
      await cancelJob(j);
      const p4 = await preview([row("multi-0", "New", { 9: "new-line" })], {
        referenceMode: "service-line",
      });
      j = await readyJob(p4);
      assert.equal(j.counts.conflicts, 1);
      await cancelJob(j);
    },
  );
  await t.test(
    "confirmed frozen evidence survives preview edits, deletion, expiry, network loss and Worker restart",
    async () => {
      const p = await preview(
        Array.from({ length: 105 }, (_, i) => row("durable-" + i)),
      );
      let j = await accept(await readyJob(p));
      const body = { version: j.version, requestId: randomUUID() };
      j = (await expect(`/history/jobs/${j.id}/step`, "POST", body)).job;
      assert.equal(j.created, 50);
      await sql(
        "UPDATE history_preview_rows SET draft_client_id='c2',record_json=json_set(record_json,'$.sourceStatus','Changed') WHERE preview_id=?",
        p.id,
      ).run();
      await sql(
        "UPDATE history_previews SET version=version+1,expires_at=0 WHERE id=?",
        p.id,
      ).run();
      await sql("DELETE FROM history_previews WHERE id=?", p.id).run();
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      assert.equal(
        (await expect(`/history/jobs/${j.id}/step`, "POST", body)).job
          .processed,
        50,
      );
      j = (await expect(`/history/jobs/${j.id}`, "GET")).job;
      j = await finish(j);
      assert.equal(j.created, 105);
      const saved = (
        await sql(
          "SELECT client_id,source_status FROM history_archive WHERE json_extract(record_json,'$.sourceAppointmentRef') LIKE 'durable-%'",
        ).all()
      ).results;
      assert.equal(saved.length, 105);
      assert.ok(
        saved.every((r) => r.client_id === "c1" && r.source_status === "New"),
      );
    },
  );
  await t.test(
    "client/source-link changes and native mutations pause with honest partial counts; new review skips committed rows",
    async () => {
      let p = await preview(
          Array.from({ length: 65 }, (_, i) => row("pause-" + i)),
        ),
        j = await accept(await readyJob(p));
      j = await advance(j);
      assert.equal(j.created, 50);
      await sql(
        "UPDATE clients SET name='Synthetic One Updated',version=version+1 WHERE id='c1'",
      ).run();
      j = await advance(j);
      assert.equal(j.phase, "paused");
      assert.equal(j.created, 50);
      assert.equal(j.processed, 50);
      assert.equal(j.requiresNewReview, true);
      await expect(
        `/history/jobs/${j.id}/step`,
        "POST",
        { version: j.version, requestId: randomUUID() },
        409,
      );
      p = await preview(
        Array.from({ length: 65 }, (_, i) => row("pause-" + i)),
      );
      let next = await readyJob(p);
      assert.equal(next.counts.duplicates, 50);
      assert.equal(next.counts.importable, 15);
      next = await finish(await accept(next));
      assert.equal(next.created, 15);
      p = await preview([row("link-pause", "New", { 13: "source-one" })]);
      j = await readyJob(p);
      await sql(
        "INSERT INTO client_imports(id,owner_id,source,revision,plan_json,created_at,expires_at) VALUES('bulk-link-import','owner','fresha',0,'{}',0,9999999999999)",
      ).run();
      await sql(
        "INSERT INTO client_import_keys(source,source_key,client_id,import_id) VALUES(?,?,?,?)",
        "fresha",
        "id:" + digest("source-one"),
        "c2",
        "bulk-link-import",
      ).run();
      j = (
        await expect(`/history/jobs/${j.id}/confirm`, "POST", {
          version: j.version,
          requestId: randomUUID(),
          confirmationToken: j.confirmationToken,
          acknowledgeReview: true,
        })
      ).job;
      assert.equal(j.phase, "paused");
      assert.equal(j.created, 0);
      p = await preview([row("native-pause")]);
      j = await readyJob(p);
      await sql(
        "INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,gross_cents,net_cents,created_at,updated_at,updated_by,mutation_id) VALUES('native-pause','c1','therapist','service','Current treatment','2026-02-01',600,60,'r1',0,'done',500000,500000,?,?,'owner','native-pause-mutation')",
        ts,
        ts,
      ).run();
      j = (
        await expect(`/history/jobs/${j.id}/confirm`, "POST", {
          version: j.version,
          requestId: randomUUID(),
          confirmationToken: j.confirmationToken,
          acknowledgeReview: true,
        })
      ).job;
      assert.equal(j.phase, "paused");
      await sql("DELETE FROM appointments WHERE id='native-pause'").run();
    },
  );
  await t.test(
    "concurrent same-step retries advance once; competing jobs pause rather than duplicate archive writes",
    async () => {
      let p = await preview(
          Array.from({ length: 65 }, (_, i) => row("race-" + i)),
        ),
        a = await readyJob(p);
      a = await accept(a);
      const p2 = await preview(
        Array.from({ length: 65 }, (_, i) => row("race-" + i)),
        { keep: true },
      );
      let b = await accept(await readyJob(p2));
      const body = { version: a.version, requestId: randomUUID() };
      const responses = await Promise.all([
        request(`/history/jobs/${a.id}/step`, "POST", body),
        request(`/history/jobs/${a.id}/step`, "POST", body),
      ]);
      assert.ok(responses.every((r) => r.status === 200));
      a = (await expect(`/history/jobs/${a.id}`, "GET")).job;
      assert.equal(a.processed, 50);
      assert.equal(a.created, 50);
      b = await advance(b);
      assert.equal(b.phase, "paused");
      assert.equal(b.created, 0);
      a = await finish(a);
      assert.equal(a.created, 65);
    },
  );
  await t.test(
    "failed chunk rolls back rows, progress, receipts and revision; cancellation retains only completed chunks",
    async () => {
      let p = await preview(
          Array.from({ length: 62 }, (_, i) => row("rollback-" + i)),
        ),
        j = await accept(await readyJob(p));
      await sql(
        "CREATE TRIGGER fail_bulk_row BEFORE INSERT ON history_archive WHEN json_extract(NEW.record_json,'$.sourceAppointmentRef')='rollback-1' BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END",
      ).run();
      const body = { version: j.version, requestId: randomUUID() },
        prior = await count("history_archive");
      await expect(`/history/jobs/${j.id}/step`, "POST", body, 500);
      assert.equal(await count("history_archive"), prior);
      assert.equal(
        (await expect(`/history/jobs/${j.id}`, "GET")).job.processed,
        0,
      );
      await sql("DROP TRIGGER fail_bulk_row").run();
      j = (await expect(`/history/jobs/${j.id}/step`, "POST", body)).job;
      assert.equal(j.created, 50);
      const cancelBody = { version: j.version, requestId: randomUUID() };
      j = (await expect(`/history/jobs/${j.id}/cancel`, "POST", cancelBody))
        .job;
      assert.equal(j.phase, "cancelled");
      assert.equal(j.created, 50);
      assert.equal(j.processed, 50);
      assert.equal(
        (await expect(`/history/jobs/${j.id}/cancel`, "POST", cancelBody)).job
          .processed,
        50,
      );
      await expect(
        `/history/jobs/${j.id}/step`,
        "POST",
        { version: j.version, requestId: randomUUID() },
        409,
      );
      assert.equal(await count("history_archive"), prior + 50);
    },
  );
  await t.test(
    "unconfirmed preview expiry invalidates review and same-id changed bodies never create another job",
    async () => {
      const p = await preview([row("expiry")]),
        body = { previewId: p.id, version: p.version, requestId: randomUUID() };
      const initial = await expect("/history/jobs", "POST", body, 201);
      assert.equal(
        (await expect("/history/jobs", "POST", body)).job.id,
        initial.job.id,
      );
      await expect(
        "/history/jobs",
        "POST",
        { ...body, version: body.version + 1 },
        409,
      );
      await sql(
        "UPDATE history_previews SET expires_at=0 WHERE id=?",
        p.id,
      ).run();
      const j = await advance(initial.job);
      assert.equal(j.phase, "paused");
      assert.equal(j.created, 0);
    },
  );
  await t.test(
    "wide valid evidence automatically reduces review steps without splitting the report",
    async () => {
      const wide = "Synthetic long label " + "x".repeat(6980);
      const p = await preview(
        Array.from({ length: 60 }, (_, i) =>
          row("wide-" + i, "New", { 6: wide, 7: wide, 8: wide }),
        ),
      );
      let j = await start(p);
      j = await advance(j);
      assert.ok(j.reviewed > 0 && j.reviewed < 50);
      while (j.phase === "reviewing") j = await advance(j);
      assert.equal(j.phase, "ready", j.reason);
      assert.equal(j.counts.importable, 60);
      const page = await expect(`/history/jobs/${j.id}`, "GET");
      assert.equal(page.rows.length, 50);
      assert.equal(page.rows[0].serviceName, wide);
      j = await finish(await accept(j));
      assert.equal(j.created, 60);
    },
  );
  await t.test(
    "resumable confirmed job stays discoverable ahead of more than twenty newer expired reviews",
    async () => {
      const p = await preview([row("resume-old")]);
      const j = await accept(await readyJob(p));
      for (let i = 0; i < 22; i++)
        await sql(
          `INSERT INTO history_import_jobs(id,owner_id,request_id,input_hash,preview_id,preview_version,source,phase,total,counts_json,client_revision,archive_revision,native_revision,confirmation_token,expires_at,created_at,updated_at)
      SELECT ?,owner_id,?,input_hash,preview_id,preview_version,source,'ready',total,counts_json,client_revision,archive_revision,native_revision,confirmation_token,0,created_at+10000+?,updated_at FROM history_import_jobs WHERE id=?`,
          randomUUID(),
          randomUUID(),
          i,
          j.id,
        ).run();
      const recent = (await expect("/history/jobs", "GET")).jobs;
      assert.equal(recent.length, 20);
      assert.equal(recent[0].id, j.id);
      assert.equal(recent[0].phase, "importing");
      assert.equal(recent[0].confirmationToken, null);
      assert.equal("statusCounts" in recent[0], false);
      await cancelJob(j);
    },
  );
  await t.test(
    "whole report larger than 1000 rows completes with bounded requests and no live/report side effects",
    async () => {
      const n = Number(process.env.REI_BULK_TEST_ROWS ?? 1205);
      assert.ok(Number.isInteger(n) && n > 1000 && n <= 50000);
      const before = {
        appointments: await count("appointments"),
        slots: await count("booking_slots"),
        clients: await count("clients"),
        links: await count("client_import_keys"),
      };
      const begin = performance.now();
      const data = Array.from({ length: n }, (_, i) => row("capacity-" + i));
      const p = await preview(data);
      const uploadMs = Math.round(performance.now() - begin);
      const queryPlan = (
        await sql(
          "EXPLAIN QUERY PLAN SELECT trim(json_extract(record_json,'$.sourceAppointmentRef')) AS ref,MIN(payload_digest),MAX(payload_digest) FROM history_preview_rows WHERE preview_id=? AND trim(json_extract(record_json,'$.sourceAppointmentRef')) IN(SELECT value FROM json_each(?)) GROUP BY ref",
          p.id,
          JSON.stringify(["capacity-0", "capacity-1"]),
        ).all()
      ).results;
      assert.ok(
        queryPlan.some((r) =>
          r.detail.includes("history_preview_archive_refs"),
        ),
      );
      t.diagnostic(
        JSON.stringify({ referenceQueryPlan: queryPlan.map((r) => r.detail) }),
      );
      const archiveQueryPlan = (
        await sql(
          "EXPLAIN QUERY PLAN SELECT a.id,a.ref_hash,a.line_key,a.client_id,a.evidence_hash FROM json_each(?) k CROSS JOIN history_archive a ON a.source=? AND a.ref_hash=json_extract(k.value,'$.ref') AND a.line_key=json_extract(k.value,'$.line')",
          JSON.stringify([{ ref: digest("capacity-0"), line: "" }]),
          "fresha",
        ).all()
      ).results;
      assert.ok(
        archiveQueryPlan.some((r) =>
          r.detail.includes("source=? AND ref_hash=? AND line_key=?"),
        ),
      );
      t.diagnostic(
        JSON.stringify({
          archiveQueryPlan: archiveQueryPlan.map((r) => r.detail),
        }),
      );
      const jobKeyQueryPlan = (
        await sql(
          "EXPLAIN QUERY PLAN SELECT k.* FROM json_each(?) p CROSS JOIN history_import_job_keys k ON k.job_id=? AND k.ref_hash=json_extract(p.value,'$.refHash') AND k.line_key=json_extract(p.value,'$.lineKey')",
          JSON.stringify([{ refHash: digest("capacity-0"), lineKey: "" }]),
          "synthetic-job",
        ).all()
      ).results;
      assert.ok(
        jobKeyQueryPlan.some((r) =>
          r.detail.includes("job_id=? AND ref_hash=? AND line_key=?"),
        ),
      );
      t.diagnostic(
        JSON.stringify({
          jobKeyQueryPlan: jobKeyQueryPlan.map((r) => r.detail),
        }),
      );
      const frozenQueryPlan = (
        await sql(
          "EXPLAIN QUERY PLAN SELECT x.record_json FROM json_each(?) p CROSS JOIN history_preview_rows x ON x.preview_id=? AND x.row_num=json_extract(p.value,'$.row')",
          JSON.stringify([{ row: 2 }]),
          p.id,
        ).all()
      ).results;
      assert.ok(
        frozenQueryPlan.some((r) =>
          r.detail.includes("preview_id=? AND row_num=?"),
        ),
      );
      t.diagnostic(
        JSON.stringify({
          frozenQueryPlan: frozenQueryPlan.map((r) => r.detail),
        }),
      );
      let j = await start(p),
        reviewSteps = 0,
        importSteps = 0;
      while (j.phase === "reviewing") {
        const old = j.reviewed;
        j = await advance(j);
        assert.ok(j.reviewed - old > 0 && j.reviewed - old <= 50);
        reviewSteps++;
      }
      assert.equal(j.phase, "ready", j.reason);
      assert.equal(j.counts.importable, n);
      assert.equal(j.reviewed, n);
      const reviewMs = Math.round(performance.now() - begin) - uploadMs;
      j = await accept(j);
      while (j.phase === "importing") {
        const old = j.processed;
        j = await advance(j);
        assert.ok(j.processed - old > 0 && j.processed - old <= 50);
        importSteps++;
      }
      assert.equal(j.phase, "completed", j.reason);
      assert.equal(j.created, n);
      assert.equal(j.processed, n);
      assert.equal(j.duplicates, 0);
      assert.deepEqual(
        {
          appointments: await count("appointments"),
          slots: await count("booking_slots"),
          clients: await count("clients"),
          links: await count("client_import_keys"),
        },
        before,
      );
      t.diagnostic(
        JSON.stringify({
          syntheticRows: n,
          uploadMs,
          reviewMs,
          totalMs: Math.round(performance.now() - begin),
          reviewSteps,
          importSteps,
        }),
      );
    },
  );
});
