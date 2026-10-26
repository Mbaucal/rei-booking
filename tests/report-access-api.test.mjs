import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { REPORT_ACCESS_SCHEMA } from "../src/report-access-schema.mjs";
import { performanceApi } from "../src/report-access.mjs";
import { loadPerformanceReport } from "../src/report-data.mjs";
import { reportOptions } from "../src/reports.mjs";

const ORIGIN = "https://report-access.example.test";
const RANGE = "from=2026-01-01&to=2026-01-31";
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
test("report access shipped migration matches additive runtime schema", async () => {
  assert.equal(
    await readFile("migrations/0018_report_access.sql", "utf8"),
    REPORT_ACCESS_SCHEMA.join(";\n\n") + ";\n",
  );
});

test("real Worker report integration: owner credentials, scoped reads, shared totals and revocation", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-report-access-"));
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
    d1Databases: { DB: "reports" },
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
  const stamp = "2026-01-01T00:00:00Z",
    week = JSON.stringify(
      Array.from({ length: 7 }, () => ({
        enabled: true,
        start: 600,
        end: 1320,
      })),
    );
  await db
    .prepare(
      "INSERT INTO therapists(id,name,weekly_json,created_at,updated_at) VALUES('t1','Fictional therapist',?,?,?)",
    )
    .bind(week, stamp, stamp)
    .run();
  const sessions = {};
  for (const [id, role, required] of [
    ["owner", "owner", 0],
    ["other", "owner", 0],
    ["reception", "reception", 0],
    ["therapist", "therapist", 0],
    ["temporary", "owner", 1],
  ]) {
    await db
      .prepare(
        "INSERT INTO users(id,email,name,password_hash,role,therapist_id,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        id + "@example.test",
        id,
        "fixture-hash",
        role,
        role === "therapist" ? "t1" : null,
        required,
        stamp,
      )
      .run();
    const raw = token(),
      csrf = token();
    await db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(digest(raw), id, csrf, Date.now() + 3600000, stamp)
      .run();
    sessions[id] = { cookie: "__Host-rei_session=" + raw, csrf };
  }
  await db
    .prepare(
      "INSERT INTO clients(id,name,email,note,created_at,updated_at) VALUES('private-client','PRIVATE CLIENT','secret@example.test','PRIVATE NOTE',?,?)",
    )
    .bind(stamp, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES('s1','Fictional massage',60,470000,?,?)",
    )
    .bind(stamp, stamp)
    .run();
  for (const [id, date, status, duration, requested] of [
    ["native-done", "2026-01-10", "done", 90, "t1"],
    ["native-regular", "2026-01-11", "done", 45, null],
    ["native-cancel", "2026-01-12", "cancelled", 60, null],
    ["native-no-show", "2026-01-13", "no_show", 60, null],
    ["native-pending", "2026-01-14", "confirmed", 60, null],
    ["native-previous", "2025-12-10", "done", 60, null],
  ]) {
    await db
      .prepare(
        "INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,note,gross_cents,net_cents,requested_therapist_id,created_at,updated_at,updated_by,mutation_id) VALUES(?,'private-client','t1','s1','Fictional massage',?,600,?,'r1',0,?,'PRIVATE APPOINTMENT NOTE',470000,420000,?,?,?,'owner',?)",
      )
      .bind(id, date, duration, status, requested, stamp, stamp, id)
      .run();
  }
  async function req(
    path,
    { who = null, method = "GET", body, bearer = null, headers = {} } = {},
  ) {
    const session = who ? sessions[who] : null;
    const r = await mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        ...(session
          ? {
              cookie: session.cookie,
              "x-csrf-token": session.csrf,
              origin: ORIGIN,
            }
          : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(bearer ? { authorization: "Bearer " + bearer } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json(), headers: r.headers };
  }
  async function issue(name = "Fictional Sheets", who = "owner", extra = {}) {
    const r = await req("/report-access/tokens", {
      who,
      method: "POST",
      body: { name, ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const api = (secret, suffix = "") =>
    req("/v1/reports/performance?" + RANGE + suffix, { bearer: secret });
  let first;
  await t.test(
    "token administration is owner/session/CSRF/origin protected and scoped to issuer",
    async () => {
      for (const who of [null, "reception", "therapist", "temporary"])
        assert.equal(
          (await req("/report-access/tokens", { who })).status,
          who ? 403 : 401,
        );
      assert.equal(
        (
          await req("/report-access/tokens", {
            who: "owner",
            method: "POST",
            body: { name: "Bad CSRF" },
            headers: { "x-csrf-token": "wrong" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req("/report-access/tokens", {
            who: "owner",
            method: "POST",
            body: { name: "Bad origin" },
            headers: { origin: "https://other.example" },
          })
        ).status,
        403,
      );
      for (const body of [
        { name: "" },
        { name: "Bad expiry", expiresInDays: 1 },
        { name: "Wrong scope", scope: "write" },
      ])
        assert.equal(
          (
            await req("/report-access/tokens", {
              who: "owner",
              method: "POST",
              body,
            })
          ).status,
          400,
        );
      first = await issue();
      assert.match(first.token, /^rei_rpt_[A-Za-z0-9_-]{43}$/);
      assert.equal(first.credential.active, true);
      assert.equal(first.credential.expiryDays, 90);
      const list = await req("/report-access/tokens", { who: "owner" });
      assert.equal(list.data.apiBase, ORIGIN + "/api");
      assert.equal(list.data.tokens.length, 1);
      assert.doesNotMatch(
        JSON.stringify(list.data),
        /token_hash|rei_rpt_|fixture-hash/,
      );
      assert.equal(
        (await req("/report-access/tokens", { who: "other" })).data.tokens
          .length,
        0,
      );
      assert.equal(
        (
          await req("/report-access/tokens/" + first.credential.id, {
            who: "other",
            method: "DELETE",
          })
        ).status,
        404,
      );
      const stored = await db
        .prepare("SELECT * FROM report_api_tokens WHERE id=?")
        .bind(first.credential.id)
        .first();
      assert.equal(stored.token_hash, digest(first.token));
      assert.doesNotMatch(JSON.stringify(stored), /rei_rpt_/);
      await req("/account-preview", {
        who: "owner",
        method: "POST",
        body: { userId: "therapist" },
      });
      assert.equal(
        (await req("/report-access/tokens", { who: "owner" })).status,
        403,
      );
      assert.equal(
        (
          await req("/report-access/tokens", {
            who: "owner",
            method: "POST",
            body: { name: "Preview" },
          })
        ).status,
        403,
      );
      await req("/account-preview", { who: "owner", method: "DELETE" });
    },
  );
  await t.test(
    "bearer grants only aggregate reporting and matches signed-in report calculations",
    async () => {
      assert.equal((await req("/v1/reports/performance?" + RANGE)).status, 401);
      assert.equal(
        (await req("/v1/reports/performance?" + RANGE, { who: "owner" }))
          .status,
        401,
      );
      assert.equal(
        (
          await req("/v1/reports/performance?" + RANGE, {
            who: "owner",
            bearer: first.token,
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await req("/v1/reports/performance?" + RANGE, {
            bearer: first.token,
            headers: { origin: "https://outside.example" },
          })
        ).status,
        403,
      );
      for (const path of [
        "/clients",
        "/catalogue",
        "/report-access/tokens",
        "/reports/appointments?" + RANGE,
      ])
        assert.equal(
          (await req(path, { bearer: first.token })).status,
          401,
          path,
        );
      assert.equal(
        (
          await req("/v1/reports/performance", {
            method: "POST",
            bearer: first.token,
            headers: { origin: ORIGIN },
          })
        ).status,
        405,
      );
      const r = await api(first.token, "&include_bonuses=true");
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(r.headers.get("access-control-allow-origin"), null);
      assert.equal(r.data.schema_version, "1");
      assert.equal(r.data.demo, false);
      assert.equal(r.data.complete, true);
      assert.equal(r.data.next_cursor, null);
      const live = (
        await req("/reports/appointments?preset=custom&" + RANGE, {
          who: "owner",
        })
      ).data;
      assert.equal(r.data.totals.revenue_cents, live.totals.revenueCents);
      assert.equal(r.data.totals.massage_minutes, live.totals.totalMinutes);
      assert.equal(r.data.totals.bonus_cents, live.totals.totalBonusCents);
      assert.equal(r.data.totals.bonus_cents, 82500);
      assert.equal(r.data.previous.revenue_cents, live.previous.revenueCents);
      assert.deepEqual(
        r.data.comparison.revenue_cents,
        live.comparison.revenueCents,
      );
      assert.deepEqual(r.data.rows[0].dimensions, { therapist: "t1" });
      assert.doesNotMatch(
        JSON.stringify(r.data),
        /PRIVATE|secret@example|private-client|native-done|clientId|appointmentId|note/,
      );
      const noBonus = (await api(first.token)).data;
      assert.equal(noBonus.totals.bonus_cents, undefined);
      assert.equal(noBonus.rows[0].bonus_cents, undefined);
      assert.equal(noBonus.previous.bonus_cents, undefined);
      assert.equal(noBonus.comparison.bonus_cents, undefined);
      assert.equal(
        (await req("/report-access/tokens", { who: "owner" })).data.tokens[0]
          .lastUsedAt !== null,
        true,
      );
    },
  );
  await t.test(
    "imported source metrics stay separate, unknown bonuses stay counted as missing and filters/groupings reconcile",
    async () => {
      await db
        .prepare(
          "INSERT INTO history_imports(id,owner_id,request_id,confirm_hash,commit_token,source,preview_id,preview_version,receipt_json,created_at) VALUES('history-import','owner','request','hash','commit','fixture','preview',1,'{}',?)",
        )
        .bind(stamp)
        .run();
      for (const [id, status, money] of [
        ["import-counted", "New", 590000],
        ["import-cancelled", "Canceled", 470000],
        ["import-missing", "Started", null],
      ]) {
        await db
          .prepare(
            "INSERT INTO history_archive_refs(source,ref_hash,reference,mode) VALUES('fixture',?,?,'appointment')",
          )
          .bind(id, "PRIVATE REF " + id)
          .run();
        const record = {
          sourceTherapistLabel: "Imported therapist",
          sourceServiceLabel: "Source treatment",
          sourceRoomLabel: "Source room",
          requestState: "unknown",
          sourceNetSalesMinor: money,
          currency: "RSD",
          interpretation: {
            money: {
              currency: "RSD",
              decimal: ".",
              grouping: ",",
              minorUnitDigits: 2,
            },
          },
          raw: {
            clientName: "PRIVATE HISTORY CLIENT",
            note: "PRIVATE HISTORY NOTE",
          },
          sourceTimeZone: "Europe/Belgrade",
        };
        await db
          .prepare(
            "INSERT INTO history_archive(id,import_id,source,ref_hash,line_key,client_id,evidence_hash,source_status,completion_state,date,start_minute,duration,record_json,imported_at) VALUES(?,'history-import','fixture',?,'','private-client',?,?,'unknown','2026-01-20',600,60,?,?)",
          )
          .bind(id, id, "evidence-" + id, status, JSON.stringify(record), stamp)
          .run();
      }
      const r = await api(first.token, "&include_bonuses=true");
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.totals.historical_treatments, 2);
      assert.equal(r.data.totals.historical_visits, 2);
      assert.equal(r.data.totals.historical_minutes, 120);
      assert.equal(r.data.totals.missing.bonus, 2);
      assert.equal(r.data.totals.missing.source_money, 1);
      assert.equal(r.data.totals.source_net_sales[0].amount_minor, 590000);
      assert.equal(r.data.totals.revenue_cents, 840000);
      assert.equal(r.data.totals.bonus_cents, 82500);
      assert.equal(
        r.data.coverage.historical_import_completeness,
        "not_verified",
      );
      assert.doesNotMatch(
        JSON.stringify(r.data),
        /PRIVATE|import-counted|private-client/,
      );
      for (const group of [
        "therapist",
        "therapist_month",
        "treatment",
        "day",
      ]) {
        const apiResult = (
          await api(first.token, "&include_bonuses=true&group_by=" + group)
        ).data;
        const live = (
          await req(
            "/reports/appointments?preset=custom&" + RANGE + "&group=" + group,
            { who: "owner" },
          )
        ).data;
        assert.equal(apiResult.rows.length, live.groups.length);
        for (const row of apiResult.rows) {
          const source = live.groups.find((v) => v.key === row.key);
          assert.equal(row.massage_minutes, source.totalMinutes);
          assert.equal(row.bonus_cents, source.totalBonusCents);
        }
      }
      const historical = (await api(first.token, "&source=history")).data;
      assert.equal(historical.totals.native_minutes, 0);
      assert.equal(historical.totals.historical_minutes, 120);
      const native = (
        await api(first.token, "&source=native&status=done&requested=yes")
      ).data;
      assert.equal(native.totals.massage_minutes, 90);
      assert.equal(native.totals.historical_rows, 0);
    },
  );
  await t.test(
    "strict date/filter validation, future comparison and no hidden pagination",
    async () => {
      await db.prepare("DELETE FROM report_api_limits").run();
      for (const query of [
        "",
        "from=2026-01-01",
        RANGE + "&from=2026-01-02",
        RANGE + "&token=secret",
        RANGE + "&group_by=invalid",
        RANGE + "&source=bad",
        RANGE + "&requested=maybe",
        RANGE + "&status=bad",
        RANGE + "&average_day_basis=bad",
        RANGE + "&include_bonuses=1",
        "from=2026-02-30&to=2026-03-01",
        "from=2025-01-01&to=2026-01-02",
        "from=2026-01-31&to=2026-01-01",
      ])
        assert.equal(
          (
            await req("/v1/reports/performance?" + query, {
              bearer: first.token,
            })
          ).status,
          400,
          query,
        );
      const future = await req(
        "/v1/reports/performance?from=2090-01-01&to=2090-01-31",
        { bearer: first.token },
      );
      assert.equal(future.status, 200);
      assert.equal(future.data.previous, null);
      assert.equal(future.data.comparison, null);
      assert.equal(future.data.complete, true);
      assert.equal(future.data.next_cursor, null);
    },
  );
  await t.test(
    "rotation has one winner, expiry and revoke deny old credentials, audit has no secret",
    async () => {
      const rotations = await Promise.all(
        [1, 2].map(() =>
          req("/report-access/tokens/" + first.credential.id + "/rotate", {
            who: "owner",
            method: "POST",
            body: {},
          }),
        ),
      );
      assert.deepEqual(rotations.map((r) => r.status).sort(), [201, 409]);
      const winner = rotations.find((r) => r.status === 201).data;
      assert.equal((await api(first.token)).status, 401);
      assert.equal((await api(winner.token)).status, 200);
      await db
        .prepare(
          "UPDATE report_api_tokens SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",
        )
        .bind(winner.credential.id)
        .run();
      assert.equal((await api(winner.token)).status, 401);
      const lasting = await issue("No expiry", "owner", {
        expiresInDays: null,
      });
      assert.equal(lasting.credential.expiresAt, null);
      assert.equal(
        (
          await req("/report-access/tokens/" + lasting.credential.id, {
            who: "owner",
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.equal((await api(lasting.token)).status, 401);
      assert.equal(
        (
          await req("/report-access/tokens/" + lasting.credential.id, {
            who: "owner",
            method: "DELETE",
          })
        ).status,
        200,
      );
      const audits = JSON.stringify(
        (
          await db
            .prepare("SELECT * FROM audit_log WHERE entity='report_api_token'")
            .all()
        ).results,
      );
      assert.doesNotMatch(audits, /rei_rpt_|token_hash|password_hash/);
      assert.match(audits, /rotate_report_access/);
      assert.match(audits, /revoke_report_access/);
    },
  );
  await t.test(
    "issuing-owner access changes permanently invalidate old credentials; maximum and request limits enforce scope",
    async () => {
      const old = await issue("Invalidated");
      await db.prepare("UPDATE users SET active=0 WHERE id='owner'").run();
      assert.equal((await api(old.token)).status, 401);
      await db.prepare("UPDATE users SET active=1 WHERE id='owner'").run();
      assert.equal((await api(old.token)).status, 401);
      const after = await issue("After reactivation");
      assert.equal((await api(after.token)).status, 200);
      await db
        .prepare("UPDATE users SET role='reception' WHERE id='owner'")
        .run();
      assert.equal((await api(after.token)).status, 401);
      await db.prepare("UPDATE users SET role='owner' WHERE id='owner'").run();
      assert.equal((await api(after.token)).status, 401);
      const passwordToken = await issue("Before password");
      await db
        .prepare(
          "UPDATE users SET password_hash='new-fictional-hash' WHERE id='owner'",
        )
        .run();
      assert.equal((await api(passwordToken.token)).status, 401);
      const current = await issue("Current");
      for (let i = 0; i < 19; i++) await issue("Credential " + i);
      assert.equal(
        (
          await req("/report-access/tokens", {
            who: "owner",
            method: "POST",
            body: { name: "Overflow" },
          })
        ).status,
        409,
      );
      await db.prepare("DELETE FROM report_api_limits").run();
      await db
        .prepare(
          "INSERT INTO report_api_limits(key,window_start,attempts) VALUES(?,?,30)",
        )
        .bind("token:" + current.credential.id, Date.now())
        .run();
      assert.equal((await api(current.token)).status, 429);
      await db.prepare("DELETE FROM report_api_limits").run();
      await db
        .prepare(
          "INSERT INTO report_api_limits(key,window_start,attempts) VALUES(?,?,120)",
        )
        .bind("ip:" + digest("192.0.2.55"), Date.now())
        .run();
      assert.equal(
        (
          await req("/v1/reports/performance?" + RANGE, {
            bearer: "not-valid",
            headers: { "cf-connecting-ip": "192.0.2.55" },
          })
        ).status,
        429,
      );
    },
  );
  await t.test(
    "in-flight revocation denies the response and inconsistent or oversized snapshots fail visibly",
    async () => {
      const issued = await issue("Other owner final", "other");
      await db.prepare("DELETE FROM report_api_limits").run();
      let intercept = "revoke";
      const wrap = (raw, sql) => ({
        raw,
        sql,
        bind(...args) {
          return wrap(raw.bind(...args), sql);
        },
        first: (...args) => raw.first(...args),
        all: (...args) => raw.all(...args),
        run: (...args) => raw.run(...args),
      });
      const guarded = {
        prepare: (sql) => wrap(db.prepare(sql), sql),
        batch: async (queries) => {
          if (
            intercept === "revision" &&
            queries.some((q) => q.sql.includes("AS generatedAt"))
          ) {
            await db
              .prepare(
                "INSERT INTO audit_log(action,entity,entity_id,created_at) VALUES('test','test','test',?)",
              )
              .bind(stamp)
              .run();
          }
          const result = await db.batch(queries.map((q) => q.raw));
          if (
            intercept === "revoke" &&
            queries.some((q) => q.sql.includes("AS generatedAt"))
          ) {
            await db
              .prepare("UPDATE report_api_tokens SET revoked_at=? WHERE id=?")
              .bind(stamp, issued.credential.id)
              .run();
          }
          // Exercise the loader's refusal to export a silently truncated D1 page.
          const oversized = queries.findIndex((q) =>
            intercept === "nativeLimit"
              ? q.sql.includes("LIMIT 20001")
              : intercept === "historyLimit" &&
                q.sql.includes("FROM history_archive_effective h"),
          );
          if (oversized >= 0)
            result[oversized].results = Array(
              intercept === "nativeLimit" ? 20001 : 50001,
            ).fill({});
          return result;
        },
      };
      await assert.rejects(
        () =>
          performanceApi(
            new Request(ORIGIN + "/api/v1/reports/performance?" + RANGE, {
              headers: { authorization: "Bearer " + issued.token },
            }),
            { DB: guarded, APP_ORIGIN: ORIGIN },
          ),
        (error) => error.status === 401,
      );
      intercept = "revision";
      await assert.rejects(
        () =>
          loadPerformanceReport(
            guarded,
            reportOptions(new URLSearchParams("preset=custom&" + RANGE)),
          ),
        (error) => error.status === 409,
      );
      for (const [mode, status] of [
        ["nativeLimit", 400],
        ["historyLimit", 422],
      ]) {
        intercept = mode;
        await assert.rejects(
          () =>
            loadPerformanceReport(
              guarded,
              reportOptions(new URLSearchParams("preset=custom&" + RANGE)),
            ),
          (error) => error.status === status,
        );
      }
    },
  );
});
