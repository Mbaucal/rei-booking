import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { parseCSV, csvCell, decodeReiCell } from "../src/client-csv.mjs";
import { CLIENT_TRANSFER_SCHEMA } from "../src/client-transfer-schema.mjs";

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
test("client CSV parses quoted Unicode, multiline notes, BOM and separators; rejects malformed/oversized data", () => {
  const data = parseCSV(
    '\uFEFFName;Phone;Note\r\n"Željka, ""X""";0611234567;"Line one\r\nLine two"',
  );
  assert.equal(data.delimiter, ";");
  assert.equal(data.rows[0][2], "Line one\r\nLine two");
  assert.equal(parseCSV("First\tLast\nAna\tIvić").delimiter, "\t");
  assert.equal(
    parseCSV('Name,Note\nAna,"said ""hello"""').rows[0][1],
    'said "hello"',
  );
  for (const csv of [
    'Name\n"open',
    'Name\n"Ana" trailing',
    "Name,Phone\nAna",
    "Name\nA\u0000",
    "Name\nA\uFFFD",
    "Name;Phone,Email\nA;B,C",
  ])
    assert.throws(() => parseCSV(csv));
  assert.throws(() => parseCSV("Name\n" + "A".repeat(1048576)));
  assert.throws(() => parseCSV("Name\n" + Array(1001).fill("Ana").join("\n")));
  for (const value of [
    "=1+1",
    " +123",
    "-2",
    "@a",
    "'literal",
    "\t=2",
    "Željka",
  ]) {
    const encoded = csvCell(value),
      decoded = parseCSV("Name\n" + encoded).rows[0][0];
    assert.equal(decodeReiCell(decoded), value);
    if (/^[\s]*[=+\-@]|^[\t\r\n']/.test(value)) assert.equal(decoded[0], "'");
  }
});
test("Client transfer Worker + D1: reviewed, atomic, repeat-safe imports and private export", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-clients-")),
    origin = "https://clients.example";
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
    d1Databases: { DB: "client-transfer-tests" },
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
    "Test therapist",
    JSON.stringify(defaultWeek()),
    ts,
    ts,
  ).run();
  const sessions = {};
  for (const role of ["owner", "reception", "therapist", "other-owner"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,therapist_id,created_at) VALUES(?,?,?,?,?,?,?)",
      role,
      role + "@example.test",
      role,
      "unused",
      role === "other-owner" ? "owner" : role,
      role === "therapist" ? role : null,
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
  async function raw(path, method = "GET", body, role = "owner", headers = {}) {
    const s = sessions[role];
    return mf.dispatchFetch(origin + "/api" + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(s
          ? { cookie: "__Host-rei_session=" + s.raw, "x-csrf-token": s.csrf }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function request(...args) {
    const r = await raw(...args);
    return { status: r.status, data: await r.json() };
  }
  const count = async () =>
    (await sql("SELECT COUNT(*) AS n FROM clients").first()).n;
  const mapping = { sourceId: 0, name: 1, phone: 2, email: 3, note: 4 };
  const make = (rows, overrides = {}) => ({
    csv:
      "ID,Name,Phone,Email,Notes\n" +
      rows
        .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","))
        .join("\n"),
    mapping,
    source: "fresha",
    ...overrides,
  });
  const preview = (body) => request("/clients/import/preview", "POST", body);
  const commit = (
    p,
    rows = p.rows.filter((r) => r.selected).map((r) => r.row),
    role = "owner",
  ) => request("/clients/import/" + p.id + "/commit", "POST", { rows }, role);
  const base = make([
    ["a1", "Ana Ivić", "061 123 4567", "ANA@example.test", "Initial note"],
    ["a1", "Ana Ivić", "061 123 4567", "ANA@example.test", "Initial note"],
    ["b1", "Boris Test", "062 123 4567", "", ""],
    ["c1", "Other Person", "062 123 4567", "", ""],
    ["d1", "Bad Email", "", "no-email", ""],
    ["", "Walk in name", "", "", ""],
  ]);
  let first;
  await t.test(
    "owner-only inspect/export/import enforce session, CSRF and role boundaries",
    async () => {
      for (const role of ["anonymous", "reception", "therapist"]) {
        const expected = role === "anonymous" ? 401 : 403;
        for (const [path, method, body] of [
          ["/clients/export.csv", "GET"],
          ["/clients/import/inspect", "POST", base],
          ["/clients/import/preview", "POST", base],
          [
            "/clients/import/00000000-0000-0000-0000-000000000000/commit",
            "POST",
            { rows: [2] },
          ],
        ]) {
          const r = await request(path, method, body, role);
          assert.equal(r.status, expected);
          assert.ok(!JSON.stringify(r.data).includes("Ana"));
        }
      }
      assert.equal(
        (
          await request("/clients/import/preview", "POST", base, "owner", {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/clients/import/preview", "POST", base, "owner", {
            origin: "https://elsewhere.example",
          })
        ).status,
        403,
      );
      const r = await request("/clients/import/inspect", "POST", base);
      assert.equal(r.status, 200);
      assert.equal(r.data.total, 6);
      assert.equal(await count(), 0);
    },
  );
  await t.test(
    "preview classifies conflicts and invalid rows without client writes; mapping is explicit",
    async () => {
      first = (await preview(base)).data;
      assert.deepEqual(
        first.rows.map((r) => r.status),
        ["new", "duplicate", "conflict", "conflict", "invalid", "review"],
      );
      assert.equal(first.rows[0].client.phone_key, "381611234567");
      assert.equal(first.rows[0].client.email, "ana@example.test");
      assert.equal(await count(), 0);
      for (const m of [
        {},
        { name: 1, phone: 1 },
        { name: 99 },
        { name: 1, firstName: 0 },
        { name: 1, arbitrary: 0 },
      ])
        assert.equal((await preview({ ...base, mapping: m })).status, 400);
      assert.equal((await commit(first, [3])).status, 400);
      assert.equal((await commit(first, [2, 2])).status, 400);
      assert.equal((await commit(first, [2], "other-owner")).status, 404);
      assert.equal(await count(), 0);
    },
  );
  await t.test(
    "confirmed import is atomic, audit is aggregate, same-preview concurrent retries add only once",
    async () => {
      const results = await Promise.all([
        commit(first, [2, 7]),
        commit(first, [2, 7]),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
      assert.ok(results.some((r) => r.data.repeated));
      assert.equal(await count(), 2);
      assert.equal((await commit(first, [2])).status, 409);
      const record = await sql(
        "SELECT plan_json FROM client_imports WHERE id=?",
        first.id,
      ).first();
      assert.equal(record.plan_json, "[]");
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM client_import_keys WHERE import_id=?",
            first.id,
          ).first()
        ).n,
        2,
      );
      const audit = await sql(
        "SELECT * FROM audit_log WHERE action='client_import'",
      ).all();
      assert.equal(audit.results.length, 1);
      assert.ok(!audit.results[0].after_json.includes("Ana"));
      const again = (await preview(base)).data;
      assert.equal(again.rows[0].status, "existing");
      assert.equal(again.rows[5].status, "existing");
      const changed = (
        await preview(make([["a1", "Changed name", "0611234567", "", ""]]))
      ).data;
      assert.equal(changed.rows[0].status, "conflict");
      assert.equal(
        (
          await sql(
            "SELECT name FROM clients WHERE phone_key=?",
            "381611234567",
          ).first()
        ).name,
        "Ana Ivić",
      );
    },
  );
  await t.test(
    "same-name matches never merge; name-only rows require selection; first/last name mapping works",
    async () => {
      const p = (
        await preview({
          source: "other",
          csv: "First,Last,Phone\nAna,Ivić,+381641111111\nNew,Person,+381642222222",
          mapping: { firstName: 0, lastName: 1, phone: 2 },
        })
      ).data;
      assert.equal(p.rows[0].status, "review");
      assert.equal(p.rows[0].selected, false);
      assert.equal(p.rows[1].client.name, "New Person");
      assert.equal((await commit(p, [2, 3])).status, 201);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM clients WHERE name='Ana Ivić'",
          ).first()
        ).n,
        2,
      );
    },
  );
  await t.test(
    "normal edits invalidate previews and competing previews cannot silently overwrite or duplicate",
    async () => {
      const body = make([["e1", "Late Client", "0643333333", "", ""]]);
      const p1 = (await preview(body)).data,
        p2 = (await preview(body)).data;
      const old = await sql(
        "SELECT * FROM clients WHERE name='New Person'",
      ).first();
      assert.equal(
        (
          await request(
            "/clients/" + old.id,
            "PUT",
            { ...old, note: "Changed in reception", version: old.version },
            "reception",
          )
        ).status,
        200,
      );
      assert.equal((await commit(p1)).status, 409);
      assert.equal((await commit(p2)).status, 409);
      const p3 = (await preview(body)).data,
        p4 = (await preview(body)).data,
        n = await count();
      const results = await Promise.all([commit(p3), commit(p4)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      assert.equal(await count(), n + 1);
    },
  );
  await t.test(
    "a D1 write failure rolls back clients, keys, revision, claim and audit together",
    async () => {
      const p = (
        await preview(
          make([
            ["f1", "Good Row", "0644444444", "", ""],
            ["f2", "Force failure", "0645555555", "", ""],
          ]),
        )
      ).data;
      const before = await count(),
        revision = await sql(
          "SELECT revision FROM client_transfer_state",
        ).first();
      await db
        .prepare(
          "CREATE TRIGGER test_import_failure BEFORE INSERT ON clients WHEN NEW.name='Force failure' BEGIN SELECT RAISE(ABORT,'test failure'); END",
        )
        .run();
      assert.equal((await commit(p)).status, 500);
      assert.equal(await count(), before);
      assert.deepEqual(
        await sql("SELECT revision FROM client_transfer_state").first(),
        revision,
      );
      assert.equal(
        (
          await sql(
            "SELECT status FROM client_imports WHERE id=?",
            p.id,
          ).first()
        ).status,
        "preview",
      );
      await db.prepare("DROP TRIGGER test_import_failure").run();
      assert.equal((await commit(p)).status, 201);
    },
  );
  await t.test(
    "export includes all clients, safely encodes formulas and round trips without corrupting phones/notes",
    async () => {
      const note = '=HYPERLINK("bad")\nSecond line';
      const p = (
        await preview(
          make([["g1", "=2+2", "+381651111111", "formula@example.test", note]]),
        )
      ).data;
      assert.equal((await commit(p)).status, 201);
      const basic = await raw("/clients/export.csv");
      assert.equal(basic.status, 200);
      assert.equal(basic.headers.get("cache-control"), "no-store");
      assert.ok(!parseCSV(await basic.text()).headers.includes("Notes"));
      const download = await raw("/clients/export.csv?notes=true"),
        parsed = parseCSV(await download.text());
      assert.equal(parsed.rows.length, await count());
      assert.equal(
        parsed.rows.find((r) => r[1] === "'=2+2")[2],
        "'+381651111111",
      );
      const csv = [parsed.headers, ...parsed.rows]
        .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","))
        .join("\r\n");
      const p2 = await preview({ csv, source: "rei", mapping });
      assert.equal(p2.status, 201);
      assert.ok(p2.data.rows.every((r) => r.status === "existing"));
      assert.equal(
        p2.data.rows.find((r) => r.client.name === "=2+2").client.note,
        note,
      );
    },
  );
  await t.test(
    "expired and disabled-owner previews cannot commit; server-stored plan survives restart",
    async () => {
      let p = (await preview(make([["h1", "Expiry", "0646666666", "", ""]])))
        .data;
      await sql(
        "UPDATE client_imports SET expires_at=0 WHERE id=?",
        p.id,
      ).run();
      assert.equal((await commit(p)).status, 409);
      p = (await preview(make([["h2", "Restart", "0647777777", "", ""]]))).data;
      await sql("UPDATE users SET active=0 WHERE id='owner'").run();
      assert.equal((await commit(p)).status, 401);
      await sql("UPDATE users SET active=1 WHERE id='owner'").run();
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      const r = await request("/clients/import/" + p.id + "/commit", "POST", {
        rows: [2],
        client: { name: "Tampered" },
      });
      assert.equal(r.status, 201);
      assert.ok(
        await sql("SELECT id FROM clients WHERE name='Restart'").first(),
      );
      assert.equal(
        await sql("SELECT id FROM clients WHERE name='Tampered'").first(),
        null,
      );
      assert.equal((await commit(p)).data.repeated, true);
    },
  );
  await t.test(
    "1,000-row imports avoid per-row parameter limits and duplicate IDs; export exceeds UI search cap",
    async () => {
      const body = make(
        Array.from({ length: 1000 }, (_, i) => [
          "bulk" + i,
          "Bulk " + i,
          "",
          "bulk" + i + "@example.test",
          "",
        ]),
      );
      const p = await preview(body);
      assert.equal(p.status, 201);
      const before = await count();
      const r = await commit(p.data);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(await count(), before + 1000);
      const again = (await preview(body)).data;
      assert.ok(again.rows.every((r) => r.status === "existing"));
      assert.equal((await request("/clients")).data.clients.length, 100);
      // Export has no import's 1,000-row cap, so inspect line count for this unquoted fixture.
      const exportText = await (await raw("/clients/export.csv")).text();
      assert.ok(exportText.includes("bulk999@example.test"));
    },
  );
  await t.test(
    "additive schema matches the migration and repeated application preserves records",
    async () => {
      const migration = statements(
        await readFile("migrations/0008_client_transfer.sql", "utf8"),
      );
      assert.deepEqual(
        migration.map((s) => s.replace(/;$/, "")),
        CLIENT_TRANSFER_SCHEMA,
      );
      const before = await count();
      for (const q of migration) await db.prepare(q).run();
      assert.equal(await count(), before);
    },
  );
});
