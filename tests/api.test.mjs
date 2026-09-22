import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { prepareOwnerConsole } from "../scripts/owner-console.mjs";

const ORIGIN = "https://rei-test.example";
const PASSWORD = "Fictional-test-password-2026";
function statements(sql) {
  const out = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
    const trimmed = current.trim();
    if (
      trimmed.startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    if (trimmed) out.push(trimmed);
    current = "";
  }
  assert.equal(
    current.trim(),
    "",
    "Migration contains an unterminated statement",
  );
  return out;
}
test("real Worker + D1: authenticated booking workflow, privacy and persistence", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-d1-"));
  const options = convertV4MiniflareOptions({
    modules: ["worker.mjs", "security.mjs", "domain.mjs"].map((f) => ({
      type: "ESModule",
      path: resolve("src", f),
    })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: ORIGIN, APP_ENV: "test" },
    d1Databases: { DB: "rei-integration" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("DB");
  for (const sql of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(sql).run();
  const hash = await hashPassword(PASSWORD),
    ts = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind("owner", "owner@example.test", "Test owner", hash, "owner", ts)
    .run();
  async function request(
    path,
    session = null,
    method = "GET",
    body = undefined,
    extra = {},
  ) {
    const response = await mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      headers: response.headers,
      data: await response.json(),
    };
  }
  async function login(mail) {
    const r = await request("/login", null, "POST", {
      email: mail,
      password: PASSWORD,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return {
      cookie: r.headers.get("set-cookie").split(";")[0],
      csrf: r.data.csrf,
    };
  }
  async function create(path, body, session = owner) {
    const r = await request(path, session, "POST", body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const owner = await login("owner@example.test");
  let therapistIds = [],
    serviceId,
    clientId,
    first;
  const DATE = "2030-01-08";
  const makeBooking = (extra = {}) => ({
    date: DATE,
    start: 600,
    duration: 60,
    therapistId: therapistIds[0],
    serviceId,
    roomId: "r1",
    bed: 0,
    status: "booked",
    clientId,
    requestedTherapistId: therapistIds[0],
    note: "Private booking note",
    ...extra,
  });

  await t.test("sign-in, origin and CSRF protect all mutations", async () => {
    assert.equal((await request("/catalogue")).status, 401);
    assert.equal(
      (
        await request(
          "/clients",
          owner,
          "POST",
          { name: "Denied" },
          { origin: "https://other.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/clients",
          owner,
          "POST",
          { name: "Denied" },
          { "x-csrf-token": "wrong" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/login", null, "POST", {
          email: "owner@example.test",
          password: "incorrect",
        })
      ).status,
      401,
    );
    const session = await request("/session", owner);
    assert.equal(session.data.user.role, "owner");
    assert.equal("password_hash" in session.data.user, false);
    const r = await request("/login", null, "POST", {
      email: "owner@example.test",
      password: PASSWORD,
    });
    assert.match(
      r.headers.get("set-cookie"),
      /^__Host-rei_session=.+HttpOnly; SameSite=Strict.+Secure$/,
    );
  });
  await t.test(
    "persistent entities, deduplicated contacts and version checks",
    async () => {
      for (const name of ["Test Dao", "Test Niya", "Test Sarah"])
        therapistIds.push(
          (
            await create("/therapists", {
              name,
              fullName: name + " Private",
              note: "Private HR note",
              weekly: defaultWeek(),
            })
          ).id,
        );
      serviceId = (
        await create("/services", {
          name: "Test Thai Massage",
          duration: 60,
          priceCents: 470000,
          color: "#4f8a78",
        })
      ).id;
      clientId = (
        await create("/clients", {
          name: "Test Client Private",
          phone: "060 123 4567",
          email: "person@example.test",
          note: "Private client note",
        })
      ).id;
      assert.equal(
        (
          await request("/clients", owner, "POST", {
            name: "Duplicate",
            phone: "+381601234567",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/clients", owner, "POST", {
            name: "Duplicate",
            email: "PERSON@example.test",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/clients/" + clientId, owner, "PUT", {
            name: "Test Client Private",
            phone: "060 123 4567",
            email: "person@example.test",
            note: "Private client note",
            version: 1,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request("/clients/" + clientId, owner, "PUT", {
            name: "Stale edit",
            version: 1,
          })
        ).status,
        409,
      );
      assert.equal(
        (await request("/clients/" + clientId, owner)).data.client.name,
        "Test Client Private",
      );
      assert.equal(
        (await request("/clients?q=0601234567", owner)).data.clients[0].id,
        clientId,
      );
    },
  );
  await t.test(
    "two tables work; overlapping therapists/tables and off-grid times fail",
    async () => {
      first = (await create("/appointments", makeBooking())).appointment;
      await create(
        "/appointments",
        makeBooking({ therapistId: therapistIds[1], bed: 1 }),
      );
      assert.equal(
        (
          await request(
            "/appointments",
            owner,
            "POST",
            makeBooking({ therapistId: therapistIds[2] }),
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            "/appointments",
            owner,
            "POST",
            makeBooking({ roomId: "r2", bed: 0 }),
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            "/appointments",
            owner,
            "POST",
            makeBooking({ start: 662 }),
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            "/appointments",
            owner,
            "POST",
            makeBooking({ start: 660, roomId: "r3", bed: 1 }),
          )
        ).status,
        400,
      );
      await create(
        "/appointments",
        makeBooking({ start: 660, clientId: null, requestedTherapistId: null }),
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM booking_slots WHERE appointment_id=?",
            )
            .bind(first.id)
            .first()
        ).n,
        12,
      );
    },
  );
  await t.test("parallel collision has exactly one winner", async () => {
    const replies = await Promise.all([
      request(
        "/appointments",
        owner,
        "POST",
        makeBooking({ start: 780, therapistId: therapistIds[1] }),
      ),
      request(
        "/appointments",
        owner,
        "POST",
        makeBooking({ start: 780, therapistId: therapistIds[2] }),
      ),
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [201, 409]);
  });
  await t.test(
    "failed moves roll back slots; successful moves preserve creation and request",
    async () => {
      assert.equal(
        (
          await request("/appointments/" + first.id, owner, "PUT", {
            ...first,
            start: 660,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT start_minute FROM appointments WHERE id=?")
            .bind(first.id)
            .first()
        ).start_minute,
        600,
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT min(minute) AS m FROM booking_slots WHERE appointment_id=?",
            )
            .bind(first.id)
            .first()
        ).m,
        600,
      );
      const moved = await request("/appointments/" + first.id, owner, "PUT", {
        ...first,
        start: 725,
        therapistId: therapistIds[2],
        roomId: "r2",
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      assert.equal(moved.data.appointment.createdAt, first.createdAt);
      assert.equal(
        moved.data.appointment.requestedTherapistId,
        therapistIds[0],
      );
      assert.equal(
        (
          await request("/appointments/" + first.id, owner, "PUT", {
            ...first,
            start: 900,
          })
        ).status,
        409,
      );
      first = moved.data.appointment;
    },
  );
  await t.test(
    "new client + appointment is atomic; cancellations free the table",
    async () => {
      const before = (
        await db.prepare("SELECT count(*) AS n FROM clients").first()
      ).n;
      const failed = await request(
        "/appointments",
        owner,
        "POST",
        makeBooking({
          start: 660,
          clientId: null,
          newClient: { name: "Must roll back" },
        }),
      );
      assert.equal(failed.status, 409);
      assert.equal(
        (await db.prepare("SELECT count(*) AS n FROM clients").first()).n,
        before,
      );
      const made = (
        await create(
          "/appointments",
          makeBooking({
            start: 900,
            clientId: null,
            newClient: { name: "New walk-in customer" },
          }),
        )
      ).appointment;
      assert.ok(made.clientId);
      assert.equal(made.clientName, "New walk-in customer");
      const cancelled = await request(
        "/appointments/" + made.id,
        owner,
        "PUT",
        { ...made, status: "cancelled" },
      );
      assert.equal(cancelled.status, 200);
      assert.ok(cancelled.data.appointment.cancelledAt);
      await create("/appointments", makeBooking({ start: 900 }));
    },
  );
  await t.test(
    "working hours/time off reject bookings and conflicting availability changes",
    async () => {
      const id = (
        await create("/therapists", {
          name: "Test Limited",
          weekly: defaultWeek(),
          timeOff: [DATE],
        })
      ).id;
      assert.equal(
        (
          await request(
            "/appointments",
            owner,
            "POST",
            makeBooking({ start: 1000, therapistId: id }),
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/therapists/" + therapistIds[0], owner, "PUT", {
            name: "Test Dao",
            weekly: defaultWeek(),
            timeOff: [DATE],
            version: 1,
          })
        ).status,
        409,
      );
      const week = defaultWeek();
      week.forEach((d) => (d.start = 720));
      const late = (
        await create("/therapists", { name: "Test Late", weekly: week })
      ).id;
      assert.equal(
        (
          await request(
            "/appointments",
            owner,
            "POST",
            makeBooking({ therapistId: late, roomId: "r3" }),
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "service edits do not rewrite appointment price and name snapshots",
    async () => {
      const r = await request("/services/" + serviceId, owner, "PUT", {
        name: "Changed menu",
        duration: 60,
        priceCents: 590000,
        color: "#ffaaaa",
        version: 1,
      });
      assert.equal(r.status, 200);
      const record = (
        await request("/appointments?from=" + DATE, owner)
      ).data.appointments.find((a) => a.id === first.id);
      assert.equal(record.grossCents, 470000);
      assert.equal(record.serviceName, "Test Thai Massage");
    },
  );
  let reception, therapistSession, receptionId;
  await t.test(
    "role projections omit client PII and financial data at API boundary",
    async () => {
      for (const [id, role, tid] of [
        ["reception", "reception", null],
        ["therapist", "therapist", therapistIds[0]],
      ])
        await db
          .prepare(
            "INSERT INTO users(id,email,name,password_hash,role,therapist_id,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .bind(id, id + "@example.test", "Test " + role, hash, role, tid, ts)
          .run();
      receptionId = "reception";
      reception = await login("reception@example.test");
      therapistSession = await login("therapist@example.test");
      const r = await request("/appointments?from=" + DATE, therapistSession);
      assert.ok(r.data.appointments.length >= 4);
      for (const a of r.data.appointments) {
        for (const key of [
          "clientId",
          "clientName",
          "note",
          "grossCents",
          "netCents",
          "createdAt",
        ])
          assert.equal(key in a, false, key);
      }
      assert.ok(r.data.appointments.some((a) => a.requestedTherapistId));
      assert.doesNotMatch(
        JSON.stringify(r.data),
        /Test Client Private|Private booking note|person@example/,
      );
      assert.equal((await request("/clients", therapistSession)).status, 403);
      assert.equal(
        (await request("/clients/" + clientId, therapistSession)).status,
        403,
      );
      assert.equal(
        (
          await request(
            "/appointments",
            therapistSession,
            "POST",
            makeBooking({ start: 1020 }),
          )
        ).status,
        403,
      );
      for (const session of [reception, therapistSession]) {
        const catalogue = (await request("/catalogue", session)).data;
        assert.equal("priceCents" in catalogue.services[0], false);
        assert.doesNotMatch(
          JSON.stringify(catalogue),
          /Private HR note|fullName|"email"/,
        );
        assert.equal((await request("/audit", session)).status, 403);
        assert.equal((await request("/users", session)).status, 403);
      }
      const receptionData = (
        await request("/appointments?from=" + DATE, reception)
      ).data;
      assert.ok(receptionData.appointments.some((a) => a.clientName));
      assert.equal("grossCents" in receptionData.appointments[0], false);
      await create("/appointments", makeBooking({ start: 1080 }), reception);
      assert.equal(
        (
          await request(
            "/appointments",
            reception,
            "POST",
            makeBooking({ start: 1140, grossCents: 1 }),
          )
        ).status,
        403,
      );
      assert.equal(
        (await request("/therapists", reception, "POST", { name: "Denied" }))
          .status,
        403,
      );
    },
  );
  await t.test(
    "account creation, required password change, revocation and audit",
    async () => {
      const made = await create("/users", {
        name: "New colleague",
        email: "new@example.test",
        role: "reception",
        password: PASSWORD,
      });
      const session = await login("new@example.test");
      assert.equal((await request("/catalogue", session)).status, 403);
      assert.equal(
        (
          await request("/password", session, "POST", {
            currentPassword: PASSWORD,
            newPassword: "Another-fictional-password",
          })
        ).status,
        200,
      );
      assert.equal((await request("/session", session)).status, 401);
      assert.equal(
        (
          await db
            .prepare("SELECT must_change_password FROM users WHERE id=?")
            .bind(made.id)
            .first()
        ).must_change_password,
        0,
      );
      assert.equal(
        (
          await request("/users/" + receptionId + "/active", owner, "PUT", {
            active: false,
          })
        ).status,
        200,
      );
      assert.equal((await request("/session", reception)).status, 401);
      assert.equal(
        (await request("/users/owner/active", owner, "PUT", { active: false }))
          .status,
        400,
      );
      const audit = await request("/audit", owner);
      assert.ok(
        audit.data.events.some(
          (e) => e.entity === "appointment" && e.action === "update",
        ),
      );
      assert.doesNotMatch(JSON.stringify(audit.data), /password_hash|scrypt\$/);
      const rawCookie = owner.cookie.split("=")[1];
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) AS n FROM sessions WHERE token_hash=?")
            .bind(rawCookie)
            .first()
        ).n,
        0,
      );
    },
  );
  await t.test(
    "D1 records survive Worker restart; session logout is permanent",
    async () => {
      const count = (
        await db.prepare("SELECT count(*) AS n FROM appointments").first()
      ).n;
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      const result = await request("/appointments?from=" + DATE, owner);
      assert.equal(result.status, 200);
      assert.equal(result.data.appointments.length, count);
      assert.equal((await request("/logout", owner, "POST")).status, 200);
      assert.equal((await request("/session", owner)).status, 401);
    },
  );
  await t.test(
    "offline console recovery permits sign-in and mandatory password replacement",
    async () => {
      const temporary = "Fictional-console-temporary";
      const prepared = await prepareOwnerConsole({
        email: "owner@example.test",
        name: "Test owner",
        password: temporary,
        repeat: temporary,
      });
      const applied = await db.batch(
        statements(prepared.sql).map((sql) => db.prepare(sql)),
      );
      assert.equal(applied.at(-1).results[0].result, "OWNER_READY");
      assert.equal(
        (
          await request("/login", null, "POST", {
            email: prepared.email,
            password: PASSWORD,
          })
        ).status,
        401,
      );
      const signedIn = await request("/login", null, "POST", {
        email: prepared.email,
        password: temporary,
      });
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.data.mustChangePassword, true);
      const recovered = {
        cookie: signedIn.headers.get("set-cookie").split(";")[0],
        csrf: signedIn.data.csrf,
      };
      assert.equal((await request("/catalogue", recovered)).status, 403);
      assert.equal(
        (
          await request("/password", recovered, "POST", {
            currentPassword: temporary,
            newPassword: PASSWORD,
          })
        ).status,
        200,
      );
      assert.equal((await request("/session", recovered)).status, 401);
      const fresh = await login(prepared.email);
      assert.equal((await request("/catalogue", fresh)).status, 200);
    },
  );
});
