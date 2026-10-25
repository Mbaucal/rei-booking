import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { loadCalendarHistory } from "../src/calendar-history.mjs";
import { readHistorySalonContext } from "../src/history-salon.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { digest, token } from "../src/security.mjs";

function statements(input) {
  const out = [];
  let current = "";
  for (const line of input.split("\n")) {
    current += `${line}\n`;
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
const period = { from: "2026-10-04", to: "2026-10-04" };

test("Imported calendar projection uses real D1 source evidence, explicit mappings and role privacy", async (t) => {
  const origin = "https://calendar-history.example";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        "worker.mjs",
        ...(await readdir("src")).filter(
          (file) => file.endsWith(".mjs") && file !== "worker.mjs",
        ),
      ].map((file) => ({ type: "ESModule", path: resolve("src", file) })),
      modulesRoot: resolve("src"),
      compatibilityDate: "2026-09-22",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { APP_ORIGIN: origin, APP_ENV: "test", EMAIL_ENABLED: "false" },
      d1Databases: { DB: "calendar-history" },
      log: new Log(LogLevel.ERROR),
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  await db.batch(
    statements(await readFile("migrations/0001_core.sql", "utf8")).map((q) =>
      db.prepare(q),
    ),
  );
  await sql(
    "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    "owner",
    "fictional-owner@example.test",
    "Fictional Owner",
    "unused",
    "owner",
    "2026-10-25",
  ).run();

  await t.test(
    "empty initialized calendar does not manufacture resources or bookings",
    async () => {
      const result = await loadCalendarHistory(db, period, "owner");
      assert.deepEqual(result.appointments, []);
      assert.deepEqual(result.therapists, []);
      assert.equal(result.metadata.loadedRows, 0);
      for (const table of [
        "appointments",
        "booking_slots",
        "therapists",
        "services",
        "clients",
      ])
        assert.equal(
          (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n,
          0,
        );
    },
  );
  await sql(
    "INSERT INTO clients(id,name,phone,email,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "linked-client",
    "Fictional Current Client",
    "+381600001111",
    "fictional-client@example.test",
    "Private client note must never enter calendar history",
    "2026-10-25",
    "2026-10-25",
  ).run();
  for (const [id, name, active] of [
    ["mapped-therapist", "Renamed Current Therapist", 0],
    ["name-lookalike", "Original Therapist", 1],
    ["native-therapist", "Native Therapist", 1],
  ])
    await sql(
      "INSERT INTO therapists(id,name,active,weekly_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      id,
      name,
      active,
      JSON.stringify(defaultWeek()),
      "2026-10-25",
      "2026-10-25",
    ).run();
  await sql(
    "INSERT INTO services(id,name,duration,price_cents,color,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    "mapped-service",
    "Renamed Current Treatment",
    60,
    999900,
    "#123456",
    0,
    "2026-10-25",
    "2026-10-25",
  ).run();
  await db
    .prepare(
      "INSERT INTO history_imports VALUES('import','owner','request','hash','commit','fresha','preview',1,'{}','2026-10-25')",
    )
    .run();
  const insert = async (
    id,
    {
      source = "fresha",
      date = period.from,
      start = 600,
      duration = 60,
      clientId = null,
      status = "New",
      completion = "unknown",
      record = {},
    } = {},
  ) => {
    await db.batch([
      sql(
        "INSERT INTO history_archive_refs VALUES(?,?,?,'appointment')",
        source,
        id,
        id,
      ),
      sql(
        "INSERT INTO history_archive VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        "import",
        source,
        id,
        "",
        clientId,
        `evidence-${id}`,
        status,
        completion,
        date,
        start,
        duration,
        JSON.stringify({
          sourceClientLabel: "Fictional Source Client",
          sourceTherapistLabel: "Original Therapist",
          sourceServiceLabel: "Original Treatment",
          sourceRoomLabel: "Original Room",
          requestState: "unknown",
          sourceNetSalesMinor: 470000,
          phone: "+381600002222",
          email: "source-private@example.test",
          note: "Source private note",
          raw: { netSales: "4700", secret: "private raw source" },
          ...record,
        }),
        "2026-10-25",
      ),
    ]);
  };
  await insert("unlinked");
  await insert("linked", {
    start: 660,
    clientId: "linked-client",
    status: "Confirmed",
    record: { requestState: "yes" },
  });
  await insert("cancelled", { start: 720, status: "Cancelled" });
  await insert("noshow", {
    start: 780,
    status: "No Show",
    record: { requestState: "no" },
  });
  await insert("started", { start: 840, status: "Started" });
  await insert("completed", {
    start: 900,
    status: "Completed",
    completion: "completed",
  });
  await insert("other-source", { source: "other-system", start: 960 });
  await insert("unknown-labels", {
    start: 1020,
    status: null,
    record: {
      sourceClientLabel: null,
      sourceTherapistLabel: null,
      sourceServiceLabel: null,
      sourceRoomLabel: null,
      requestState: "unexpected",
    },
  });
  await insert("different-duration", { start: 1080, duration: 90 });
  await insert("other-day", { date: "2026-10-05" });

  await t.test(
    "source appointments appear on their day before catalogue or client linking; no name guessing",
    async () => {
      const result = await loadCalendarHistory(db, period, "owner");
      assert.equal(result.appointments.length, 9);
      assert.equal(result.metadata.loadedRows, 9);
      assert.equal(result.metadata.roomlessRows, 9);
      const unlinked = result.appointments.find(
        (a) => a.id === "history:unlinked",
      );
      assert.equal(unlinked.clientId, null);
      assert.equal(unlinked.clientName, "Fictional Source Client");
      assert.match(unlinked.therapistId, /^history:therapist:[a-f0-9]{64}$/);
      assert.notEqual(unlinked.therapistId, "name-lookalike");
      assert.equal(unlinked.roomId, null);
      assert.equal(unlinked.bed, null);
      assert.equal(unlinked.roomName, "Original Room");
      assert.equal(unlinked.requestState, "unknown");
      assert.equal(unlinked.color, "#a8863d");
      const other = result.appointments.find(
        (a) => a.id === "history:other-source",
      );
      assert.notEqual(other.therapistId, unlinked.therapistId);
      const tomorrow = await loadCalendarHistory(
        db,
        { from: "2026-10-05" },
        "owner",
      );
      assert.equal(tomorrow.appointments[0].therapistId, unlinked.therapistId);
      assert.deepEqual(
        tomorrow.appointments.map((a) => a.id),
        ["history:other-day"],
      );
      const unknown = result.appointments.find(
        (a) => a.id === "history:unknown-labels",
      );
      assert.equal(unknown.therapistName, "Unknown source therapist");
      assert.equal(unknown.serviceName, "Unknown source treatment");
      assert.equal(unknown.clientName, "Client name unavailable");
      assert.equal(unknown.roomName, null);
      assert.equal(unknown.requestState, "unknown");
      assert.equal(unknown.status, "unknown");
      assert.equal(unknown.sourceStatus, null);
      assert.ok(result.appointments.every((a) => a.imported && a.readOnly));
      assert.ok(
        result.therapists.every(
          (r) => r.historyOnly && !r.active && r.kind === "therapist",
        ),
      );
    },
  );

  await t.test(
    "all original statuses stay visible including cancellation and no-show",
    async () => {
      const result = await loadCalendarHistory(db, period, "owner");
      const expected = {
        unlinked: ["booked", "New"],
        linked: ["confirmed", "Confirmed"],
        cancelled: ["cancelled", "Cancelled"],
        noshow: ["no_show", "No Show"],
        started: ["unknown", "Started"],
        completed: ["done", "Completed"],
      };
      for (const [id, statuses] of Object.entries(expected)) {
        const item = result.appointments.find((a) => a.id === `history:${id}`);
        assert.deepEqual([item.status, item.sourceStatus], statuses);
      }
    },
  );

  await t.test(
    "explicit mappings restore inactive therapist columns while preserving source snapshots",
    async () => {
      await db.batch([
        db.prepare(
          "INSERT INTO history_catalogue_links VALUES('therapist','fresha','original therapist',0,'mapped-therapist','owner','2026-10-25')",
        ),
        db.prepare(
          "INSERT INTO history_catalogue_links VALUES('service','fresha','original treatment',60,'mapped-service','owner','2026-10-25')",
        ),
      ]);
      const result = await loadCalendarHistory(db, period, "owner");
      const linked = result.appointments.find((a) => a.id === "history:linked");
      assert.equal(linked.therapistId, "mapped-therapist");
      assert.equal(linked.therapistName, "Original Therapist");
      assert.equal(linked.serviceId, "mapped-service");
      assert.equal(linked.serviceName, "Original Treatment");
      assert.equal(linked.color, "#123456");
      assert.deepEqual(
        result.therapists.find((r) => r.id === "mapped-therapist"),
        {
          id: "mapped-therapist",
          name: "Renamed Current Therapist",
          kind: "therapist",
          historyOnly: true,
          active: false,
        },
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT active FROM therapists WHERE id='mapped-therapist'",
            )
            .first()
        ).active,
        0,
      );
      assert.match(
        result.appointments.find((a) => a.id === "history:different-duration")
          .serviceId,
        /^history:service:/,
      );
      assert.equal(
        result.appointments.find((a) => a.id === "history:different-duration")
          .color,
        "#a8863d",
      );
    },
  );

  await t.test(
    "server role projection omits identity and financial information before serialization",
    async () => {
      const owner = await loadCalendarHistory(db, period, "owner");
      const reception = await loadCalendarHistory(db, period, "reception");
      assert.deepEqual(reception, owner);
      assert.equal(
        owner.appointments.find((a) => a.id === "history:linked").clientName,
        "Fictional Current Client",
      );
      const therapist = await loadCalendarHistory(db, period, "therapist");
      const allowedKeys = [
        "id",
        "imported",
        "readOnly",
        "source",
        "date",
        "start",
        "duration",
        "status",
        "sourceStatus",
        "therapistId",
        "therapistName",
        "serviceId",
        "serviceName",
        "roomId",
        "bed",
        "roomName",
        "requestState",
        "color",
      ].sort();
      for (const row of therapist.appointments)
        assert.deepEqual(Object.keys(row).sort(), allowedKeys);
      assert.doesNotMatch(
        JSON.stringify(therapist),
        /Fictional (Source|Current) Client|linked-client|@example|38160000|Private|private|470000|999900/,
      );
      assert.doesNotMatch(
        JSON.stringify(owner),
        /source-private|client@example|38160000|[Pp]rivate|470000|999900|netSales|netCents|grossCents/,
      );
      assert.equal(
        therapist.appointments.find((a) => a.id === "history:linked")
          .requestState,
        "yes",
      );
      assert.equal(
        therapist.appointments.find((a) => a.id === "history:noshow")
          .requestState,
        "no",
      );
    },
  );

  await t.test(
    "authenticated Worker calendar API includes history and enforces the same role boundary",
    async () => {
      const url = `${origin}/api/appointments?from=${period.from}&to=${period.to}`;
      assert.equal((await mf.dispatchFetch(url)).status, 401);
      const bodies = {};
      for (const role of ["owner", "reception", "therapist"]) {
        const raw = token();
        if (role !== "owner")
          await sql(
            "INSERT INTO users(id,email,name,password_hash,role,therapist_id,created_at) VALUES(?,?,?,?,?,?,?)",
            role,
            `${role}@example.test`,
            `Fictional ${role}`,
            "unused",
            role,
            role === "therapist" ? "native-therapist" : null,
            "2026-10-25",
          ).run();
        await sql(
          "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
          digest(raw),
          role,
          token(),
          Date.now() + 3600000,
          "2026-10-25",
        ).run();
        const response = await mf.dispatchFetch(url, {
          headers: { cookie: `__Host-rei_session=${raw}` },
        });
        bodies[role] = await response.json();
        assert.equal(response.status, 200, JSON.stringify(bodies[role]));
        assert.deepEqual(bodies[role].appointments, []);
        assert.equal(bodies[role].history.appointments.length, 9);
        assert.deepEqual(
          bodies[role].history,
          await loadCalendarHistory(db, period, role),
        );
      }
      assert.doesNotMatch(
        JSON.stringify(bodies.therapist),
        /Fictional (Source|Current) Client|linked-client|@example|38160000|[Pp]rivate|netCents|grossCents|sourceNetSales/,
      );
      assert.equal(
        bodies.reception.history.appointments.find(
          (a) => a.id === "history:linked",
        ).clientName,
        "Fictional Current Client",
      );
    },
  );

  await t.test(
    "later reviewed client links appear without modifying archived evidence or scheduling tables",
    async () => {
      const before = (
        await db.prepare("SELECT * FROM history_archive ORDER BY id").all()
      ).results;
      await db
        .prepare(
          "INSERT INTO history_archive_client_links(archive_id,client_id,created_by,created_at) VALUES('unlinked','linked-client','owner','2026-10-25')",
        )
        .run();
      const result = await loadCalendarHistory(db, period, "owner");
      const unlinked = result.appointments.find(
        (a) => a.id === "history:unlinked",
      );
      assert.equal(unlinked.clientId, "linked-client");
      assert.equal(unlinked.clientName, "Fictional Current Client");
      assert.deepEqual(
        (await db.prepare("SELECT * FROM history_archive ORDER BY id").all())
          .results,
        before,
      );
      assert.equal(
        (await db.prepare("SELECT count(*) AS n FROM appointments").first()).n,
        0,
      );
      assert.equal(
        (await db.prepare("SELECT count(*) AS n FROM booking_slots").first()).n,
        0,
      );
      await assert.rejects(
        db
          .prepare(
            "UPDATE history_archive SET source_status='Changed' WHERE id='unlinked'",
          )
          .run(),
        /history_archive_immutable/,
      );
    },
  );

  await t.test(
    "an overlapping native booking does not erase distinct imported evidence or reserve extra slots",
    async () => {
      await sql(
        `INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,gross_cents,net_cents,created_at,updated_at,updated_by,mutation_id)
       VALUES('native','linked-client','native-therapist','mapped-service','Native treatment',?,600,60,'r1',0,'done',10000,10000,'2026-10-25','2026-10-25','owner','mutation')`,
        period.from,
      ).run();
      const before = (
        await db.prepare("SELECT * FROM booking_slots ORDER BY minute").all()
      ).results;
      const result = await loadCalendarHistory(db, period, "owner");
      assert.equal(result.appointments.length, 9);
      assert.ok(result.appointments.some((a) => a.id === "history:unlinked"));
      assert.deepEqual(
        (await db.prepare("SELECT * FROM booking_slots ORDER BY minute").all())
          .results,
        before,
      );
    },
  );

  await t.test(
    "range and roles are validated; stale concurrent catalogue snapshots reject instead of mixing versions",
    async () => {
      for (const range of [
        { from: "2026-02-30" },
        { from: "2026-10-02", to: "2026-10-01" },
        { from: "2026-10-01", to: "2026-11-01" },
      ])
        await assert.rejects(
          loadCalendarHistory(db, range, "owner"),
          (e) => e.status === 400,
        );
      await assert.rejects(
        loadCalendarHistory({}, period, "untrusted"),
        (e) => e.status === 403,
      );
      assert.equal(
        (
          await loadCalendarHistory(
            db,
            { from: "2026-10-01", to: "2026-10-31" },
            "owner",
          )
        ).appointments.length,
        10,
      );
      let changed = false;
      const raced = {
        prepare(query) {
          const statement = db.prepare(query);
          return {
            query,
            bind(...args) {
              return { query, statement: statement.bind(...args) };
            },
            statement,
          };
        },
        async batch(items) {
          if (!changed && items[0].query.startsWith("SELECT h.id")) {
            changed = true;
            await db
              .prepare(
                "UPDATE therapists SET name='Changed concurrently' WHERE id='mapped-therapist'",
              )
              .run();
          }
          return db.batch(items.map((item) => item.statement));
        },
      };
      await assert.rejects(
        loadCalendarHistory(raced, period, "owner"),
        (e) => e.status === 409,
      );
      assert.equal(changed, true);
    },
  );

  await t.test(
    "too many records produce an explicit error rather than a partial empty-looking calendar",
    async () => {
      await readHistorySalonContext(db);
      await db.batch([
        db.prepare(
          "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO history_archive_refs SELECT 'capacity',CAST(x AS TEXT),CAST(x AS TEXT),'appointment' FROM n",
        ),
        db.prepare(
          `INSERT INTO history_archive SELECT 'capacity-'||ref_hash,'import',source,ref_hash,'',NULL,'evidence',NULL,'unknown','2030-01-01',600,60,'{}','2026-10-25' FROM history_archive_refs WHERE source='capacity'`,
        ),
      ]);
      await assert.rejects(
        loadCalendarHistory(db, { from: "2030-01-01" }, "owner"),
        (e) => e.status === 422 && /5,000/.test(e.message),
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM history_archive WHERE source='capacity'",
            )
            .first()
        ).n,
        5001,
      );
    },
  );
});
