import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { HISTORY_ARCHIVE_SCHEMA } from "../src/history-archive-schema.mjs";
import { historyArchiveRoutes } from "../src/history-archive.mjs";

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

test("archive automatic schema matches the additive migration", async () => {
  assert.equal(
    await readFile("migrations/0013_history_archive.sql", "utf8"),
    HISTORY_ARCHIVE_SCHEMA.join(";\n\n") + ";\n",
  );
});

test("Historical archive Worker + D1: explicit confirmation, durable deduplication and role-safe history", async (t) => {
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
        ...extra,
      },
      201,
    );
    for (let offset = 0; offset < rows.length; offset += 100)
      p = await expect("/history/previews/" + p.id + "/upload", "POST", {
        offset,
        rows: rows.slice(offset, offset + 100),
      });
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
  let saved, receipt;
  await t.test(
    "review/confirm are owner-only and keep session, password, CSRF, origin and cross-owner gates",
    async () => {
      const p = await preview([row("auth")]);
      for (const role of [
        "anonymous",
        "reception",
        "therapist",
        "password-owner",
      ])
        for (const action of ["review", "confirm"])
          await expect(
            "/history/imports/" + action,
            "POST",
            {
              previewId: p.id,
              version: p.version,
              rows: [2],
              requestId: randomUUID(),
            },
            role === "anonymous" ? 401 : 403,
            role,
          );
      const body = {
        previewId: p.id,
        version: p.version,
        rows: [2],
        requestId: randomUUID(),
      };
      await expect("/history/imports/review", "POST", body, 403, "owner", {
        "x-csrf-token": "bad",
      });
      await expect("/history/imports/review", "POST", body, 403, "owner", {
        origin: "https://elsewhere.example",
      });
      await expect("/history/imports/review", "POST", body, 404, "other-owner");
      const r = await review(p);
      await expect(
        "/history/imports/confirm",
        "POST",
        r.confirmBody,
        404,
        "other-owner",
      );
      assert.equal(await count("history_archive"), 0);
      await expect(
        "/history/imports/confirm",
        "POST",
        { ...r.confirmBody, acknowledgeReview: false },
        400,
      );
      await expect(
        "/history/imports/confirm",
        "POST",
        { ...r.confirmBody, confirmationToken: "wrong" },
        409,
      );
    },
  );
  await t.test(
    "original source statuses archive with unknown facts and no live booking or finance side effects",
    async () => {
      const statuses = ["New", "Confirmed", "Started", "Cancelled", "No Show"];
      const p = await preview(
        statuses.map((s, i) => row("status-" + i, s)),
        {
          format: {
            ...format,
            completionMap: {
              New: "completed",
              Confirmed: "completed",
              Started: "completed",
            },
          },
        },
      );
      const r = await review(p, [2, 3, 4, 5, 6]);
      assert.equal(r.canConfirm, true);
      assert.equal(r.counts.importable, 5);
      assert.ok(
        r.rows.every((x) =>
          x.issues.some((i) => i.code === "timezone_unconfirmed"),
        ),
      );
      assert.equal(r.rows[0].completionState, "unknown");
      assert.ok(
        r.rows[0].issues.some((i) => i.code === "conservative_reference"),
      );
      const before = {
        clients: await count("clients"),
        appointments: await count("appointments"),
        slots: await count("booking_slots"),
        keys: await count("client_import_keys"),
      };
      assert.equal(await count("history_archive"), 0);
      receipt = await confirm(r);
      saved = r;
      assert.equal(receipt.created, 5);
      assert.equal(receipt.duplicates, 0);
      assert.equal(await count("history_archive"), 5);
      assert.deepEqual(
        {
          clients: await count("clients"),
          appointments: await count("appointments"),
          slots: await count("booking_slots"),
          keys: await count("client_import_keys"),
        },
        before,
      );
      const h = await expect("/clients/c1/history", "GET");
      assert.equal(h.total, 5);
      assert.equal(h.visitCount, 3);
      assert.deepEqual(
        new Set(h.statusCounts.map((x) => x.status)),
        new Set(statuses),
      );
      for (const item of h.rows) {
        assert.equal(
          item.countsAsVisit,
          !["Cancelled", "No Show"].includes(item.sourceStatus),
        );
        assert.equal(item.roomName, null);
        assert.equal(item.record.raw.roomName, "No resource");
        assert.equal(item.record.sourceTimeZone, null);
        assert.equal(item.record.sourceNetSalesMinor, null);
        assert.equal(item.currency, null);
        assert.equal(item.record.fullPriceMinor, null);
        assert.equal(item.record.paidAmountMinor, null);
        assert.equal(item.record.bonusAmountMinor, null);
        if (["New", "Confirmed", "Started"].includes(item.sourceStatus))
          assert.equal(item.completionState, "unknown");
      }
      const second = await request(
        "/history/imports/confirm",
        "POST",
        r.confirmBody,
      );
      assert.equal(second.status, 200);
      assert.equal(second.data.importId, receipt.importId);
      assert.equal(second.data.repeated, true);
      assert.equal(await count("history_archive"), 5);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM audit_log WHERE action='history_import'",
          ).first()
        ).n,
        1,
      );
    },
  );
  await t.test(
    "receipt replay survives preview deletion/expiry and Worker restart; changed exact body conflicts",
    async () => {
      await expect("/history/previews/" + saved.previewId, "DELETE", {
        version: saved.version,
      });
      await sql(
        "UPDATE history_import_reviews SET expires_at=0 WHERE request_id=?",
        saved.requestId,
      ).run();
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      const repeated = await confirm(saved, 200);
      assert.equal(repeated.importId, receipt.importId);
      await expect(
        "/history/imports/confirm",
        "POST",
        { ...saved.confirmBody, rows: [6, 5, 4, 3, 2] },
        409,
      );
      await expect(
        "/history/imports/confirm",
        "POST",
        { ...saved.confirmBody, version: saved.version + 1 },
        409,
      );
      await expect(
        "/history/imports/confirm",
        "POST",
        saved.confirmBody,
        404,
        "other-owner",
      );
      assert.equal(await count("history_archive"), 5);
    },
  );
  await t.test(
    "reordered overlapping files skip exact source keys, and changed status/client/settings conflict",
    async () => {
      const p = await preview(
        [row("status-2", "Started"), row("status-0", "New"), row("new-ref")],
        {
          format: {
            ...format,
            completionMap: {
              New: "completed",
              Confirmed: "completed",
              Started: "completed",
            },
          },
        },
      );
      const r = await review(p, [2, 3, 4]);
      assert.equal(r.counts.duplicates, 2);
      assert.equal(r.counts.importable, 1);
      const result = await confirm(r);
      assert.equal(result.created, 1);
      assert.equal(result.duplicates, 2);
      const changed = await preview([
        row("status-0", "Cancelled"),
        row("new-ref"),
      ]);
      const conflict = await review(changed, [2]);
      assert.equal(conflict.canConfirm, false);
      assert.equal(conflict.counts.conflicts, 1);
      await confirm(conflict, 409);
      let chosen = await preview([row("new-ref")], {
        format: {
          ...format,
          completionMap: {
            New: "completed",
            Confirmed: "completed",
            Started: "completed",
          },
        },
      });
      chosen = await expect(
        "/history/previews/" + chosen.id + "/choices",
        "POST",
        {
          version: chosen.version,
          requestId: randomUUID(),
          choices: [{ row: 2, clientId: "c2", clientVersion: 1 }],
        },
      );
      assert.equal(
        (await review(chosen)).rows[0].issues.some(
          (i) => i.code === "archive_conflict",
        ),
        true,
      );
      const settings = await preview([row("new-ref")], {
        referenceMode: "verified-appointment",
        format: { ...format, sourceTimeZone: "Europe/Belgrade" },
      });
      assert.equal(
        (await review(settings)).rows[0].issues.some(
          (i) => i.code === "archive_conflict",
        ),
        true,
      );
    },
  );
  await t.test(
    "complete-preview ambiguity blocks unselected later rows; service-line IDs cannot bypass reserved reference modes",
    async () => {
      const rows = Array.from({ length: 51 }, (_, i) => row("outside-" + i));
      rows[50] = row("outside-0", "Started");
      const p = await preview(rows);
      const r = await review(p, [2]);
      assert.equal(r.canConfirm, false);
      assert.ok(r.rows[0].issues.some((i) => i.code === "ambiguous_reference"));
      const missing = await preview(
        [
          row("line-ref", "New", { 9: "line-1" }),
          row("line-ref", "New", { 9: "" }),
        ],
        { referenceMode: "service-line" },
      );
      assert.equal((await review(missing, [2])).canConfirm, false);
      const service = await preview(
        [
          row("line-valid", "New", { 9: "line-1" }),
          row("line-valid", "Started", { 9: "line-2" }),
        ],
        { referenceMode: "service-line" },
      );
      const lines = await review(service, [2, 3]);
      assert.equal(lines.canConfirm, true);
      const beforeVisits = (await expect("/clients/c1/history", "GET"))
        .visitCount;
      assert.equal((await confirm(lines)).created, 2);
      assert.equal(
        (await expect("/clients/c1/history", "GET")).visitCount,
        beforeVisits + 1,
      );
      const opposite = await preview([row("line-valid")]);
      assert.ok(
        (await review(opposite)).rows[0].issues.some(
          (i) => i.code === "reference_mode_conflict",
        ),
      );
      const bypass = await preview(
        [row("new-ref", "New", { 9: "fresh-line" })],
        { referenceMode: "service-line" },
      );
      assert.ok(
        (await review(bypass)).rows[0].issues.some(
          (i) => i.code === "reference_mode_conflict",
        ),
      );
    },
  );
  await t.test(
    "known source links and supplied contacts cannot be overridden by a different draft client",
    async () => {
      await sql(
        `INSERT INTO client_imports(id,owner_id,source,revision,plan_json,status,created_at,expires_at) VALUES('source-client-import','owner','fresha',0,'{}','applied',?,?)`,
        Date.now(),
        Date.now() + 3600000,
      ).run();
      await sql(
        `INSERT INTO client_import_keys(source,source_key,client_id,import_id) VALUES('fresha',?,'c1','source-client-import')`,
        "id:" + digest("external-client"),
      ).run();
      for (const changes of [
        { 13: "external-client" },
        { 14: "0611111111" },
        { 14: "0633333333" },
      ]) {
        let p = await preview(
          [row("identity-" + randomUUID(), "New", changes)],
          { source: changes[13] ? "FRESHA" : "fresha" },
        );
        p = await expect("/history/previews/" + p.id + "/choices", "POST", {
          version: p.version,
          requestId: randomUUID(),
          choices: [{ row: 2, clientId: "c2", clientVersion: 1 }],
        });
        const r = await review(p);
        assert.equal(r.canConfirm, false);
        assert.equal(r.counts.conflicts, 1);
        assert.ok(
          r.rows[0].issues.some((i) => i.code === "identity_evidence_conflict"),
        );
        await confirm(r, 409);
      }
    },
  );
  await t.test(
    "missing identity/ref, malformed schedules and severe date contradictions block whole batches; ordinary warnings require acknowledgement",
    async () => {
      let p = await preview([row("missing-choice")], {}, false);
      const missing = await review(p);
      assert.equal(missing.counts.unmatched, 1);
      p = await preview([
        row(""),
        row("malformed", "New", { 2: "31 Feb 2026, 10:00am" }),
        row("mismatch", "New", { 3: "11:00:00-12:00:00" }),
        row("date-conflict", "Cancelled", {
          10: "27 Jan 2026, 11:00am",
          11: "27 Jan 2026, 9:00am",
        }),
        row("valid"),
      ]);
      const r = await review(p, [2, 3, 4, 5, 6]);
      assert.equal(r.counts.blocked, 4);
      assert.equal(r.counts.invalid, 4);
      assert.equal(r.canConfirm, false);
      const before = await count("history_archive");
      await confirm(r, 409);
      assert.equal(await count("history_archive"), before);
      const warning = await preview([
        row("created-late", "New", { 10: "28 Jan 2026, 10:00am" }),
      ]);
      const w = await review(warning);
      assert.equal(w.canConfirm, true);
      assert.ok(
        w.rows[0].issues.some((i) => i.code === "created_after_scheduled"),
      );
      await confirm(w);
    },
  );
  await t.test(
    "current preview/client versions and native overlap changes are rechecked atomically at confirm",
    async () => {
      let p = await preview([row("version")]);
      let r = await review(p);
      p = await expect("/history/previews/" + p.id + "/choices", "POST", {
        version: p.version,
        requestId: randomUUID(),
        choices: [{ row: 2, clientId: "c1", clientVersion: 1 }],
      });
      await confirm(r, 409);
      r = await review(p);
      await sql("UPDATE clients SET version=version+1 WHERE id='c1'").run();
      await confirm(r, 409);
      const native = await preview([row("native-race")]);
      const reviewed = await review(native);
      assert.equal(reviewed.canConfirm, true);
      await sql(
        `INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,gross_cents,net_cents,created_at,updated_at,updated_by,mutation_id) VALUES('native','c1','therapist','service','Current treatment','2026-01-27',600,60,'r1',0,'done',500000,500000,?,?,'owner','native-mutation')`,
        ts,
        ts,
      ).run();
      const before = await count("history_archive");
      await confirm(reviewed, 409);
      assert.equal(await count("history_archive"), before);
      const newReview = await review(native);
      assert.equal(newReview.canConfirm, false);
      assert.deepEqual(newReview.rows[0].nativeOverlapIds, ["native"]);
      await sql("DELETE FROM appointments WHERE id='native'").run();
      assert.equal(await count("booking_slots"), 0);
    },
  );
  await t.test(
    "simultaneous confirmations have one winner; independent previews cannot duplicate or change clients under the same key",
    async () => {
      const p = await preview([row("race")]),
        r = await review(p);
      const same = await Promise.all([
        request("/history/imports/confirm", "POST", r.confirmBody),
        request("/history/imports/confirm", "POST", r.confirmBody),
      ]);
      assert.deepEqual(same.map((x) => x.status).sort(), [200, 201]);
      assert.equal(same[0].data.importId, same[1].data.importId);
      const a = await preview([row("race-cross")]),
        b = await preview([row("race-cross")]);
      const ar = await review(a),
        br = await review(b);
      const cross = await Promise.all([
        request("/history/imports/confirm", "POST", ar.confirmBody),
        request("/history/imports/confirm", "POST", br.confirmBody),
      ]);
      assert.deepEqual(cross.map((x) => x.status).sort(), [201, 409]);
      const loser = cross[0].status === 409 ? a : b,
        rechecked = await review(loser);
      assert.equal(rechecked.counts.duplicates, 1);
      const result = await confirm(rechecked);
      assert.equal(result.created, 0);
      assert.equal(result.duplicates, 1);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM history_archive WHERE ref_hash=?",
            digest("race-cross"),
          ).first()
        ).n,
        1,
      );
    },
  );
  await t.test(
    "failed batch rolls back its receipt, registry, archive, revision and audit; exact retry can succeed",
    async () => {
      const p = await preview([row("rollback-a"), row("rollback-b")]),
        r = await review(p, [2, 3]);
      const before = {
        archive: await count("history_archive"),
        imports: await count("history_imports"),
        refs: await count("history_archive_refs"),
        audit: await count("audit_log"),
        revision: (
          await sql("SELECT revision FROM history_archive_state").first()
        ).revision,
      };
      await db
        .prepare(
          `CREATE TRIGGER test_archive_failure BEFORE INSERT ON history_archive WHEN NEW.ref_hash='${digest("rollback-b")}' BEGIN SELECT RAISE(ABORT,'synthetic_archive_failure'); END`,
        )
        .run();
      await confirm(r, 500);
      assert.deepEqual(
        {
          archive: await count("history_archive"),
          imports: await count("history_imports"),
          refs: await count("history_archive_refs"),
          audit: await count("audit_log"),
          revision: (
            await sql("SELECT revision FROM history_archive_state").first()
          ).revision,
        },
        before,
      );
      await db.prepare("DROP TRIGGER test_archive_failure").run();
      assert.equal((await confirm(r)).created, 2);
      await assert.rejects(
        () =>
          sql("UPDATE history_archive SET completion_state='completed'").run(),
        /immutable/,
      );
    },
  );
  await t.test(
    "expired or discarded unconfirmed reviews cannot import; durable receipts remain readable only by their owner",
    async () => {
      let p = await preview([row("expired")]),
        r = await review(p);
      await sql(
        "UPDATE history_import_reviews SET expires_at=0 WHERE id=?",
        r.reviewId,
      ).run();
      await confirm(r, 410);
      p = await preview([row("expired-preview")]);
      r = await review(p);
      await sql(
        "UPDATE history_previews SET expires_at=0 WHERE id=?",
        p.id,
      ).run();
      await confirm(r, 410);
      p = await preview([row("deleted-preview")]);
      r = await review(p);
      await expect("/history/previews/" + p.id, "DELETE", {
        version: p.version,
      });
      await confirm(r, 404);
      assert.equal((await confirm(saved, 200)).importId, receipt.importId);
    },
  );
  await t.test(
    "client history paginates, reports original-status counts and omits private/financial source evidence for reception",
    async () => {
      const p = await preview(
          Array.from({ length: 26 }, (_, i) =>
            row("pagination-" + i, i % 2 ? "New" : "Confirmed"),
          ),
        ),
        r = await review(
          p,
          Array.from({ length: 26 }, (_, i) => i + 2),
        );
      await confirm(r);
      const owner = await expect("/clients/c1/history", "GET"),
        reception = await expect(
          "/clients/c1/history",
          "GET",
          undefined,
          200,
          "reception",
        );
      assert.equal(owner.rows.length, 25);
      assert.equal(owner.pageSize, 25);
      assert.ok(owner.total > 25);
      assert.ok(owner.totalPages > 1);
      assert.equal(
        owner.statusCounts.reduce((n, g) => n + g.count, 0),
        owner.total,
      );
      assert.deepEqual(reception.statusCounts, owner.statusCounts);
      assert.equal(reception.visitCount, owner.visitCount);
      assert.ok(owner.visitCount > owner.rows.length);
      assert.equal(
        (await expect("/clients/c1/history?page=1", "GET")).visitCount,
        owner.visitCount,
      );
      for (const item of reception.rows) {
        assert.deepEqual(
          Object.keys(item).sort(),
          [
            "id",
            "date",
            "start",
            "duration",
            "serviceName",
            "therapistName",
            "roomName",
            "sourceStatus",
            "completionState",
            "countsAsVisit",
            "requestState",
            "importedAt",
          ].sort(),
        );
      }
      const encoded = JSON.stringify(reception);
      for (const key of [
        "sourceNetSalesMinor",
        "currency",
        "provenance",
        "record",
        "raw",
        "fileDigest",
        "sourceClientLabel",
        "sourceAppointmentRef",
        "bonus",
        "paidAmount",
      ])
        assert.ok(!encoded.includes('"' + key + '"'));
      assert.ok(owner.rows.every((x) => x.record && x.provenance));
      assert.ok(
        (await expect("/clients/c1/history?page=1", "GET")).rows.length > 0,
      );
      await expect("/clients/c1/history", "GET", undefined, 403, "therapist");
      await expect("/clients/c1/history", "GET", undefined, 401, "anonymous");
      await expect("/clients/unknown/history", "GET", undefined, 404);
      await expect("/clients/c1/history?page=-1", "GET", undefined, 400);
      const empty = await expect("/clients/c2/history", "GET");
      assert.equal(empty.total, 0);
      assert.equal(empty.visitCount, 0);
      assert.deepEqual(empty.rows, []);
      assert.equal(await count("clients"), 2);
      assert.equal(await count("appointments"), 0);
      assert.equal(await count("booking_slots"), 0);
      assert.equal(await count("client_import_keys"), 1);
      await db.batch(HISTORY_ARCHIVE_SCHEMA.map((q) => db.prepare(q)));
    },
  );
  await t.test(
    "salon attendance aliases, missing statuses and service lines preserve archive evidence and repeat safety",
    async () => {
      const cases = [
        ["New", true],
        ["Confirmed", true],
        ["Started", true],
        ["Completed", true],
        ["Unknown", true],
        ["Checked in", true],
        ["-", true],
        ["cAnCeLlEd", false],
        [" CANCELED ", false],
        ["No  Show", false],
        ["no-show", false],
        ["NO_SHOW", false],
        ["Ｎｏ　Ｓｈｏｗ", false],
        ["", null],
        ["   ", null],
      ];
      const before = (await expect("/clients/c1/history", "GET")).visitCount;
      const sourceRows = cases.map(([status], i) =>
        row("visit-rule-" + i, status),
      );
      const p = await preview(sourceRows);
      await confirm(
        await review(
          p,
          sourceRows.map((_, i) => i + 2),
        ),
      );
      const snapshot = async () => ({
        archive: (
          await sql(
            "SELECT id,evidence_hash,record_json,completion_state FROM history_archive ORDER BY id",
          ).all()
        ).results,
        revision: (
          await sql(
            "SELECT revision FROM history_archive_state WHERE id=1",
          ).first()
        ).revision,
      });
      const archivedBefore = await snapshot();
      let all = [],
        visits;
      for (let page = 0; ; page++) {
        const h = await expect("/clients/c1/history?page=" + page, "GET");
        assert.equal(h.visitCount, before + 7);
        visits = h.visitCount;
        all.push(...h.rows);
        if (page + 1 >= h.totalPages) break;
      }
      for (const [i, [status, expected]] of cases.entries()) {
        const item = all.find(
          (r) => r.record.sourceAppointmentRef === "visit-rule-" + i,
        );
        assert.equal(item.countsAsVisit, expected, status);
        assert.equal(item.sourceStatus, status.trim() || null);
        assert.equal(item.record.raw.status, status);
      }
      assert.deepEqual(
        await snapshot(),
        archivedBefore,
        "Reading attendance never rewrites archived evidence or revisions",
      );
      const repeat = await preview(sourceRows);
      const receipt = await confirm(
        await review(
          repeat,
          sourceRows.map((_, i) => i + 2),
        ),
      );
      assert.equal(receipt.created, 0);
      assert.equal(receipt.duplicates, sourceRows.length);
      assert.equal(
        (await expect("/clients/c1/history", "GET")).visitCount,
        visits,
      );

      const lines = await preview(
        [
          row("visit-mixed", "Cancelled", { 9: "1" }),
          row("visit-mixed", "Started", { 9: "2" }),
          row("visit-excluded", "Cancelled", { 9: "1" }),
          row("visit-excluded", "No Show", { 9: "2" }),
        ],
        { referenceMode: "service-line" },
      );
      await confirm(await review(lines, [2, 3, 4, 5]));
      assert.equal(
        (await expect("/clients/c1/history", "GET")).visitCount,
        visits + 1,
      );
      const anotherSource = await preview([row("visit-rule-0")], {
        source: "second-source",
      });
      await confirm(await review(anotherSource));
      assert.equal(
        (await expect("/clients/c1/history", "GET")).visitCount,
        visits + 2,
      );
      assert.equal(await count("appointments"), 0);
      assert.equal(await count("booking_slots"), 0);
    },
  );
  await t.test(
    "an archive append between profile snapshots rejects inconsistent totals and a retry reads the new visit",
    async () => {
      const pending = await review(
        await preview([row("concurrent-profile-read", "Started")]),
      );
      const before = await expect("/clients/c1/history", "GET");
      let appended = false;
      const interleavedDB = {
        prepare: (query) => db.prepare(query),
        async batch(statements) {
          const results = await db.batch(statements);
          if (
            !appended &&
            results.length === 4 &&
            results[0].results[0]?.total === before.total &&
            Number.isInteger(results[3].results[0]?.revision)
          ) {
            appended = true;
            assert.equal((await confirm(pending)).created, 1);
          }
          return results;
        },
      };
      await assert.rejects(
        () =>
          historyArchiveRoutes(
            new Request(origin + "/api/clients/c1/history"),
            interleavedDB,
            { id: "owner", role: "owner" },
          ),
        (error) =>
          error.status === 409 && /changed while loading/i.test(error.message),
      );
      assert.equal(
        appended,
        true,
        "The write landed after the first read snapshot",
      );
      const after = await expect("/clients/c1/history", "GET");
      assert.equal(after.total, before.total + 1);
      assert.equal(after.visitCount, before.visitCount + 1);
      assert.equal(
        after.statusCounts.reduce((total, entry) => total + entry.count, 0),
        after.total,
      );
    },
  );
  await t.test(
    "small import requires explicit unlinked policy and acknowledgement without creating clients",
    async () => {
      const p = await preview([row("small-unlinked")], {}, false);
      const body = {
        previewId: p.id,
        version: p.version,
        rows: [2],
        requestId: randomUUID(),
        allowUnlinkedClients: true,
      };
      const r = await expect("/history/imports/review", "POST", body);
      assert.equal(r.canConfirm, true);
      assert.equal(r.counts.unlinked, 1);
      assert.equal(r.counts.linked, 0);
      await expect(
        "/history/imports/review",
        "POST",
        { ...body, allowUnlinkedClients: false },
        409,
      );
      const confirmBody = {
        ...body,
        confirmationToken: r.confirmationToken,
        acknowledgeReview: true,
      };
      await expect("/history/imports/confirm", "POST", confirmBody, 400);
      const before = await count("clients");
      const receipt = await expect(
        "/history/imports/confirm",
        "POST",
        { ...confirmBody, acknowledgeUnlinkedClients: true },
        201,
      );
      assert.equal(receipt.unlinked, 1);
      assert.equal(receipt.created, 1);
      assert.equal(await count("clients"), before);
      const savedRow = await sql(
        "SELECT client_id,record_json FROM history_archive WHERE id=?",
        receipt.rows[0].id,
      ).first();
      assert.equal(savedRow.client_id, null);
      assert.equal(
        JSON.parse(savedRow.record_json).sourceClientLabel,
        "Synthetic One",
      );
      await sql("DELETE FROM history_previews WHERE id=?", p.id).run();
      assert.equal(
        (
          await expect("/history/imports/confirm", "POST", {
            ...confirmBody,
            acknowledgeUnlinkedClients: true,
          })
        ).repeated,
        true,
      );
      const profileBefore = await expect("/clients/c1/history", "GET");
      await sql(
        "INSERT INTO history_archive_client_links(archive_id,client_id,created_by,created_at) VALUES(?,?,?,?)",
        receipt.rows[0].id,
        "c1",
        "owner",
        ts,
      ).run();
      const profileAfter = await expect("/clients/c1/history", "GET");
      assert.equal(profileAfter.total, profileBefore.total + 1);
      assert.equal(profileAfter.visitCount, profileBefore.visitCount + 1);
      const receptionProfile = await expect(
        "/clients/c1/history",
        "GET",
        undefined,
        200,
        "reception",
      );
      assert.equal(receptionProfile.total, profileAfter.total);
      assert.ok(
        receptionProfile.rows.every(
          (r) =>
            !Object.hasOwn(r, "record") &&
            !Object.hasOwn(r, "provenance") &&
            !Object.hasOwn(r, "sourceNetSalesMinor"),
        ),
      );
      const afterLink = await sql(
        "SELECT client_id,record_json FROM history_archive WHERE id=?",
        receipt.rows[0].id,
      ).first();
      assert.deepEqual(afterLink, savedRow);
      const repeatedPreview = await preview([row("small-unlinked")]);
      const repeatedReview = await review(repeatedPreview);
      assert.equal(repeatedReview.counts.duplicates, 1);
      assert.equal((await confirm(repeatedReview)).created, 0);
    },
  );
});
