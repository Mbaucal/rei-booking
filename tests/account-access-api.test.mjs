import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { hashPassword } from "../src/security.mjs";
import { ACCOUNT_ACCESS_SCHEMA } from "../src/account-access-schema.mjs";
const ORIGIN = "https://accounts.example.test",
  PASSWORD = "Fictional-password-2026",
  NEXT = "Fictional-password-next-2026";
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

test("account access migration matches automatic additive schema", async () => {
  assert.equal(
    await readFile("migrations/0017_account_access.sql", "utf8"),
    ACCOUNT_ACCESS_SCHEMA.join(";\n\n") + ";\n",
  );
});

test("real Worker account access: usernames, edits, revocation and owner-bound read-only previews", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-access-"));
  const names = (await readdir("src")).filter(
    (n) => n.endsWith(".mjs") && n !== "worker.mjs",
  );
  const options = convertV4MiniflareOptions({
    modules: ["worker.mjs", ...names].map((n) => ({
      type: "ESModule",
      path: resolve("src", n),
    })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: ORIGIN, APP_ENV: "test" },
    d1Databases: { DB: "access" },
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
  const hash = await hashPassword(PASSWORD),
    ts = "2026-01-01T00:00:00Z";
  await db
    .prepare(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind("owner", "Owner@Example.test", "Fictional Owner", hash, "owner", ts)
    .run();
  const week = JSON.stringify(
    Array.from({ length: 7 }, () => ({ enabled: true, start: 600, end: 1320 })),
  );
  for (const [id, active] of [
    ["t1", 1],
    ["t2", 1],
    ["inactive", 0],
  ])
    await db
      .prepare(
        "INSERT INTO therapists(id,name,active,weekly_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(id, `Therapist ${id}`, active, week, ts, ts)
      .run();
  await db
    .prepare(
      "INSERT INTO clients(id,name,phone,email,note,created_at,updated_at) VALUES('c1','SECRET CLIENT','+38160000111','private@example.test','SECRET NOTE',?,?)",
    )
    .bind(ts, ts)
    .run();
  await db
    .prepare(
      "INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES('s1','Fictional massage',60,470000,?,?)",
    )
    .bind(ts, ts)
    .run();
  await db
    .prepare(
      "INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,note,gross_cents,net_cents,requested_therapist_id,created_at,updated_at,updated_by,mutation_id) VALUES('a1','c1','t1','s1','Fictional massage','2030-01-10',600,60,'r1',0,'done','SECRET BOOKING NOTE',470000,470000,'t1',?,?,'owner','fixture')",
    )
    .bind(ts, ts)
    .run();
  async function req(path, session = null, method = "GET", body, extra = {}) {
    const r = await mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json(), headers: r.headers };
  }
  async function login(login, password = PASSWORD, field = "login") {
    const r = await req("/login", null, "POST", { [field]: login, password });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return {
      cookie: r.headers.get("set-cookie").split(";")[0],
      csrf: r.data.csrf,
      data: r.data,
    };
  }
  const owner = await login("owner@example.test", PASSWORD, "email");
  const ownerHash = (
    await db.prepare("SELECT password_hash FROM users WHERE id='owner'").first()
  ).password_hash;
  let staff, reception, staffSession, otherOwner;
  const access = async (session = owner) =>
    (await req("/therapists/t1/access", session)).data.accounts;
  async function create(loginName, role = "therapist", profile = "t1") {
    const r = await req("/users", owner, "POST", {
      login: loginName,
      name: loginName,
      role,
      therapistId: profile,
      password: PASSWORD,
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.account;
  }
  await t.test(
    "existing email owner remains valid; create username accounts without contact email and show all linked accounts",
    async () => {
      staff = await create("NAmCha");
      assert.equal(staff.login, "namcha");
      assert.equal(staff.version, 1);
      assert.equal(staff.mustChangePassword, true);
      // Applying the shipped migration after runtime initialization keeps account state.
      for (let pass = 0; pass < 2; pass++)
        await db.batch(ACCOUNT_ACCESS_SCHEMA.map((sql) => db.prepare(sql)));
      assert.equal((await access())[0].version, 1);
      assert.equal((await req("/session", owner)).status, 200);
      reception = await create("front.desk", "reception");
      assert.equal((await access()).length, 2);
      assert.equal(
        (await req("/users", owner)).data.users.find((u) => u.id === staff.id)
          .email,
        "namcha",
      );
      assert.equal(
        (await db.prepare("SELECT email FROM therapists WHERE id='t1'").first())
          .email,
        "",
      );
      assert.equal(
        (await req("/reports/monthly", owner)).data.accountEmail,
        "Owner@Example.test",
      );
      assert.equal(
        (
          await req("/users", owner, "POST", {
            login: "NAMCHA",
            name: "Duplicate",
            role: "therapist",
            therapistId: "t1",
            password: PASSWORD,
          })
        ).status,
        409,
      );
      for (const loginName of [
        "ab",
        "9name",
        "bad name",
        "a".repeat(65),
        "x@invalid",
      ])
        assert.equal(
          (
            await req("/users", owner, "POST", {
              login: loginName,
              name: "Invalid",
              role: "reception",
              password: PASSWORD,
            })
          ).status,
          400,
        );
      assert.equal(
        (
          await req("/users", owner, "POST", {
            login: "inactive.user",
            name: "Inactive",
            role: "therapist",
            therapistId: "inactive",
            password: PASSWORD,
          })
        ).status,
        400,
      );
      staffSession = await login("NAMCHA");
      assert.equal((await req("/catalogue", staffSession)).status, 403);
      assert.equal(
        (
          await req("/password", staffSession, "POST", {
            currentPassword: PASSWORD,
            newPassword: NEXT,
          })
        ).status,
        200,
      );
      assert.equal((await req("/session", staffSession)).status, 401);
      staffSession = await login("namcha", NEXT);
      staff = (await access()).find((a) => a.id === staff.id);
      assert.equal(staff.version, 2);
      assert.equal(staff.mustChangePassword, false);
    },
  );
  await t.test(
    "owner preview uses actual role projections and cannot mutate or change any password",
    async () => {
      const started = await req("/account-preview", owner, "POST", {
        userId: staff.id,
      });
      assert.equal(started.status, 200, JSON.stringify(started.data));
      assert.equal(started.data.user.id, staff.id);
      assert.equal(started.data.user.role, "therapist");
      assert.equal(started.data.preview.ownerName, "Fictional Owner");
      assert.equal(started.data.csrf, owner.csrf);
      const refreshed = await req("/session", owner);
      assert.equal(refreshed.data.preview.targetId, staff.id);
      const calendar = await req("/appointments?from=2030-01-10", owner);
      assert.equal(calendar.status, 200);
      assert.equal(calendar.data.appointments.length, 1);
      assert.equal(calendar.data.appointments[0].requestedTherapistId, "t1");
      assert.doesNotMatch(
        JSON.stringify(calendar.data),
        /SECRET|private@example|grossCents|netCents|clientId|clientName/,
      );
      for (const path of [
        "/clients",
        "/users",
        "/therapists/t1/access",
        "/reports/appointments",
        "/reports/appointments.csv",
        "/sales/settings",
        "/photos/clients/c1",
      ])
        assert.equal((await req(path, owner)).status, 403, path);
      for (const path of ["/appointments", "/clients", "/users", "/password"])
        assert.equal(
          (
            await req(path, owner, "POST", {
              currentPassword: NEXT,
              newPassword: PASSWORD,
            })
          ).status,
          403,
          path,
        );
      assert.equal(
        (await req("/account-preview", owner, "POST", { userId: reception.id }))
          .status,
        403,
      );
      assert.equal(
        (
          await req("/account-preview", owner, "DELETE", undefined, {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
      const stopped = await req("/account-preview", owner, "DELETE");
      assert.equal(stopped.status, 200);
      assert.equal(stopped.data.user.role, "owner");
      assert.equal(stopped.data.preview, null);
      assert.equal((await req("/clients", owner)).status, 200);
      assert.equal(
        (
          await req("/account-preview", staffSession, "POST", {
            userId: "owner",
          })
        ).status,
        403,
      );
      assert.equal(
        (await req("/account-preview", staffSession, "DELETE")).status,
        403,
      );
      assert.equal(
        (await req("/account-preview", owner, "POST", { userId: "owner" }))
          .status,
        400,
      );
      // Temporary-password accounts may be inspected without changing their credentials.
      assert.equal(
        (await req("/account-preview", owner, "POST", { userId: reception.id }))
          .status,
        200,
      );
      assert.equal((await req("/clients", owner)).status, 200);
      assert.equal((await req("/reports/appointments", owner)).status, 403);
      assert.equal(
        (await req("/clients", owner, "POST", { name: "Cannot write" })).status,
        403,
      );
      await req("/account-preview", owner, "DELETE");
    },
  );
  await t.test(
    "role/identifier/password changes use CAS and revoke old sessions; stale requests have no side effects",
    async () => {
      const changed = await req("/users/" + staff.id, owner, "PUT", {
        version: staff.version,
        login: "namcha.new",
        role: "reception",
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      staff = changed.data.account;
      assert.equal(staff.therapistId, "t1");
      assert.equal(staff.role, "reception");
      assert.equal((await req("/session", staffSession)).status, 401);
      assert.equal(
        (await req("/login", null, "POST", { login: "namcha", password: NEXT }))
          .status,
        401,
      );
      staffSession = await login("namcha.new", NEXT);
      assert.equal((await req("/clients", staffSession)).status, 200);
      const auditBefore = (
        await db.prepare("SELECT count(*) n FROM audit_log").first()
      ).n;
      assert.equal(
        (
          await req("/users/" + staff.id, owner, "PUT", {
            version: staff.version - 1,
            role: "owner",
          })
        ).status,
        409,
      );
      assert.equal((await req("/session", staffSession)).status, 200);
      assert.equal(
        (await db.prepare("SELECT count(*) n FROM audit_log").first()).n,
        auditBefore,
      );
      assert.equal(
        (
          await req("/users/" + staff.id, staffSession, "PUT", {
            version: staff.version,
            role: "owner",
          })
        ).status,
        403,
      );
      const reset = await req("/users/" + staff.id, owner, "PUT", {
        version: staff.version,
        password: PASSWORD,
        role: "therapist",
      });
      assert.equal(reset.status, 200);
      staff = reset.data.account;
      assert.equal(staff.mustChangePassword, true);
      assert.equal((await req("/session", staffSession)).status, 401);
      assert.equal(
        (
          await req("/login", null, "POST", {
            login: "namcha.new",
            password: NEXT,
          })
        ).status,
        401,
      );
      staffSession = await login("namcha.new");
      const off = await req("/users/" + staff.id, owner, "PUT", {
        version: staff.version,
        active: false,
      });
      assert.equal(off.status, 200);
      staff = off.data.account;
      assert.equal((await req("/session", staffSession)).status, 401);
      assert.equal(
        (
          await req("/login", null, "POST", {
            login: "namcha.new",
            password: PASSWORD,
          })
        ).status,
        401,
      );
      assert.equal(
        (await req("/account-preview", owner, "POST", { userId: staff.id }))
          .status,
        400,
      );
      assert.equal(
        (
          await req("/users/" + staff.id + "/active", owner, "PUT", {
            active: true,
          })
        ).status,
        200,
      );
      staff = (await access()).find((a) => a.id === staff.id);
      assert.equal(
        (
          await req("/users/" + staff.id, owner, "PUT", {
            version: staff.version,
            active: null,
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "unavailable preview never becomes owner when target changes; explicit exit remains available",
    async () => {
      otherOwner = await login("owner@example.test");
      assert.equal(
        (await req("/account-preview", owner, "POST", { userId: staff.id }))
          .status,
        200,
      );
      const promoted = await req("/users/" + staff.id, otherOwner, "PUT", {
        version: staff.version,
        role: "owner",
      });
      assert.equal(promoted.status, 200);
      staff = promoted.data.account;
      const unavailable = await req("/session", owner);
      assert.equal(unavailable.status, 200);
      assert.equal(unavailable.data.preview.unavailable, true);
      assert.equal(unavailable.data.user.role, "therapist");
      for (const path of [
        "/catalogue",
        "/clients",
        "/reports/appointments",
        "/users",
      ])
        assert.equal((await req(path, owner)).status, 409, path);
      assert.equal(
        (await req("/account-preview", owner, "DELETE")).data.user.role,
        "owner",
      );
      assert.equal((await req("/users", owner)).status, 200);
      staff = (
        await req("/users/" + staff.id, owner, "PUT", {
          version: staff.version,
          role: "therapist",
        })
      ).data.account;
      await req("/account-preview", owner, "POST", { userId: staff.id });
      await db.prepare("UPDATE therapists SET active=0 WHERE id='t1'").run();
      assert.equal(
        (await req("/session", owner)).data.preview.unavailable,
        true,
      );
      assert.equal((await req("/catalogue", owner)).status, 409);
      await req("/account-preview", owner, "DELETE");
      await db.prepare("UPDATE therapists SET active=1 WHERE id='t1'").run();
      await req("/account-preview", owner, "POST", { userId: staff.id });
      await req("/users/" + staff.id + "/active", otherOwner, "PUT", {
        active: false,
      });
      assert.equal(
        (await req("/session", owner)).data.preview.unavailable,
        true,
      );
      await req("/account-preview", owner, "DELETE");
    },
  );
  await t.test(
    "preview is per session, new sign-in does not inherit it, and logout removes it",
    async () => {
      await req("/account-preview", owner, "POST", { userId: reception.id });
      assert.equal((await req("/session", otherOwner)).data.preview, null);
      const fresh = await login("owner@example.test");
      assert.equal((await req("/session", fresh)).data.preview, null);
      assert.equal((await req("/logout", owner, "POST")).status, 200);
      assert.equal((await req("/session", owner)).status, 401);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) n FROM audit_log WHERE actor_id='owner' AND action='end_preview' AND json_extract(after_json,'$.reason')='logout'",
            )
            .first()
        ).n,
        1,
      );
      assert.equal(
        (await db.prepare("SELECT count(*) n FROM account_previews").first()).n,
        0,
      );
      owner.cookie = fresh.cookie;
      owner.csrf = fresh.csrf;
      assert.equal(
        (
          await db
            .prepare("SELECT password_hash FROM users WHERE id='owner'")
            .first()
        ).password_hash,
        ownerHash,
      );
      const audit = JSON.stringify(
        (await db.prepare("SELECT * FROM audit_log").all()).results,
      );
      assert.doesNotMatch(audit, /scrypt\$|password_hash|Fictional-password/);
      assert.match(audit, /start_preview/);
      assert.match(audit, /end_preview/);
    },
  );
  await t.test(
    "username owner has no invented email and concurrent owners cannot remove the last active owner",
    async () => {
      const second = await create("second.owner", "owner", null);
      const temporary = await login("second.owner");
      await req("/password", temporary, "POST", {
        currentPassword: PASSWORD,
        newPassword: NEXT,
      });
      const secondSession = await login("second.owner", NEXT);
      assert.equal(
        (await req("/reports/monthly", secondSession)).data.accountEmail,
        "",
      );
      const all = (await req("/users", owner)).data.users;
      const ownerAccount = all.find((u) => u.id === "owner"),
        secondAccount = all.find((u) => u.id === second.id);
      assert.equal(
        (
          await req("/users/owner", owner, "PUT", {
            version: ownerAccount.version,
            role: "reception",
          })
        ).status,
        400,
      );
      const results = await Promise.all([
        req("/users/" + second.id, owner, "PUT", {
          version: secondAccount.version,
          active: false,
        }),
        req("/users/owner", secondSession, "PUT", {
          version: ownerAccount.version,
          active: false,
        }),
      ]);
      assert.equal(
        results.filter((r) => r.status === 200).length,
        1,
        JSON.stringify(results),
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) n FROM users WHERE active=1 AND role='owner'",
            )
            .first()
        ).n,
        1,
      );
    },
  );
});
