import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import {
  CALENDAR_BLOCK_SCHEMA,
  ensureCalendarBlockSchema,
} from "../src/calendar-block-schema.mjs";

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

test("calendar block migration is additive, repeatable, matches automatic schema and retries failures", async () => {
  const core = await readFile("migrations/0001_core.sql", "utf8");
  const migration = await readFile(
    "migrations/0011_calendar_blocks.sql",
    "utf8",
  );
  assert.equal(migration, CALENDAR_BLOCK_SCHEMA.join(";\n\n") + ";\n");
  const a = new DatabaseSync(":memory:"),
    b = new DatabaseSync(":memory:");
  try {
    for (const db of [a, b]) db.exec(core);
    a.exec(migration);
    a.exec(migration);
    for (const sql of CALENDAR_BLOCK_SCHEMA) b.exec(sql);
    const schema = (db) =>
      db
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all();
    assert.deepEqual(schema(a), schema(b));
    assert.equal(a.prepare("SELECT count(*) n FROM rooms").get().n, 3);
  } finally {
    a.close();
    b.close();
  }
  let attempts = 0;
  const fake = {
    prepare: (sql) => sql,
    batch: async (list) => {
      assert.deepEqual(list, CALENDAR_BLOCK_SCHEMA);
      if (++attempts === 1) throw new Error("transient schema failure");
    },
  };
  await assert.rejects(
    ensureCalendarBlockSchema(fake),
    /transient schema failure/,
  );
  await Promise.all([
    ensureCalendarBlockSchema(fake),
    ensureCalendarBlockSchema(fake),
  ]);
  await ensureCalendarBlockSchema(fake);
  assert.equal(attempts, 2);
});

test("Calendar blocks Worker + D1: full-day notes, private projections and atomic resource conflicts", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-blocks-")),
    origin = "https://blocks.example";
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
    d1Databases: { DB: "calendar-blocks-test" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  let mf = new Miniflare(options),
    db = await mf.getD1Database("DB");
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  for (const query of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(query).run();
  const ts = new Date().toISOString();
  for (const id of ["t1", "t2", "t3"])
    await sql(
      "INSERT INTO therapists(id,name,weekly_json,created_at,updated_at) VALUES(?,?,?,?,?)",
      id,
      id,
      JSON.stringify(defaultWeek()),
      ts,
      ts,
    ).run();
  const sessions = {};
  for (const role of ["owner", "reception", "therapist"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,therapist_id,created_at) VALUES(?,?,?,?,?,?,?)",
      role,
      role + "@example.test",
      role,
      "unused",
      role,
      role === "therapist" ? "t1" : null,
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
    headers = {},
  ) {
    const session = sessions[role];
    const response = await mf.dispatchFetch(origin + "/api" + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(session
          ? {
              cookie: "__Host-rei_session=" + session.raw,
              "x-csrf-token": session.csrf,
            }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const expect = (result, status) => {
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  };
  const create = async (path, body, role = "owner") =>
    expect(await request(path, "POST", body, role), 201);
  const { id: serviceId } = await create("/services", {
    name: "Test treatment",
    duration: 60,
    priceCents: 600000,
    color: "#1d6040",
  });
  const block = (date, extra = {}) => ({
    date,
    start: 600,
    duration: 60,
    resourceType: "therapist",
    resourceId: "t1",
    bed: null,
    title: "Private task title",
    note: "Private staff instruction",
    blocksAvailability: true,
    ...extra,
  });
  const booking = (date, extra = {}) => ({
    date,
    start: 600,
    duration: 60,
    therapistId: "t1",
    serviceId,
    roomId: "r1",
    bed: 0,
    status: "booked",
    requestedTherapistId: "t1",
    ...extra,
  });
  const addBlock = async (date, extra = {}, role = "owner") =>
    (await create("/calendar-blocks", block(date, extra), role)).block;
  const addAppointment = async (date, extra = {}) =>
    (await create("/appointments", booking(date, extra))).appointment;
  let persisted;

  await t.test(
    "owner/reception CRUD, immutable creation, stale writes, soft deletion and transactional audit",
    async () => {
      const date = "2026-10-01";
      const made = await addBlock(date, { start: 0, duration: 5 }, "reception");
      assert.equal(made.start, 0);
      assert.equal(made.version, 1);
      assert.equal(made.note, "Private staff instruction");
      assert.equal("updatedBy" in made, false);
      const body = {
        ...block(date),
        ...made,
        start: 1435,
        title: "Updated task",
      };
      const changed = expect(
        await request("/calendar-blocks/" + made.id, "PUT", body),
        200,
      ).block;
      assert.equal(changed.version, 2);
      assert.equal(changed.createdAt, made.createdAt);
      assert.equal(changed.start, 1435);
      expect(await request("/calendar-blocks/" + made.id, "PUT", body), 409);
      expect(
        await request("/calendar-blocks/" + made.id, "DELETE", { version: 1 }),
        409,
      );
      expect(
        await request(
          "/calendar-blocks/" + made.id,
          "DELETE",
          { version: 2 },
          "reception",
        ),
        200,
      );
      expect(
        await request("/calendar-blocks/" + made.id, "DELETE", { version: 3 }),
        409,
      );
      expect(
        await request("/calendar-blocks/" + made.id, "PUT", {
          ...body,
          version: 3,
        }),
        409,
      );
      assert.deepEqual(
        expect(await request("/calendar-blocks?from=" + date), 200).blocks,
        [],
      );
      const stored = await sql(
        "SELECT * FROM calendar_blocks WHERE id=?",
        made.id,
      ).first();
      assert.ok(stored.deleted_at);
      assert.equal(stored.version, 3);
      assert.equal(stored.title, "Updated task");
      const events = (
        await sql(
          "SELECT * FROM audit_log WHERE entity='calendar_blocks' AND entity_id=? ORDER BY id",
          made.id,
        ).all()
      ).results;
      assert.deepEqual(
        events.map((e) => e.action),
        ["create", "update", "delete"],
      );
      assert.deepEqual(
        events.map((e) => e.actor_id),
        ["reception", "owner", "reception"],
      );
      assert.equal(JSON.parse(events[1].before_json).start, 0);
      assert.equal(JSON.parse(events[1].after_json).start, 1435);
      // The deleted reservation no longer occupies its final minutes.
      persisted = await addBlock(date, { start: 1435, duration: 5 });
    },
  );

  await t.test(
    "authentication, origin, CSRF, role projection and private read boundaries",
    async () => {
      const date = "2026-10-02",
        made = await addBlock(date);
      expect(
        await request(
          "/calendar-blocks?from=" + date,
          "GET",
          undefined,
          "none",
        ),
        401,
      );
      expect(
        await request("/calendar-blocks", "POST", block(date), "owner", {
          origin: "https://other.example",
        }),
        403,
      );
      expect(
        await request("/calendar-blocks", "POST", block(date), "owner", {
          "x-csrf-token": "bad",
        }),
        403,
      );
      for (const [path, method, body] of [
        ["/calendar-blocks", "POST", block(date)],
        ["/calendar-blocks/" + made.id, "PUT", made],
        ["/calendar-blocks/" + made.id, "DELETE", { version: 1 }],
      ]) {
        expect(await request(path, method, body, "therapist"), 403);
        expect(
          await request(path, method, body, "owner", { "x-csrf-token": "bad" }),
          403,
        );
      }
      for (const path of [
        "/calendar-blocks?from=" + date,
        "/appointments?from=" + date,
      ]) {
        const data = expect(
            await request(path, "GET", undefined, "therapist"),
            200,
          ),
          visible = data.blocks[0];
        assert.deepEqual(
          Object.keys(visible).sort(),
          [
            "id",
            "date",
            "start",
            "duration",
            "resourceType",
            "resourceId",
            "bed",
            "blocksAvailability",
          ].sort(),
        );
        assert.equal(visible.id, made.id);
        assert.equal(visible.blocksAvailability, true);
        assert.doesNotMatch(
          JSON.stringify(data),
          /Private|updated_by|createdAt|updatedAt|version/,
        );
        assert.equal(
          expect(await request(path, "GET", undefined, "reception"), 200)
            .blocks[0].title,
          made.title,
        );
      }
      expect(
        await request("/calendar-blocks/missing", "DELETE", { version: 1 }),
        404,
      );
      expect(await request("/calendar-blocks", "DELETE", {}), 405);
    },
  );

  await t.test(
    "strict full-day input, range boundaries, valid resources and unchanged appointment hours",
    async () => {
      const date = "2026-10-03";
      const full = await addBlock(date, {
        start: 0,
        duration: 1440,
        blocksAvailability: false,
        title: "n".repeat(120),
        note: "x".repeat(2000),
      });
      assert.equal(full.duration, 1440);
      await addBlock(date, {
        start: 1435,
        duration: 5,
        blocksAvailability: false,
      });
      for (const extra of [
        { start: -5 },
        { start: 1440 },
        { start: 601 },
        { start: "600" },
        { duration: 0 },
        { duration: 1445 },
        { duration: 6 },
        { duration: 5.5 },
        { start: 1435, duration: 10 },
        { date: "2026-02-30" },
        { resourceType: "client" },
        { resourceId: "missing" },
        { bed: 0 },
        { bed: undefined },
        { resourceType: "room", resourceId: "r3", bed: 1 },
        { blocksAvailability: undefined },
        { blocksAvailability: 1 },
        { blocksAvailability: "true" },
        { title: "" },
        { title: "t".repeat(121) },
        { note: "n".repeat(2001) },
        { note: 4 },
      ])
        expect(
          await request("/calendar-blocks", "POST", block(date, extra)),
          400,
        );
      for (const query of [
        "",
        "from=bad",
        "from=2026-10-02&to=2026-10-01",
        "from=2026-10-01&to=2026-11-01",
      ])
        expect(await request("/calendar-blocks?" + query), 400);
      expect(
        await request("/calendar-blocks?from=2026-10-01&to=2026-10-31"),
        200,
      );
      for (const extra of [
        { start: 0 },
        { start: 595 },
        { start: 1320 },
        { start: 1315, duration: 10 },
      ])
        expect(
          await request("/appointments", "POST", booking(date, extra)),
          400,
        );
    },
  );

  await t.test(
    "blocking therapist entries conflict both ways; notes overlap; adjacent intervals are allowed",
    async () => {
      const date = "2026-10-04";
      await addBlock(date);
      await addBlock(date, { blocksAvailability: false });
      await addBlock(date, { blocksAvailability: false });
      expect(
        await request("/calendar-blocks", "POST", block(date, { start: 655 })),
        409,
      );
      expect(
        await request("/appointments", "POST", booking(date, { roomId: "r2" })),
        409,
      );
      await addAppointment(date, { therapistId: "t2", bed: 1 });
      await addAppointment(date, { start: 660 });
      await addBlock(date, { start: 720 });
      expect(
        await request("/calendar-blocks", "POST", block(date, { start: 660 })),
        409,
      );
      // A therapist block and a room block do not imply the same resource.
      await addBlock(date, {
        resourceType: "room",
        resourceId: "r2",
        bed: null,
      });
      await addBlock(date, { start: 660, blocksAvailability: false });
    },
  );

  await t.test(
    "one-table and whole-room scopes preserve the other bed and enforce both directions",
    async () => {
      const date = "2026-10-05";
      await addBlock(date, { resourceType: "room", resourceId: "r1", bed: 0 });
      await addAppointment(date, { bed: 1 });
      expect(
        await request(
          "/appointments",
          "POST",
          booking(date, { therapistId: "t2", bed: 0 }),
        ),
        409,
      );
      expect(
        await request(
          "/calendar-blocks",
          "POST",
          block(date, { resourceType: "room", resourceId: "r1", bed: null }),
        ),
        409,
      );
      expect(
        await request(
          "/calendar-blocks",
          "POST",
          block(date, { resourceType: "room", resourceId: "r1", bed: 1 }),
        ),
        409,
      );
      const otherDate = "2026-10-06";
      await addBlock(otherDate, {
        resourceType: "room",
        resourceId: "r1",
        bed: null,
      });
      for (const bed of [0, 1]) {
        expect(
          await request("/appointments", "POST", booking(otherDate, { bed })),
          409,
        );
        expect(
          await request(
            "/calendar-blocks",
            "POST",
            block(otherDate, { resourceType: "room", resourceId: "r1", bed }),
          ),
          409,
        );
      }
      await addAppointment(otherDate, { roomId: "r2" });
      const emptyDate = "2026-10-07";
      await addBlock(emptyDate, {
        resourceType: "room",
        resourceId: "r1",
        bed: 0,
      });
      await addBlock(emptyDate, {
        resourceType: "room",
        resourceId: "r1",
        bed: 1,
      });
    },
  );

  await t.test(
    "failed updates and inline-client bookings roll back, retaining old reservations and audit",
    async () => {
      const date = "2026-10-08",
        a = await addAppointment(date),
        b = await addBlock(date, { start: 660 });
      const auditCount = () =>
        sql(
          "SELECT count(*) n FROM audit_log WHERE entity_id IN (?,?)",
          a.id,
          b.id,
        ).first();
      const initialAudit = (await auditCount()).n;
      expect(
        await request("/appointments/" + a.id, "PUT", {
          ...booking(date),
          version: a.version,
          start: 660,
        }),
        409,
      );
      expect(
        await request("/calendar-blocks/" + b.id, "PUT", { ...b, start: 600 }),
        409,
      );
      assert.equal((await auditCount()).n, initialAudit);
      assert.equal(
        (
          await sql(
            "SELECT start_minute FROM appointments WHERE id=?",
            a.id,
          ).first()
        ).start_minute,
        600,
      );
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM booking_slots WHERE appointment_id=?",
            a.id,
          ).first()
        ).n,
        12,
      );
      assert.equal(
        (
          await sql(
            "SELECT start_minute,version FROM calendar_blocks WHERE id=?",
            b.id,
          ).first()
        ).version,
        1,
      );
      expect(
        await request(
          "/appointments",
          "POST",
          booking(date, {
            start: 660,
            newClient: { name: "Rollback-only test client" },
          }),
        ),
        409,
      );
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM clients WHERE name='Rollback-only test client'",
          ).first()
        ).n,
        0,
      );
      const note = await addBlock(date, { blocksAvailability: false });
      expect(
        await request("/calendar-blocks/" + note.id, "PUT", {
          ...note,
          blocksAvailability: true,
        }),
        409,
      );
      assert.equal(
        (
          await sql(
            "SELECT blocks_availability FROM calendar_blocks WHERE id=?",
            note.id,
          ).first()
        ).blocks_availability,
        0,
      );
      // The database guards remain effective when writes bypass the API.
      await assert.rejects(
        sql("UPDATE appointments SET start_minute=660 WHERE id=?", a.id).run(),
        /calendar_block_conflict/,
      );
      await assert.rejects(
        sql(
          "UPDATE calendar_blocks SET start_minute=600 WHERE id=?",
          b.id,
        ).run(),
        /calendar_block_conflict/,
      );
      const moved = expect(
        await request("/calendar-blocks/" + b.id, "PUT", { ...b, start: 720 }),
        200,
      ).block;
      await addAppointment(date, { start: 660 });
      assert.equal(moved.start, 720);
    },
  );

  await t.test(
    "cancelled/no-show appointments release; reactivation conflicts; notes do not affect reports",
    async () => {
      const date = "2026-09-10";
      for (const [i, status] of ["cancelled", "no_show"].entries()) {
        const a = await addAppointment(date, { start: 600 + i * 60, status });
        await addBlock(date, { start: a.start });
        expect(
          await request("/appointments/" + a.id, "PUT", {
            ...booking(date),
            start: a.start,
            version: a.version,
          }),
          409,
        );
        expect(
          await request("/appointments/" + a.id, "PUT", {
            ...booking(date),
            start: a.start,
            version: a.version,
            status,
            note: "Still released",
          }),
          200,
        );
      }
      await addAppointment(date, { start: 720, status: "done" });
      expect(
        await request("/calendar-blocks", "POST", block(date, { start: 720 })),
        409,
      );
      const reportPath =
        "/reports/appointments?preset=custom&from=" + date + "&to=" + date;
      const before = expect(await request(reportPath), 200);
      const slots = (
        await sql(
          "SELECT count(*) n FROM booking_slots WHERE date=?",
          date,
        ).first()
      ).n;
      await addBlock(date, {
        start: 0,
        duration: 1440,
        blocksAvailability: false,
      });
      await addBlock(date, { start: 1320, duration: 120 });
      const after = expect(await request(reportPath), 200);
      assert.deepEqual(after.totals, before.totals);
      assert.deepEqual(after.details, before.details);
      assert.equal(after.totals.totalMinutes, 60);
      assert.equal(after.totals.revenueCents, 600000);
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM booking_slots WHERE date=?",
            date,
          ).first()
        ).n,
        slots,
      );
      const csvBefore = await mf.dispatchFetch(
        origin +
          "/api" +
          reportPath.replace("appointments?", "appointments.csv?"),
        { headers: { cookie: "__Host-rei_session=" + sessions.owner.raw } },
      );
      assert.doesNotMatch(
        await csvBefore.text(),
        /Private task title|Private staff instruction/,
      );
    },
  );

  await t.test(
    "full-day note reassignment preserves text, duration and creation while incrementing the version",
    async () => {
      const date = "2026-10-11",
        original = await addBlock(date, {
          start: 0,
          duration: 1440,
          blocksAvailability: false,
          title: "Whole-day follow-up",
          note: "Preserve this multiline note\nAfter resource moves.",
        });
      let current = original;
      for (const target of [
        { resourceType: "therapist", resourceId: "t2", bed: null },
        { resourceType: "room", resourceId: "r1", bed: null },
        { resourceType: "room", resourceId: "r1", bed: 1 },
        { resourceType: "room", resourceId: "r2", bed: 0 },
      ]) {
        const moved = expect(
          await request("/calendar-blocks/" + original.id, "PUT", {
            ...current,
            ...target,
          }),
          200,
        ).block;
        assert.equal(moved.version, current.version + 1);
        for (const key of [
          "id",
          "date",
          "start",
          "duration",
          "title",
          "note",
          "blocksAvailability",
          "createdAt",
        ])
          assert.equal(
            moved[key],
            original[key],
            `${key} survives reassignment`,
          );
        for (const key of ["resourceType", "resourceId", "bed"])
          assert.equal(moved[key], target[key]);
        current = moved;
      }
      assert.deepEqual(
        expect(await request("/calendar-blocks?from=" + date), 200).blocks,
        [current],
      );
      expect(
        await request("/calendar-blocks/" + original.id, "PUT", original),
        409,
      );
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM audit_log WHERE entity_id=?",
            original.id,
          ).first()
        ).n,
        5,
      );
    },
  );

  await t.test(
    "cross-resource blocking moves reject occupied scope atomically and release the old resource after success",
    async () => {
      const date = "2026-10-12";
      await addAppointment(date, { therapistId: "t2", bed: 0 });
      const original = await addBlock(date);
      expect(
        await request("/calendar-blocks/" + original.id, "PUT", {
          ...original,
          resourceType: "room",
          resourceId: "r1",
          bed: null,
        }),
        409,
      );
      assert.deepEqual(
        expect(await request("/calendar-blocks?from=" + date), 200).blocks,
        [original],
      );
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM audit_log WHERE entity_id=?",
            original.id,
          ).first()
        ).n,
        1,
      );
      const moved = expect(
        await request("/calendar-blocks/" + original.id, "PUT", {
          ...original,
          resourceType: "room",
          resourceId: "r1",
          bed: 1,
        }),
        200,
      ).block;
      assert.equal(moved.version, 2);
      assert.equal(moved.note, original.note);
      assert.equal(moved.duration, original.duration);
      await addAppointment(date, { therapistId: "t1", roomId: "r2", bed: 0 });
      expect(
        await request("/calendar-blocks/" + original.id, "PUT", {
          ...moved,
          resourceType: "therapist",
          resourceId: "t1",
          bed: null,
        }),
        409,
      );
      assert.deepEqual(
        expect(await request("/calendar-blocks?from=" + date), 200).blocks,
        [moved],
      );
    },
  );

  await t.test(
    "concurrent block/block and block/appointment writes have exactly one winner",
    async () => {
      const date = "2026-10-09";
      const blocks = await Promise.all(
        Array.from({ length: 5 }, () =>
          request("/calendar-blocks", "POST", block(date)),
        ),
      );
      assert.deepEqual(
        blocks.map((r) => r.status).sort(),
        [201, 409, 409, 409, 409],
      );
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM calendar_blocks WHERE date=?",
            date,
          ).first()
        ).n,
        1,
      );
      for (let i = 0; i < 4; i++) {
        const start = 660 + i * 60;
        const results = await Promise.all([
          request(
            "/calendar-blocks",
            "POST",
            block(date, {
              start,
              resourceType: i % 2 ? "room" : "therapist",
              resourceId: i % 2 ? "r1" : "t1",
              bed: i % 2 ? 0 : null,
            }),
          ),
          request("/appointments", "POST", booking(date, { start })),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        const blockCount = (
          await sql(
            "SELECT count(*) n FROM calendar_blocks WHERE date=? AND start_minute=?",
            date,
            start,
          ).first()
        ).n;
        const appointmentCount = (
          await sql(
            "SELECT count(*) n FROM appointments WHERE date=? AND start_minute=?",
            date,
            start,
          ).first()
        ).n;
        assert.equal(blockCount + appointmentCount, 1);
      }
      const old = await addBlock(date, { start: 1080 });
      const writes = await Promise.all([
        request("/calendar-blocks/" + old.id, "PUT", {
          ...old,
          title: "Changed once",
        }),
        request("/calendar-blocks/" + old.id, "DELETE", {
          version: old.version,
        }),
      ]);
      assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (
          await sql(
            "SELECT count(*) n FROM audit_log WHERE entity='calendar_blocks' AND entity_id=?",
            old.id,
          ).first()
        ).n,
        2,
      );
    },
  );

  await t.test(
    "weekly availability remains in force; full-day blocks may be outside staff hours",
    async () => {
      const date = "2026-10-10",
        week = defaultWeek().map((d) => ({ ...d, enabled: false }));
      await sql(
        "UPDATE therapists SET weekly_json=? WHERE id='t3'",
        JSON.stringify(week),
      ).run();
      await addBlock(date, { start: 0, duration: 300, resourceId: "t3" });
      expect(
        await request(
          "/appointments",
          "POST",
          booking(date, { therapistId: "t3" }),
        ),
        409,
      );
    },
  );

  await t.test(
    "restarts and later migrations preserve records and guards; combined range excludes deleted entries",
    async () => {
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      for (const query of statements(
        await readFile("migrations/0011_calendar_blocks.sql", "utf8"),
      ))
        await db.prepare(query).run();
      const result = expect(
        await request("/appointments?from=" + persisted.date),
        200,
      );
      assert.deepEqual(result.blocks, [persisted]);
      assert.deepEqual(result.appointments, []);
      expect(
        await request(
          "/calendar-blocks",
          "POST",
          block(persisted.date, { start: 1435, duration: 5 }),
        ),
        409,
      );
      assert.deepEqual(
        expect(await request("/calendar-blocks?from=2026-11-01"), 200).blocks,
        [],
      );
    },
  );
});
