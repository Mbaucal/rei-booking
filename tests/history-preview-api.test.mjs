import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { HISTORY_PREVIEW_SCHEMA } from "../src/history-preview-schema.mjs";

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
  "Reference",
  "Client",
  "Scheduled",
  "Slot",
  "Duration",
  "Status",
  "Source client",
  "Net sales",
  "Unused",
];
const mapping = {
  appointmentRef: 0,
  clientName: 1,
  scheduledDate: 2,
  slot: 3,
  duration: 4,
  status: 5,
  clientSourceId: 6,
  netSales: 7,
};
const format = {
  dateTimeFormat: "fresha-en",
  slotFormat: "HH:mm:ss-HH:mm:ss",
  durationFormat: "hours-minutes",
  sourceTimeZone: "Europe/Belgrade",
  money: { currency: "RSD", minorUnitDigits: 2 },
  completionMap: { Completed: "completed" },
};
const row = (ref = "001", name = "Synthetic Client", overrides = {}) =>
  Object.assign(
    [
      ref,
      name,
      "27 Jan 2026, 10:00am",
      "10:00:00-11:00:00",
      "1h 0min",
      "New",
      "",
      "4700",
      "",
    ],
    overrides,
  );
const make = (total = 1, overrides = {}) => ({
  source: "synthetic-fresha",
  fileDigest: digest(JSON.stringify(overrides) + String(total)),
  fileBytes: 2000,
  total,
  headers,
  mapping,
  format,
  referenceMode: "verified-appointment",
  ...overrides,
});

test("history preview automatic schema exactly matches its additive migration", async () => {
  const migration = await readFile(
    "migrations/0012_history_previews.sql",
    "utf8",
  );
  assert.equal(migration, HISTORY_PREVIEW_SCHEMA.join(";\n\n") + ";\n");
});

test("History preview Worker + D1: private, resumable, bounded analysis with draft-only choices", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-history-")),
    origin = "https://history.example";
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
    d1Databases: { DB: "history-preview-tests" },
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
  const sessions = {};
  for (const role of [
    "owner",
    "reception",
    "therapist",
    "other-owner",
    "password-owner",
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
    path = "",
    method = "GET",
    body,
    role = "owner",
    extra = {},
  ) {
    const s = sessions[role];
    const response = await mf.dispatchFetch(
      origin + "/api/history/previews" + path,
      {
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
      },
    );
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
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
  const start = (body = make()) => expect("/start", "POST", body, 201);
  async function upload(p, rows, offset = 0) {
    return expect("/" + p.id + "/upload", "POST", { offset, rows });
  }
  async function finish(p) {
    for (let i = 0; i < 102; i++) {
      p = await expect("/" + p.id + "/finalize", "POST", {});
      if (p.phase === "ready") return p;
    }
    assert.fail("Index did not finish within its declared client bound.");
  }
  const page = (p, index = 0) =>
    expect("/" + p.id + "/page?page=" + index, "GET");
  const count = async (table) =>
    (await sql(`SELECT COUNT(*) n FROM ${table}`).first()).n;
  let p;
  await t.test(
    "all routes are owner-only, upstream origin/CSRF/password gates remain enforced",
    async () => {
      for (const role of [
        "anonymous",
        "reception",
        "therapist",
        "password-owner",
      ]) {
        for (const [path, method, body] of [
          ["", "GET"],
          ["/start", "POST", make()],
          ["/00000000-0000-0000-0000-000000000000/clients", "GET"],
          ["/00000000-0000-0000-0000-000000000000/choices", "POST", {}],
        ]) {
          const r = await request(path, method, body, role);
          assert.equal(r.status, role === "anonymous" ? 401 : 403);
          assert.ok(!JSON.stringify(r.data).includes("Synthetic Client"));
        }
      }
      await expect("/start", "POST", make(), 403, "owner", {
        "x-csrf-token": "wrong",
      });
      await expect("/start", "POST", make(), 403, "owner", {
        origin: "https://elsewhere.example",
      });
      p = await start();
      for (const path of ["", "/page", "/clients"])
        await expect("/" + p.id + path, "GET", undefined, 404, "other-owner");
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 0, rows: [row()] },
        404,
        "other-owner",
      );
      await expect(
        "/" + p.id,
        "DELETE",
        { version: p.version },
        404,
        "other-owner",
      );
      assert.deepEqual(
        (await expect("", "GET", undefined, 200, "other-owner")).previews,
        [],
      );
      assert.equal((await request()).headers.get("cache-control"), "no-store");
    },
  );
  await t.test(
    "start and upload retries are atomic; metadata resumes and canonical content is distinguished from claimed digest",
    async () => {
      const retry = await expect("/start", "POST", make());
      assert.equal(retry.id, p.id);
      assert.equal(retry.repeated, true);
      const concurrent = await Promise.all([
        request("/start", "POST", make(1, { fileDigest: digest("parallel") })),
        request("/start", "POST", make(1, { fileDigest: digest("parallel") })),
      ]);
      assert.ok(concurrent.every((r) => [200, 201].includes(r.status)));
      assert.equal(concurrent[0].data.id, concurrent[1].data.id);
      assert.deepEqual(
        (await expect("/" + p.id, "GET")).config.mapping,
        mapping,
      );
      await expect("/" + p.id + "/page", "GET", undefined, 409);
      await expect("/" + p.id + "/finalize", "POST", {}, 409);
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 1, rows: [row()] },
        400,
      );
      const writes = await Promise.all([
        request("/" + p.id + "/upload", "POST", { offset: 0, rows: [row()] }),
        request("/" + p.id + "/upload", "POST", { offset: 0, rows: [row()] }),
      ]);
      assert.ok(
        writes.every((r) => r.status === 200),
        JSON.stringify(writes.map((r) => r.data)),
      );
      p = writes[0].data;
      assert.equal(p.uploaded, 1);
      assert.equal(p.version, 2);
      assert.equal(await count("history_preview_rows"), 1);
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 0, rows: [row("changed")] },
        409,
      );
      assert.equal(p.provenance.fileDigest, "claimed-original-file");
      p = await finish(p);
      assert.equal(p.phase, "ready");
      const result = await page(p);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].record.sourceAppointmentRef, "001");
      assert.equal(result.rows[0].record.completionState, "unknown");
      assert.equal(result.rows[0].selected, false);
      assert.equal(result.imported, false);
      assert.equal(await count("clients"), 0);
      assert.equal(await count("appointments"), 0);
      assert.equal(await count("client_import_keys"), 0);
    },
  );
  await t.test(
    "full bounded NFKC name/contact indexing finds profiles beyond the first thousand",
    async () => {
      const clients = Array.from({ length: 1002 }, (_, i) => ({
        id: "c" + String(i).padStart(5, "0"),
        name: i === 1001 ? "ŽELJKA  Ｔｅｓｔ" : `Synthetic ${i}`,
      }));
      await sql(
        `INSERT INTO clients(id,name,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),?,? FROM json_each(?)`,
        ts,
        ts,
        JSON.stringify(clients),
      ).run();
      p = await start(make(2, { fileDigest: digest("unicode") }));
      p = await upload(p, [
        row("unicode", "željka test"),
        row("other", "Synthetic 0"),
      ]);
      let partial = await expect("/" + p.id + "/finalize", "POST", {});
      assert.equal(partial.phase, "indexing");
      assert.equal(partial.indexedClients, 1000);
      await expect("/" + p.id + "/page", "GET", undefined, 409);
      await sql(
        "UPDATE clients SET version=version+1,name=? WHERE id=?",
        "Unrelated edit",
        "c00003",
      ).run();
      partial = await expect("/" + p.id + "/finalize", "POST", {});
      assert.equal(partial.phase, "indexing");
      assert.equal(partial.indexedClients, 1000);
      p = await finish(partial);
      assert.equal(p.indexedClients, 1002);
      const result = await page(p);
      assert.equal(result.rows[0].identity.state, "unresolved");
      assert.equal(result.rows[0].candidates[0].id, "c01001");
      assert.equal(result.rows[0].candidates[0].name, "ŽELJKA  Ｔｅｓｔ");
      const search = await expect(
        "/" + p.id + "/clients?q=" + encodeURIComponent("željka test"),
        "GET",
      );
      assert.equal(search.clients[0].id, "c01001");
      assert.equal(
        (await expect("/" + p.id + "/clients?q=%25", "GET")).clients.length,
        0,
      );
      assert.equal(
        (await expect("/" + p.id + "/clients", "GET")).clients.length,
        50,
      );
      assert.equal(
        (await expect("/" + p.id + "/clients", "GET")).hasMore,
        true,
      );
    },
  );
  await t.test(
    "draft row/batch choices are versioned, retry-safe and never promote identity or write permanent data",
    async () => {
      const before = {
        clients: await count("clients"),
        keys: await count("client_import_keys"),
        appointments: await count("appointments"),
        audit: await count("audit_log"),
      };
      const body = {
        version: p.version,
        requestId: "choice-one",
        choices: [
          { row: 2, clientId: "c01001", clientVersion: 1 },
          { row: 3, clientId: "c00000", clientVersion: 1 },
        ],
      };
      p = await expect("/" + p.id + "/choices", "POST", body);
      assert.equal(p.version, body.version + 1);
      assert.equal(
        (await expect("/" + p.id + "/choices", "POST", body)).repeated,
        true,
      );
      await expect(
        "/" + p.id + "/choices",
        "POST",
        {
          ...body,
          choices: [{ row: 2, clientId: "c00000", clientVersion: 1 }],
        },
        409,
      );
      await expect(
        "/" + p.id + "/choices",
        "POST",
        { ...body, requestId: "stale-version" },
        409,
      );
      const pageAfter = await page(p);
      assert.equal(pageAfter.rows[0].draftChoice.clientId, "c01001");
      assert.equal(pageAfter.rows[0].draftChoice.stale, false);
      assert.equal(pageAfter.rows[0].identity.state, "unresolved");
      assert.equal(pageAfter.rows[0].selected, false);
      assert.equal(pageAfter.summary.draftChoices, 2);
      await expect(
        "/" + p.id + "/choices",
        "POST",
        {
          version: p.version,
          requestId: "stale-client",
          choices: [
            { row: 2, clientId: "c01001", clientVersion: 1 },
            { row: 3, clientId: "c00000", clientVersion: 99 },
          ],
        },
        409,
      );
      assert.equal((await page(p)).summary.draftChoices, 2);
      await sql(
        "UPDATE clients SET version=version+1 WHERE id=?",
        "c01001",
      ).run();
      await expect("/" + p.id + "/page", "GET", undefined, 409);
      await expect("/" + p.id + "/clients", "GET", undefined, 409);
      p = await finish(p);
      const stale = await page(p);
      assert.equal(stale.rows[0].draftChoice.stale, true);
      assert.equal(stale.rows[0].draftChoice.client.version, 2);
      p = await expect("/" + p.id + "/choices", "POST", {
        version: p.version,
        requestId: "clear-choice",
        choices: [{ row: 2, clientId: null, clientVersion: null }],
      });
      assert.equal((await page(p)).rows[0].draftChoice, null);
      assert.deepEqual(
        {
          clients: await count("clients"),
          keys: await count("client_import_keys"),
          appointments: await count("appointments"),
          audit: await count("audit_log"),
        },
        before,
      );
    },
  );
  await t.test(
    "duplicates and changed references across chunks reclassify all occurrences globally",
    async () => {
      p = await start(make(102, { fileDigest: digest("cross-chunk") }));
      const first = Array.from({ length: 100 }, (_, i) =>
        row(String(i), "Synthetic 0"),
      );
      p = await upload(p, first);
      p = await upload(
        p,
        [row("0", "Synthetic 0"), row("1", "Synthetic 0", { 7: "9999" })],
        100,
      );
      p = await finish(p);
      const a = await page(p),
        b = await page(p, 2);
      assert.equal(a.rows[0].disposition, "unresolved");
      assert.equal(a.rows[1].disposition, "conflict");
      assert.equal(b.rows[0].disposition, "duplicate");
      assert.equal(b.rows[1].disposition, "conflict");
      assert.equal(a.summary.sourceConflictRows, 2);
      assert.equal(a.summary.duplicateRows, 1);
      assert.equal(b.rows[0].duplicateOf.id, a.rows[0].rowId);
      assert.equal(a.pageSummary.total, 50);
      assert.equal(b.pageSummary.total, 2);
      assert.equal(a.summary.total, 102);
    },
  );
  await t.test(
    "current native appointments flag overlaps and a true verified source link remains separate from draft choice",
    async () => {
      await sql(
        `INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES('svc','Synthetic service',60,470000,?,?)`,
        ts,
        ts,
      ).run();
      await sql(
        `INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,gross_cents,net_cents,created_at,updated_at,updated_by,mutation_id) VALUES('native','c00000','therapist','svc','Synthetic service','2026-01-27',600,60,'r1',0,'done',470000,470000,?,?,'owner','synthetic-mutation')`,
        ts,
        ts,
      ).run();
      await sql(
        `INSERT INTO client_imports(id,owner_id,source,revision,plan_json,status,created_at,expires_at) VALUES('accepted-client-export','owner','synthetic-fresha',0,'{}','applied',?,?)`,
        Date.now(),
        Date.now() + 3600000,
      ).run();
      await sql(
        `INSERT INTO client_import_keys(source,source_key,client_id,import_id) VALUES('synthetic-fresha',?,'c00000','accepted-client-export')`,
        "id:" + digest("source-0"),
      ).run();
      p = await start(make(1, { fileDigest: digest("native-overlap") }));
      p = await upload(p, [
        row("native-source", "Synthetic 0", { 6: "source-0", 5: "Completed" }),
      ]);
      p = await finish(p);
      const result = await page(p);
      assert.equal(result.rows[0].identity.state, "linked");
      assert.equal(result.rows[0].draftChoice, null);
      assert.deepEqual(result.rows[0].nativeOverlapIds, ["native"]);
      assert.equal(result.rows[0].eligibility.visits, false);
      const native = await sql(
        "SELECT gross_cents,net_cents,duration,status FROM appointments WHERE id=?",
        "native",
      ).first();
      assert.deepEqual(native, {
        gross_cents: 470000,
        net_cents: 470000,
        duration: 60,
        status: "done",
      });
      assert.equal(await count("appointments"), 1);
      assert.equal(await count("client_import_keys"), 1);
    },
  );
  await t.test(
    "expiry, owner retention and discard versions do not expose or revive previews",
    async () => {
      await expect("/" + p.id, "DELETE", { version: p.version - 1 }, 409);
      await expect("/" + p.id, "DELETE", { version: p.version });
      await expect("/" + p.id, "GET", undefined, 404);
      for (let i = 0; i < 4; i++)
        await start(make(1, { fileDigest: digest("retention-" + i) }));
      const list = (await expect("", "GET")).previews;
      assert.equal(list.length, 3);
      const expired = list[0];
      await sql(
        "UPDATE history_previews SET expires_at=0 WHERE id=?",
        expired.id,
      ).run();
      await expect("/" + expired.id, "GET", undefined, 410);
      await expect("/" + expired.id + "/page", "GET", undefined, 410);
      await expect("/" + expired.id + "/clients", "GET", undefined, 410);
      await expect("/" + expired.id, "GET", undefined, 404, "other-owner");
      assert.equal((await expect("", "GET")).previews.length, 2);
    },
  );
  await t.test(
    "server validates shape, row/column/cell/HTTP and cumulative byte bounds independently of declared file size",
    async () => {
      await expect("/start", "POST", make(50001), 400);
      await expect(
        "/start",
        "POST",
        make(1, { fileBytes: 25 * 1048576 + 1 }),
        400,
      );
      await expect(
        "/start",
        "POST",
        make(1, { mapping: { clientName: 999 } }),
        400,
      );
      p = await start(make(2, { fileDigest: digest("limits"), fileBytes: 1 }));
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 0, rows: [["bad width"]] },
        400,
      );
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 0, rows: [row("r", "n", { 8: "x".repeat(16385) })] },
        400,
      );
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 0, rows: [row("r", "n", { 8: "x".repeat(2 * 1048576) })] },
        413,
      );
      p = await upload(p, [row()]);
      assert.ok(
        p.receivedBytes > p.fileBytes,
        "Declared file size is not trusted as content measurement",
      );
      await sql(
        "UPDATE history_previews SET received_bytes=? WHERE id=?",
        25 * 1048576 - 1,
        p.id,
      ).run();
      await expect(
        "/" + p.id + "/upload",
        "POST",
        { offset: 1, rows: [row("next")] },
        413,
      );
      assert.equal((await expect("/" + p.id, "GET")).uploaded, 1);
    },
  );
  await t.test(
    "normalized D1 values and page work are bounded before large evidence is materialized",
    async () => {
      p = await start(
        make(50, { fileDigest: digest("large-evidence"), fileBytes: 4000000 }),
      );
      const large = row("r".repeat(16384), "n".repeat(16384), {
        6: "s".repeat(16384),
      });
      const body = { offset: 0, rows: Array.from({ length: 30 }, () => large) };
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 2 * 1048576);
      const oversized = await expect("/" + p.id + "/upload", "POST", body, 413);
      assert.match(oversized.error, /normalized upload block/);
      assert.equal((await expect("/" + p.id, "GET")).uploaded, 0);
      for (let offset = 0; offset < 50; offset += 10)
        p = await upload(
          p,
          Array.from({ length: 10 }, () => large),
          offset,
        );
      p = await finish(p);
      const oversizedPage = await expect(
        "/" + p.id + "/page",
        "GET",
        undefined,
        422,
      );
      assert.match(oversizedPage.error, /not truncated/);
      assert.equal((await expect("/" + p.id, "GET")).uploaded, 50);
    },
  );
  await t.test(
    "50,000 rows upload in bounded chunks and the last page remains usable after Worker restart",
    async () => {
      p = await start(
        make(50000, {
          fileDigest: digest("fifty-thousand"),
          fileBytes: 6000000,
          referenceMode: "unverified",
          format: { ...format, sourceTimeZone: null },
        }),
      );
      const startTime = Date.now();
      for (let offset = 0; offset < 50000; offset += 100)
        p = await upload(
          p,
          Array.from({ length: 100 }, (_, i) =>
            row(String(offset + i), "Synthetic 0"),
          ),
          offset,
        );
      p = await finish(p);
      assert.equal(p.uploaded, 50000);
      assert.equal(p.totalPages, 1000);
      const last = await page(p, 999);
      assert.equal(last.rows.length, 50);
      assert.equal(last.rows[49].row, 50001);
      assert.equal(last.summary.total, 50000);
      assert.equal(last.summary.uploaded, 50000);
      assert.equal(last.summary.duplicateRows, 0);
      assert.equal(last.rows[49].record.sourceTimeZone, null);
      assert.equal(last.rows[49].eligibility.bonuses, false);
      t.diagnostic(
        `50,000 synthetic rows processed through 500 bounded upload requests in ${Date.now() - startTime} ms.`,
      );
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      const persisted = await page(p, 999);
      assert.equal(persisted.rows[49].record.sourceAppointmentRef, "49999");
      assert.equal(await count("appointments"), 1);
      assert.equal(await count("clients"), 1002);
    },
  );
});
