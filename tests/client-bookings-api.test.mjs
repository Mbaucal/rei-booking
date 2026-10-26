import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/security.mjs";

const ORIGIN = "https://client-bookings.example.test";
const PASSWORD = "Fictional-client-bookings-2026";
function statements(sql) {
  const result = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
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

test("client native booking pages retain lifetime counts beyond 500 rows and enforce roles", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-client-bookings-"));
  const files = (await readdir("src")).filter(
    (f) => f.endsWith(".mjs") && f !== "worker.mjs",
  );
  const options = convertV4MiniflareOptions({
    modules: ["worker.mjs", ...files].map((f) => ({
      type: "ESModule",
      path: resolve("src", f),
    })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: ORIGIN, APP_ENV: "test" },
    d1Databases: { DB: "rei-client-bookings" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  const mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  const db = await mf.getD1Database("DB");
  for (const sql of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(sql).run();
  const ts = "2026-01-01T00:00:00.000Z",
    hash = await hashPassword(PASSWORD);
  await db
    .prepare(
      "INSERT INTO therapists(id,name,weekly_json,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .bind(
      "t1",
      "Fictional therapist",
      JSON.stringify(
        Array.from({ length: 7 }, () => ({
          enabled: true,
          start: 600,
          end: 1320,
        })),
      ),
      ts,
      ts,
    )
    .run();
  for (const role of ["owner", "reception", "therapist"])
    await db
      .prepare(
        "INSERT INTO users(id,email,name,password_hash,role,therapist_id,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        role,
        `${role}@example.test`,
        role,
        hash,
        role,
        role === "therapist" ? "t1" : null,
        ts,
      )
      .run();
  for (const id of ["client-a", "client-b", "client-empty"])
    await db
      .prepare(
        "INSERT INTO clients(id,name,created_at,updated_at) VALUES(?,?,?,?)",
      )
      .bind(id, `Fictional ${id}`, ts, ts)
      .run();
  await db
    .prepare(
      "INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .bind("s1", "Fictional treatment", 60, 500000, ts, ts)
    .run();
  const booking = (id, client, date, status = "done") =>
    db
      .prepare(
        `INSERT INTO appointments(
      id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,
      room_id,bed,status,gross_cents,net_cents,created_at,updated_at,updated_by,mutation_id
    ) VALUES(?,?,'t1','s1','Fictional treatment',?,600,60,'r1',0,?,500000,450000,?,?,'owner',?)`,
      )
      .bind(id, client, date, status, ts, ts, id);
  const fixtures = Array.from({ length: 501 }, (_, i) => ({
    id: `done-${String(i).padStart(4, "0")}`,
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    status: "done",
  }));
  fixtures.push(
    { id: "cancel-a", date: "2018-01-01", status: "cancelled" },
    { id: "cancel-z", date: "2018-01-01", status: "cancelled" },
    { id: "missed", date: "2018-01-02", status: "no_show" },
    { id: "upcoming", date: "2030-01-01", status: "booked" },
    { id: "confirmed", date: "2030-01-02", status: "confirmed" },
  );
  for (let offset = 0; offset < fixtures.length; offset += 50)
    await db.batch(
      fixtures
        .slice(offset, offset + 50)
        .map((a) => booking(a.id, "client-a", a.date, a.status)),
    );
  await db.batch([
    booking("other-client", "client-b", "2017-01-01"),
    booking("walk-in", null, "2017-01-02"),
  ]);
  async function request(path, cookie, body) {
    const response = await mf.dispatchFetch(ORIGIN + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      data: await response.json(),
      headers: response.headers,
    };
  }
  async function login(role) {
    const result = await request("/login", null, {
      email: `${role}@example.test`,
      password: PASSWORD,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.headers.get("set-cookie").split(";")[0];
  }
  const owner = await login("owner"),
    reception = await login("reception"),
    therapist = await login("therapist");
  const summary = { total: 506, completed: 501, cancelled: 2, noShow: 1 };

  const first = await request("/clients/client-a", owner);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.appointmentSummary, summary);
  assert.deepEqual(first.data.appointmentPagination, {
    page: 0,
    pageSize: 50,
    totalPages: 11,
  });
  assert.equal(first.data.appointments.length, 50);
  assert.equal(
    first.data.appointments.filter((a) => a.status === "cancelled").length,
    0,
  );
  assert.equal(first.data.appointments[0].grossCents, 500000);
  const seen = [];
  for (let page = 0; page < 11; page++) {
    const result =
      page === 0
        ? first
        : await request(`/clients/client-a?appointments_page=${page}`, owner);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(result.data.appointmentSummary, summary);
    assert.equal(result.data.appointmentPagination.page, page);
    assert.equal(result.data.appointments.length, page === 10 ? 6 : 50);
    seen.push(...result.data.appointments.map((a) => a.id));
  }
  const expected = fixtures.toSorted(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
  assert.deepEqual(
    seen,
    expected.map((a) => a.id),
  );
  assert.equal(new Set(seen).size, 506);
  assert.deepEqual(
    seen.slice(-2),
    ["cancel-z", "cancel-a"],
    "ties have stable ID ordering",
  );

  const operational = await request(
    "/clients/client-a?appointments_page=10",
    reception,
  );
  assert.equal(operational.status, 200);
  assert.deepEqual(operational.data.appointmentSummary, summary);
  assert.equal(operational.data.appointments.length, 6);
  for (const row of operational.data.appointments) {
    assert.equal(row.clientId, "client-a");
    assert.ok(!("grossCents" in row));
    assert.ok(!("netCents" in row));
    assert.ok(!Object.keys(row).some((key) => /bonus/i.test(key)));
  }
  assert.equal((await request("/clients/client-a", therapist)).status, 403);
  assert.equal((await request("/clients/client-a")).status, 401);
  assert.equal((await request("/clients/missing", owner)).status, 404);
  for (const query of [
    "",
    "-1",
    "1.5",
    "1e2",
    "abc",
    "10000000",
    "11",
    "0&appointments_page=1",
  ])
    assert.equal(
      (await request(`/clients/client-a?appointments_page=${query}`, owner))
        .status,
      400,
      query,
    );

  const empty = await request("/clients/client-empty", owner);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.appointmentSummary, {
    total: 0,
    completed: 0,
    cancelled: 0,
    noShow: 0,
  });
  assert.deepEqual(empty.data.appointmentPagination, {
    page: 0,
    pageSize: 50,
    totalPages: 1,
  });
  assert.deepEqual(empty.data.appointments, []);
  assert.deepEqual(
    (await request("/clients/client-b", owner)).data.appointmentSummary,
    { total: 1, completed: 1, cancelled: 0, noShow: 0 },
  );
  await booking("new-old-booking", "client-a", "2016-01-01").run();
  const updated = await request(
    "/clients/client-a?appointments_page=10",
    owner,
  );
  assert.deepEqual(updated.data.appointmentSummary, {
    ...summary,
    total: 507,
    completed: 502,
  });
  assert.equal(updated.data.appointments.at(-1).id, "new-old-booking");
});
