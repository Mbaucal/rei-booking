import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";
import { currentMonth, shiftMonth } from "../src/monthly-periods.mjs";
import {
  resolveHistoryNetSales,
  historySalonLabelKey,
  readHistorySalonContext,
} from "../src/history-salon.mjs";
import { HISTORY_SALON_SCHEMA } from "../src/history-salon-schema.mjs";
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

test("salon automatic schema matches the additive migration", async () => {
  assert.equal(
    await readFile("migrations/0015_history_salon.sql", "utf8"),
    HISTORY_SALON_SCHEMA.join(";\n\n") + ";\n",
  );
});

test("Historical salon setup Worker + D1: owner review, catalogue mapping and immutable source evidence", async (t) => {
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
  const settings = {
    currency: "RSD",
    minorUnitDigits: 2,
    timeZone: "Europe/Belgrade",
  };
  const setupPath =
    "/history/salon/preview?currency=RSD&minorUnitDigits=2&timeZone=Europe%2FBelgrade";
  const setup = () => expect(setupPath, "GET");
  const candidatesFor = (p) => [...p.therapists, ...p.services];
  const skip = (p) =>
    candidatesFor(p).map((c) => ({ key: c.key, action: "skip" }));
  const bodyFor = (p, choices = skip(p), requestId = randomUUID()) => ({
    previewId: p.previewId,
    token: p.token,
    fingerprint: p.fingerprint,
    requestId,
    acknowledgeReview: true,
    settings,
    choices,
  });
  const apply = (body, status = 201, role = "owner") =>
    expect("/history/salon/apply", "POST", body, status, role);
  const archive = async (rows, extra = {}) => {
    const p = await preview(rows, extra);
    for (let i = 0; i < rows.length; i += 50)
      await confirm(
        await review(
          p,
          rows.slice(i, i + 50).map((_, n) => i + n + 2),
        ),
      );
    return p;
  };
  await t.test(
    "fresh schemas and owner/session/CSRF/origin gates protect preview and apply",
    async () => {
      for (const role of [
        "anonymous",
        "reception",
        "therapist",
        "password-owner",
      ]) {
        await expect(
          "/history/salon/preview",
          "GET",
          undefined,
          role === "anonymous" ? 401 : 403,
          role,
        );
        await expect(
          "/history/salon/apply",
          "POST",
          {},
          role === "anonymous" ? 401 : 403,
          role,
        );
      }
      const p = await setup();
      assert.equal(p.summary.rows, 0);
      assert.equal(p.settingsConfirmed, false);
      await expect("/history/salon/apply", "POST", bodyFor(p), 403, "owner", {
        "x-csrf-token": "bad",
      });
      await expect("/history/salon/apply", "POST", bodyFor(p), 403, "owner", {
        origin: "https://other.example",
      });
      await apply(bodyFor(p), 404, "other-owner");
    },
  );
  await t.test(
    "complete archive summary proposes normalized matches and draft historical net without persisting currency",
    async () => {
      await archive([
        row("salon-a", "New", {
          6: "Source treatment",
          7: "Source team",
          12: "4700",
        }),
        row("salon-b", "New", {
          6: "ＳＯＵＲＣＥ  TREATMENT",
          7: " source TEAM ",
          12: "5900",
          2: "28 Jan 2026, 10:00am",
        }),
        row("salon-match", "New", {
          6: "Current treatment",
          7: "Synthetic team",
          12: "6200",
        }),
        row("salon-duration", "New", {
          6: "Source treatment",
          7: "Source team",
          4: "1h 30min",
          3: "10:00:00-11:30:00",
          12: "7100",
        }),
      ]);
      const plain = await expect("/history/salon/preview", "GET");
      assert.equal(plain.settings.currency, null);
      assert.equal(
        plain.services.find(
          (c) => c.labelKey === "source treatment" && c.duration === 60,
        ).latestNet.amountMinor,
        null,
      );
      const p = await setup();
      assert.equal(p.summary.rows, 4);
      assert.equal(p.summary.from, "2026-01-27");
      assert.equal(p.summary.to, "2026-01-28");
      assert.equal(p.therapists.length, 2);
      assert.equal(p.services.length, 3);
      const c = p.services.find(
        (c) => c.labelKey === "source treatment" && c.duration === 60,
      );
      assert.equal(c.count, 2);
      assert.equal(c.latestNet.amountMinor, 590000);
      assert.equal(c.latestNet.basis, "draft-assumption");
      assert.equal(c.latestNet.raw, "5900");
      assert.equal(
        p.services.find((c) => c.label === "Current treatment").match.id,
        "service",
      );
      assert.equal(
        p.therapists.find((c) => c.label === "Synthetic team").match.id,
        "therapist",
      );
      const ctx = await readHistorySalonContext(db);
      assert.equal(ctx.settings.currency, null);
      assert.equal(ctx.links.length, 0);
      assert.equal(JSON.stringify(p).includes("Synthetic One"), false);
    },
  );
  let acceptedBody, acceptedResult;
  await t.test(
    "explicit prices create one inactive therapist and treatment variants; links/current records/source history stay safe",
    async () => {
      const p = await setup(),
        original = await sql(
          "SELECT * FROM services WHERE id='service'",
        ).first();
      const archived = (
        await sql(
          "SELECT id,record_json FROM history_archive ORDER BY id",
        ).all()
      ).results;
      const beforeUsers = await count("users"),
        beforeClients = await count("clients"),
        beforeAppointments = await count("appointments");
      const choices = candidatesFor(p).map((c) =>
        c.match
          ? { key: c.key, action: "link", entityId: c.match.id }
          : c.kind === "therapist"
            ? { key: c.key, action: "create", name: "Legacy Therapist" }
            : {
                key: c.key,
                action: "create",
                name: "Legacy Treatment",
                duration: c.duration,
                priceMinor: c.duration === 60 ? 600000 : 750000,
                active: c.duration === 60,
              },
      );
      acceptedBody = bodyFor(p, choices);
      acceptedResult = await apply(acceptedBody);
      assert.equal(acceptedResult.createdTherapists, 1);
      assert.equal(acceptedResult.createdServices, 2);
      assert.equal(acceptedResult.linked, 5);
      const team = await sql(
        "SELECT * FROM therapists WHERE name='Legacy Therapist'",
      ).first();
      assert.equal(team.active, 0);
      assert.ok(
        JSON.parse(team.weekly_json).every((day) => day.enabled === false),
      );
      const service = (
        await sql(
          "SELECT * FROM services WHERE name='Legacy Treatment' ORDER BY duration",
        ).all()
      ).results;
      assert.deepEqual(
        service.map((s) => [s.duration, s.price_cents, s.active]),
        [
          [60, 600000, 1],
          [90, 750000, 0],
        ],
      );
      assert.deepEqual(
        await sql("SELECT * FROM services WHERE id='service'").first(),
        original,
      );
      assert.deepEqual(
        (
          await sql(
            "SELECT id,record_json FROM history_archive ORDER BY id",
          ).all()
        ).results,
        archived,
      );
      assert.equal(await count("users"), beforeUsers);
      assert.equal(await count("clients"), beforeClients);
      assert.equal(await count("appointments"), beforeAppointments);
      const ctx = await readHistorySalonContext(db);
      assert.equal(ctx.settings.currency, "RSD");
      assert.equal(ctx.settings.timeZone, "Europe/Belgrade");
      assert.equal(ctx.links.length, 5);
      assert.ok(
        ctx.links.every((l) =>
          l.kind === "therapist"
            ? l.duration === 0
            : [60, 90].includes(l.duration),
        ),
      );
      const audit = await sql(
        "SELECT after_json FROM audit_log WHERE action='history_salon_setup' AND entity_id=?",
        acceptedResult.setupId,
      ).first();
      assert.equal(JSON.parse(audit.after_json).createdServices, 2);
    },
  );
  await t.test(
    "owner reports and saved monthly history reconcile mapped catalogue, source money and CSV without rewriting evidence",
    async () => {
      const period = shiftMonth(currentMonth(), -1),
        monthName = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ][Number(period.slice(5)) - 1];
      await archive([
        row("monthly-history-fixture", "New", {
          2: `05 ${monthName} ${period.slice(0, 4)}, 10:00am`,
        }),
      ]);
      const before = (
        await sql(
          "SELECT id,record_json FROM history_archive ORDER BY id",
        ).all()
      ).results;
      const reportPath =
        "/reports/appointments?preset=custom&from=2026-01-01&to=2026-01-31&source=history&group=therapist";
      const report = await expect(reportPath, "GET");
      assert.equal(report.totals.historicalRows, 4);
      assert.equal(report.totals.historicalVisits, 4);
      assert.equal(report.totals.totalMinutes, 270);
      assert.equal(report.totals.revenueCents, 0);
      assert.deepEqual(report.totals.sourceNetSales, [
        { currency: "RSD", minorUnitDigits: 2, amountMinor: 2390000, rows: 4 },
      ]);
      assert.ok(
        report.filters.therapists.some((t) => t.name === "Legacy Therapist"),
      );
      assert.ok(
        report.filters.services.some((t) => t.name === "Legacy Treatment"),
      );
      assert.ok(
        report.details.every(
          (r) => r.sourceStatus === "New" && r.rowSource === "history",
        ),
      );
      const csvResponse = await mf.dispatchFetch(
        origin +
          "/api" +
          reportPath.replace("/appointments?", "/appointments.csv?") +
          "&view=details",
        { headers: { cookie: "__Host-rei_session=" + sessions.owner.raw } },
      );
      assert.equal(csvResponse.status, 200);
      const csv = await csvResponse.text();
      assert.match(csv, /New/);
      assert.match(csv, /history/);
      assert.doesNotMatch(csv, /Synthetic One/);
      const schedule = await expect(
        "/reports/monthly",
        "POST",
        {
          name: "Synthetic historical monthly report",
          minute: 540,
          filters: {
            group: "therapist",
            status: "all",
            requested: "all",
            dayBasis: "active",
            bonuses: false,
            source: "history",
          },
          notifications: false,
          paused: false,
        },
        201,
      );
      const generated = await expect(
        "/reports/monthly/" + schedule.id + "/generate",
        "POST",
        { period },
      );
      const snapshot = await expect("/reports/archive/" + generated.id, "GET");
      assert.equal(snapshot.report.totals.historicalVisits, 1);
      assert.deepEqual(snapshot.report.totals.sourceNetSales, [
        { currency: "RSD", minorUnitDigits: 2, amountMinor: 470000, rows: 1 },
      ]);
      assert.equal(snapshot.report.history.loadedRows, 1);
      for (const role of ["reception", "therapist"]) {
        await expect(reportPath, "GET", undefined, 403, role);
        await expect(
          "/reports/archive/" + generated.id,
          "GET",
          undefined,
          403,
          role,
        );
      }
      assert.deepEqual(
        (
          await sql(
            "SELECT id,record_json FROM history_archive ORDER BY id",
          ).all()
        ).results,
        before,
      );
    },
  );
  await t.test(
    "receipt replay survives preview deletion/restart; changed payload and cross-owner replay never duplicate",
    async () => {
      await sql("DELETE FROM history_salon_previews").run();
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      const replay = await apply(acceptedBody, 200);
      assert.equal(replay.setupId, acceptedResult.setupId);
      assert.equal(replay.repeated, true);
      await apply(
        { ...acceptedBody, choices: [...acceptedBody.choices].reverse() },
        409,
      );
      await apply(acceptedBody, 404, "other-owner");
      const p = await setup();
      assert.ok(candidatesFor(p).every((c) => c.existingLink));
      const result = await apply(
        bodyFor(
          p,
          candidatesFor(p).map((c) => ({
            key: c.key,
            action: "link",
            entityId: c.existingLink,
          })),
        ),
      );
      assert.equal(result.createdServices, 0);
      assert.equal(result.createdTherapists, 0);
    },
  );
  await t.test(
    "current catalogue or new archive rows invalidate prior review; all-skipped choices can save settings",
    async () => {
      let p = await setup();
      await sql(
        "UPDATE services SET price_cents=price_cents+100,version=version+1 WHERE id='service'",
      ).run();
      await apply(bodyFor(p), 409);
      p = await setup();
      await archive([row("new-after-review")]);
      await apply(bodyFor(p), 409);
      p = await setup();
      const result = await apply(bodyFor(p));
      assert.equal(result.skipped, candidatesFor(p).length);
      assert.equal(result.settings.currency, "RSD");
      const other = await setup();
      await sql(
        "UPDATE history_salon_previews SET expires_at=0 WHERE id=?",
        other.previewId,
      ).run();
      await apply(bodyFor(other), 410);
    },
  );
  await t.test(
    "ambiguous catalogue names are explicit; missing/zero prices and invalid durations require correction or skip",
    async () => {
      await sql(
        "INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES('duplicate','Current treatment',60,12300,?,?)",
        ts,
        ts,
      ).run();
      await archive([
        row("invalid-menu-duration", "New", {
          4: "17min",
          3: "10:00:00-10:17:00",
          6: "Off grid treatment",
          7: "Source team",
          12: "0",
        }),
      ]);
      let p = await setup();
      const ambiguous = p.services.find((c) => c.label === "Current treatment");
      assert.equal(ambiguous.match, null);
      assert.equal(ambiguous.matchCandidates.length, 2);
      const off = p.services.find((c) => c.label === "Off grid treatment");
      assert.ok(off.issues.some((i) => i.code === "duration_correction"));
      assert.equal(off.latestNet.amountMinor, 0);
      const choice = {
        key: off.key,
        action: "create",
        name: "Corrected treatment",
        duration: 20,
        priceMinor: 0,
        active: true,
      };
      await apply(
        bodyFor(
          p,
          skip(p).map((c) => (c.key === off.key ? choice : c)),
        ),
        400,
      );
      await apply(
        bodyFor(
          p,
          skip(p).map((c) =>
            c.key === off.key
              ? { ...choice, priceMinor: 50000, duration: 17 }
              : c,
          ),
        ),
        400,
      );
      await apply(
        bodyFor(
          p,
          skip(p).map((c) =>
            c.key === off.key
              ? { ...choice, priceMinor: 50000, active: undefined }
              : c,
          ),
        ),
        400,
      );
      const result = await apply(
        bodyFor(
          p,
          skip(p).map((c) =>
            c.key === off.key ? { ...choice, priceMinor: 50000 } : c,
          ),
        ),
      );
      assert.equal(result.createdServices, 1);
      const link = await sql(
        "SELECT duration FROM history_catalogue_links WHERE label_key='off grid treatment'",
      ).first();
      assert.equal(link.duration, 17);
      p = await setup();
      const mapped = p.services.find((c) => c.label === "Off grid treatment");
      await apply(
        bodyFor(
          p,
          skip(p).map((c) =>
            c.key === mapped.key
              ? { key: c.key, action: "link", entityId: "service" }
              : c,
          ),
        ),
        409,
      );
    },
  );
  await t.test(
    "same new catalogue label across sources creates once; concurrent applies and rollback are atomic",
    async () => {
      await archive(
        [
          row("other-source-new", "New", {
            6: "Shared New",
            7: "Shared Therapist",
          }),
        ],
        { source: "other" },
      );
      await archive([
        row("fresha-source-new", "New", {
          6: "Shared New",
          7: "Shared Therapist",
        }),
      ]);
      let p = await setup();
      const make = (c) =>
        c.label === "Shared New"
          ? {
              key: c.key,
              action: "create",
              name: "Shared New",
              duration: 60,
              priceMinor: 510000,
              active: true,
            }
          : c.label === "Shared Therapist"
            ? { key: c.key, action: "create", name: "Shared Therapist" }
            : { key: c.key, action: "skip" };
      const body = bodyFor(p, candidatesFor(p).map(make));
      await sql(
        "CREATE TRIGGER synthetic_salon_fail BEFORE INSERT ON services WHEN NEW.name='Shared New' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END",
      ).run();
      const prior = {
        team: await count("therapists"),
        services: await count("services"),
        links: await count("history_catalogue_links"),
        receipts: await count("history_salon_receipts"),
      };
      await apply(body, 500);
      assert.deepEqual(
        {
          team: await count("therapists"),
          services: await count("services"),
          links: await count("history_catalogue_links"),
          receipts: await count("history_salon_receipts"),
        },
        prior,
      );
      await sql("DROP TRIGGER synthetic_salon_fail").run();
      const responses = await Promise.all([
        request("/history/salon/apply", "POST", body),
        request("/history/salon/apply", "POST", body),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
      assert.equal(responses[0].data.setupId, responses[1].data.setupId);
      assert.equal(responses[0].data.createdServices, 1);
      assert.equal(responses[0].data.createdTherapists, 1);
      p = await setup();
      const a = bodyFor(p),
        b = bodyFor(p);
      const competing = await Promise.all([
        request("/history/salon/apply", "POST", a),
        request("/history/salon/apply", "POST", b),
      ]);
      assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
    },
  );
  await t.test(
    "candidate and review byte limits reject explicitly without silently dropping source labels",
    async () => {
      const p = await preview(
        Array.from({ length: 501 }, (_, i) =>
          row("group-" + i, "New", { 6: "Service " + i, 7: "Team " + i }),
        ),
      );
      for (let i = 0; i < 501; i += 50)
        await confirm(
          await review(
            p,
            Array.from({ length: Math.min(50, 501 - i) }, (_, n) => i + n + 2),
          ),
        );
      const r = await request(setupPath);
      assert.equal(r.status, 422);
      assert.match(r.data.error, /1,000/);
    },
  );
});

test("confirmed historical money uses original format and never relabels known currency or invents amounts", () => {
  const settings = {
    currency: "RSD",
    minorUnitDigits: 2,
    timeZone: "Europe/Belgrade",
  };
  const record = {
    raw: { netSales: "4.700,25" },
    currency: null,
    sourceNetSalesMinor: null,
    interpretation: {
      money: {
        currency: null,
        minorUnitDigits: null,
        decimalSeparator: ",",
        groupSeparator: ".",
      },
    },
  };
  assert.deepEqual(resolveHistoryNetSales(record, settings), {
    amountMinor: 470025,
    currency: "RSD",
    minorUnitDigits: 2,
    basis: "owner-confirmed",
    issue: null,
  });
  assert.equal(resolveHistoryNetSales(record, {}).amountMinor, null);
  const explicit = {
    ...record,
    currency: "USD",
    sourceNetSalesMinor: 777,
    interpretation: {
      money: {
        currency: "USD",
        minorUnitDigits: 2,
        decimalSeparator: ".",
        groupSeparator: null,
      },
    },
  };
  assert.equal(resolveHistoryNetSales(explicit, settings).currency, "USD");
  assert.equal(resolveHistoryNetSales(explicit, settings).amountMinor, 777);
  assert.equal(
    resolveHistoryNetSales(
      {
        ...explicit,
        interpretation: { money: { currency: "USD", minorUnitDigits: null } },
      },
      settings,
    ).amountMinor,
    null,
  );
  for (const raw of ["12.345", "1,23", "abc", "900719925474099100"])
    assert.equal(
      resolveHistoryNetSales(
        {
          raw: { netSales: raw },
          interpretation: {
            money: { decimalSeparator: ".", groupSeparator: "," },
          },
        },
        settings,
      ).amountMinor,
      null,
    );
  assert.equal(
    resolveHistoryNetSales(
      {
        raw: { netSales: "-12.50" },
        interpretation: {
          money: { decimalSeparator: ".", groupSeparator: null },
        },
      },
      settings,
    ).amountMinor,
    -1250,
  );
  assert.equal(historySalonLabelKey("  ＴＨＡＩ  Massage "), "thai massage");
});
