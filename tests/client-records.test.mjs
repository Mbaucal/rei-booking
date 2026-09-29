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
import {
  instagramHandle,
  CLIENT_CONTACT_SCHEMA,
} from "../src/client-contacts.mjs";
import { CLIENT_BULK_SCHEMA } from "../src/client-bulk-schema.mjs";
import { uploadClientCSV } from "../public/client-upload.js";
import { DEFAULT_DESIGN } from "../src/voucher-render.mjs";
import { randomUUID } from "node:crypto";
test("Instagram identities normalize handles/profile links and reject ambiguous or unsafe input", () => {
  for (const v of [
    "@Rei.Test",
    "REI.TEST",
    "https://www.instagram.com/Rei.Test/?igsh=abc",
    "instagram.com/rei.test/",
  ])
    assert.equal(instagramHandle(v), "rei.test");
  for (const v of [
    "https://other.example/name",
    "https://instagram.com/p/abc",
    "name space",
    "a..b",
    "<script>",
    ".dot",
    "a".repeat(31),
  ])
    assert.throws(() => instagramHandle(v));
  assert.equal(instagramHandle(""), "");
});
test("browser and server share the large-file parser, including the 50,000-row boundary", async () => {
  assert.equal(
    await readFile("public/client-csv.js", "utf8"),
    await readFile("src/client-csv.mjs", "utf8"),
  );
  assert.equal(
    parseCSV("Name\n" + Array(50000).fill("Ana").join("\n")).rows.length,
    50000,
  );
  assert.throws(
    () =>
      parseCSV(
        "Name,Note\n" +
          Array(4000)
            .fill("Ana," + "n".repeat(7000))
            .join("\n"),
      ),
    /25 MiB/,
  );
});
test("Client records Worker + D1: Instagram, named duplicates and a single large-file workflow", async (t) => {
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

  const accepted = async (
    path,
    method = "GET",
    body,
    role = "owner",
    expected = 200,
  ) => {
    const r = await request(path, method, body, role);
    assert.equal(r.status, expected, JSON.stringify(r.data));
    return r.data;
  };
  const create = async (body, role = "owner") =>
    accepted("/clients", "POST", body, role, 201);
  const profile = async (id) => (await accepted("/clients/" + id)).client;
  const columns = ["ID", "Name", "Phone", "Email", "Instagram", "Notes"],
    mapping = {
      sourceId: 0,
      name: 1,
      phone: 2,
      email: 3,
      instagram: 4,
      note: 5,
    };
  const config = (rows) => ({
    headers: columns,
    mapping,
    source: "fresha",
    total: rows.length,
    fileHash: digest(JSON.stringify(rows)),
  });
  const start = async (rows) =>
    accepted("/clients/import/bulk/start", "POST", config(rows), "owner", 201);
  const part = async (id, offset, rows) =>
    accepted(`/clients/import/bulk/${id}/upload`, "POST", { offset, rows });
  const finish = async (id) =>
    accepted(`/clients/import/bulk/${id}/finalize`, "POST", {});
  const preview = async (rows) => {
    const p = await start(rows);
    for (let offset = 0; offset < rows.length; offset += 250)
      await part(p.id, offset, rows.slice(offset, offset + 250));
    return finish(p.id);
  };
  const commit = (p, rows = p.readyRows) =>
    request(`/clients/import/bulk/${p.id}/commit`, "POST", { rows });
  let ana, bea, service, room;
  await t.test(
    "normal client entry stores notes/Instagram, excludes self and names phone/Instagram matches",
    async () => {
      ana = (
        await create(
          {
            name: "Ana Test",
            phone: "061 123 4567",
            instagram: "https://instagram.com/Ana.Test/",
            note: "Prefers a quiet room.\nNo strong scents.",
          },
          "reception",
        )
      ).id;
      bea = (
        await create({
          name: "Bea Test",
          phone: "0622222222",
          instagram: "@Bea.Test",
        })
      ).id;
      const p = await profile(ana);
      assert.equal(p.instagram, "ana.test");
      assert.match(p.note, /No strong scents/);
      let matches = (
        await accepted(
          "/clients/matches?phone=" +
            encodeURIComponent("00381611234567") +
            "&instagram=@ANA.TEST",
          "GET",
          undefined,
          "reception",
        )
      ).matches;
      assert.equal(matches.length, 1);
      assert.equal(matches[0].id, ana);
      assert.deepEqual(matches[0].matchedOn, ["phone", "instagram"]);
      assert.equal(
        (await accepted("/clients/matches?instagram=ana.test&exclude=" + ana))
          .matches.length,
        0,
      );
      for (const body of [
        { name: "Duplicate", phone: "+381611234567" },
        { name: "Duplicate", instagram: "@ANA.Test" },
      ]) {
        const r = await request("/clients", "POST", body);
        assert.equal(r.status, 409);
        assert.equal(r.data.matches[0].name, "Ana Test");
        assert.equal(r.data.matches[0].id, ana);
      }
      const dual = await request("/clients", "POST", {
        name: "Wrong combination",
        phone: p.phone,
        instagram: "Bea.Test",
      });
      assert.deepEqual(
        dual.data.matches.map((c) => c.id).sort(),
        [ana, bea].sort(),
      );
      assert.equal((await accepted("/clients?q=@ana.TEST")).clients[0].id, ana);
      assert.equal(
        (
          await request(
            "/clients/matches?instagram=ana.test",
            "GET",
            undefined,
            "therapist",
          )
        ).status,
        403,
      );
      assert.equal(
        (await request("/clients/" + ana, "GET", undefined, "therapist"))
          .status,
        403,
      );
    },
  );
  await t.test(
    "edits retain omitted Instagram, reject stale writes, release removed handles and resolve races",
    async () => {
      let p = await profile(ana);
      await accepted("/clients/" + ana, "PUT", {
        ...p,
        note: "Updated note",
        instagram: "@Ana.New",
      });
      const stale = await request("/clients/" + ana, "PUT", {
        ...p,
        instagram: "@hijack",
        note: "Wrong old write",
      });
      assert.equal(stale.status, 409);
      p = await profile(ana);
      assert.equal(p.instagram, "ana.new");
      assert.equal(p.note, "Updated note");
      delete p.instagram;
      await accepted("/clients/" + ana, "PUT", {
        ...p,
        note: "Keep the handle",
      });
      assert.equal((await profile(ana)).instagram, "ana.new");
      p = await profile(ana);
      await accepted("/clients/" + ana, "PUT", { ...p, instagram: "" });
      assert.equal((await profile(ana)).instagram, "");
      const result = await Promise.all([
        request("/clients", "POST", { name: "Race One", instagram: "Ana.New" }),
        request("/clients", "POST", {
          name: "Race Two",
          instagram: "@ana.new",
        }),
      ]);
      assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
      assert.equal(result.find((r) => r.status === 409).data.matches.length, 1);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM client_instagram WHERE instagram='ana.new'",
          ).first()
        ).n,
        1,
      );
    },
  );
  await t.test(
    "calendar inline client entry saves notes and Instagram atomically and reports existing profiles",
    async () => {
      service = (
        await accepted(
          "/services",
          "POST",
          {
            name: "Test massage",
            duration: 60,
            priceCents: 470000,
            color: "#8dbdbc",
          },
          "owner",
          201,
        )
      ).id;
      room = "r1";
      const booking = {
        therapistId: "therapist",
        serviceId: service,
        roomId: room,
        bed: 0,
        date: "2026-10-06",
        start: 660,
        duration: 60,
        status: "booked",
      };
      const bad = await request("/appointments", "POST", {
        ...booking,
        newClient: { name: "Wrong Bea", instagram: "Bea.Test" },
      });
      assert.equal(bad.status, 409, JSON.stringify(bad.data));
      assert.equal(bad.data.matches[0].id, bea);
      const saved = await accepted(
        "/appointments",
        "POST",
        {
          ...booking,
          newClient: {
            name: "Calendar New",
            instagram: "@calendar.test",
            note: "Calendar client note",
          },
        },
        "owner",
        201,
      );
      const c = await sql(
        "SELECT c.id,c.note,g.instagram FROM clients c JOIN client_instagram g ON g.client_id=c.id WHERE g.instagram='calendar.test'",
      ).first();
      assert.equal(c.note, "Calendar client note");
      assert.ok(c.id);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM clients WHERE name='Wrong Bea'",
          ).first()
        ).n,
        0,
      );
      assert.equal(saved.appointment.clientId, c.id);
    },
  );
  await t.test(
    "buyer creation uses the same named duplicate check and preserves notes/Instagram",
    async () => {
      const body = {
        requestId: randomUUID(),
        items: [
          {
            kind: "amount",
            priceCents: 500000,
            recipientName: "Test",
            senderName: "",
            message: "",
            expiresOn: null,
            design: { ...DEFAULT_DESIGN },
          },
        ],
        newBuyer: { name: "Duplicate Buyer", instagram: "BEA.TEST" },
        paymentConfirmed: true,
        paymentMethod: "cash",
        paymentReference: "",
      };
      const r = await request("/sales/checkout", "POST", body);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.matches[0].id, bea);
      body.newBuyer = {
        name: "New Buyer",
        instagram: "Buyer.New",
        note: "Buyer note",
      };
      body.requestId = randomUUID();
      await accepted("/sales/checkout", "POST", body, "owner", 201);
      assert.equal(
        (await sql("SELECT note FROM clients WHERE name='New Buyer'").first())
          .note,
        "Buyer note",
      );
      assert.ok(
        await sql(
          "SELECT client_id FROM client_instagram WHERE instagram='buyer.new'",
        ).first(),
      );
    },
  );
  await t.test(
    "bulk upload is owner-only, CSRF protected and isolated between owners",
    async () => {
      const data = config([["x", "X", "", "x@example.test", "", ""]]);
      for (const role of ["anonymous", "reception", "therapist"]) {
        const r = await request(
          "/clients/import/bulk/start",
          "POST",
          data,
          role,
        );
        assert.equal(r.status, role === "anonymous" ? 401 : 403);
      }
      assert.equal(
        (
          await request("/clients/import/bulk/start", "POST", data, "owner", {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
      const p = await accepted(
        "/clients/import/bulk/start",
        "POST",
        data,
        "owner",
        201,
      );
      assert.equal(
        (
          await request(
            `/clients/import/bulk/${p.id}/upload`,
            "POST",
            { offset: 0, rows: [["x", "X", "", "x@example.test", "", ""]] },
            "other-owner",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request("/clients/import/bulk/start", "POST", {
            ...data,
            total: 50001,
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "cross-chunk Instagram conflicts, identical rows and existing identities show useful profiles",
    async () => {
      const rows = Array.from({ length: 252 }, (_, i) => [
        "c" + i,
        "Candidate " + i,
        "",
        "c" + i + "@example.test",
        "",
        "",
      ]);
      rows[0] = [
        "same",
        "Identical",
        "",
        "identical@example.test",
        "shared.same",
        "",
      ];
      rows[250] = [...rows[0]];
      rows[1] = ["one", "First conflict", "", "", "shared.conflict", ""];
      rows[251] = ["two", "Second conflict", "", "", "SHARED.CONFLICT", ""];
      rows[2] = ["existing", "Bea Test", "0622222222", "", "Bea.Test", ""];
      const before = await count(),
        p = await start(rows);
      assert.equal(
        (
          await request(`/clients/import/bulk/${p.id}/upload`, "POST", {
            offset: 250,
            rows: rows.slice(250),
          })
        ).status,
        409,
      );
      const parts = await Promise.all([
        part(p.id, 0, rows.slice(0, 250)),
        part(p.id, 0, rows.slice(0, 250)),
      ]);
      assert.equal(parts[0].uploaded, 250);
      assert.equal((await part(p.id, 0, rows.slice(0, 250))).repeated, true);
      const changed = rows.slice(0, 250).map((r) => [...r]);
      changed[0][1] = "Changed";
      assert.equal(
        (
          await request(`/clients/import/bulk/${p.id}/upload`, "POST", {
            offset: 0,
            rows: changed,
          })
        ).status,
        409,
      );
      await part(p.id, 250, rows.slice(250));
      const ready = await finish(p.id);
      assert.equal(await count(), before);
      assert.equal(ready.counts.conflict, 2);
      assert.equal(ready.counts.duplicate, 1);
      assert.equal(ready.counts.existing, 1);
      assert.equal(ready.rows[2].matches[0].id, bea);
      assert.equal(ready.rows[2].matches[0].name, "Bea Test");
      assert.equal(ready.rows.length, 50);
      assert.equal(
        (await accepted(`/clients/import/bulk/${p.id}/page?page=5`)).rows
          .length,
        2,
      );
      assert.equal((await commit(ready, [3])).status, 400);
    },
  );
  await t.test(
    "one CSV above 1,000 rows/1 MiB uploads automatically, resumes a lost response and commits all selected rows once",
    async () => {
      const total = 12001,
        rows = Array.from({ length: total }, (_, i) => [
          "large" + i,
          "Large Client " + i,
          "",
          "large" + i + "@example.test",
          "large." + i,
          "Note " + i + " " + "n".repeat(160),
        ]);
      const csv = [columns, ...rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n");
      assert.ok(Buffer.byteLength(csv) > 1048576);
      const parsed = parseCSV(csv),
        state = {},
        before = await count();
      let interrupted = false,
        calls = 0;
      const api = async (path, { method = "GET", body } = {}) => {
        const r = await request(path, method, body);
        if (r.status >= 400) throw new Error(JSON.stringify(r.data));
        calls++;
        if (path.endsWith("/upload") && body.offset === 250 && !interrupted) {
          interrupted = true;
          throw new Error("Simulated lost upload response");
        }
        return r.data;
      };
      const options = {
        api,
        parsed,
        mapping,
        source: "fresha",
        current: () => true,
        progress: () => {},
        state,
      };
      await assert.rejects(uploadClientCSV(options), /lost upload response/);
      assert.equal(await count(), before);
      assert.equal(state.offset, 250);
      const p = await uploadClientCSV(options);
      assert.equal(p.total, total);
      assert.equal(p.readyRows.length, total);
      assert.equal(p.rows.length, 50);
      assert.equal(await count(), before);
      assert.ok(calls > 40);
      const results = await Promise.all([commit(p), commit(p)]);
      assert.deepEqual(
        results.map((r) => r.status).sort(),
        [200, 201],
        JSON.stringify(results),
      );
      assert.equal(await count(), before + total);
      assert.equal((await commit(p)).data.repeated, true);
      assert.equal((await commit(p, [2])).status, 409);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM client_bulk_rows WHERE import_id=?",
            p.id,
          ).first()
        ).n,
        0,
      );
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM client_bulk_contacts WHERE import_id=?",
            p.id,
          ).first()
        ).n,
        0,
      );
      const last = await sql(
        "SELECT c.note,g.instagram FROM clients c JOIN client_instagram g ON g.client_id=c.id WHERE email_key='large12000@example.test'",
      ).first();
      assert.match(last.note, /Note 12000/);
      assert.equal(last.instagram, "large.12000");
      const repeated = await preview(rows.slice(0, 2));
      assert.equal(repeated.counts.existing, 2);
    },
  );
  await t.test(
    "revision changes reject stale previews; failed commits roll back all rows and can be retried",
    async () => {
      const rows = [
        [
          "atomic1",
          "Atomic A",
          "",
          "atomic1@example.test",
          "atomic.one",
          "note",
        ],
        [
          "atomic2",
          "Force bulk failure",
          "",
          "atomic2@example.test",
          "atomic.two",
          "",
        ],
      ];
      const stale = await preview(rows);
      await create({ name: "Intervening client" });
      assert.equal((await commit(stale)).status, 409);
      const p = await preview(rows),
        before = await count();
      await db
        .prepare(
          "CREATE TRIGGER bulk_failure BEFORE INSERT ON clients WHEN NEW.name='Force bulk failure' BEGIN SELECT RAISE(ABORT,'test failure'); END",
        )
        .run();
      assert.equal((await commit(p)).status, 500);
      assert.equal(await count(), before);
      assert.equal(
        (
          await sql(
            "SELECT status FROM client_imports WHERE id=?",
            p.id,
          ).first()
        ).status,
        "preview",
      );
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM client_import_keys WHERE import_id=?",
            p.id,
          ).first()
        ).n,
        0,
      );
      await db.prepare("DROP TRIGGER bulk_failure").run();
      assert.equal((await commit(p)).status, 201);
      assert.equal(await count(), before + 2);
    },
  );
  await t.test(
    "exports retain Instagram/notes and can be read as one large file; Rei roundtrip preserves escaping",
    async () => {
      await create({
        name: "=Formula Test",
        phone: "+381654444444",
        instagram: "formula.test",
        note: "=literal\nSecond line",
      });
      const parsed = parseCSV(
        await (await raw("/clients/export.csv?notes=true")).text(),
      );
      assert.equal(parsed.rows.length, await count());
      assert.equal(parsed.headers[4], "Instagram");
      assert.equal(parsed.headers[5], "Notes");
      const row = parsed.rows.find((r) => r[1] === "'=Formula Test");
      assert.equal(row[4], "formula.test");
      assert.ok(row[5].startsWith("'="));
      const r = await accepted(
        "/clients/import/bulk/start",
        "POST",
        {
          headers: parsed.headers,
          mapping,
          source: "rei",
          total: 1,
          fileHash: digest(JSON.stringify(row)),
        },
        "owner",
        201,
      );
      await part(r.id, 0, [row]);
      const p = await finish(r.id);
      assert.equal(p.rows[0].status, "existing");
      assert.equal(p.rows[0].client.note, "=literal\nSecond line");
      assert.equal(p.rows[0].client.phone, "+381654444444");
    },
  );
  await t.test(
    "stored previews and client contacts survive restart; additive migrations match runtime schema",
    async () => {
      const p = await preview([
        [
          "restart",
          "Restart contact",
          "",
          "restart@example.test",
          "restart.test",
          "",
        ],
      ]);
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      assert.equal((await commit(p)).status, 201);
      assert.equal((await profile(bea)).instagram, "bea.test");
      for (const [file, schema] of [
        ["0009_client_contacts.sql", CLIENT_CONTACT_SCHEMA],
        ["0010_large_client_import.sql", CLIENT_BULK_SCHEMA],
      ]) {
        const migration = statements(
          await readFile("migrations/" + file, "utf8"),
        );
        assert.deepEqual(
          migration.map((q) => q.replace(/;$/, "")),
          schema,
        );
        for (const q of migration) await db.prepare(q).run();
      }
    },
  );
});
