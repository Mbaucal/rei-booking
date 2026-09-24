import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { MONTHLY_SCHEMA } from "../src/monthly-schema.mjs";
import {
  currentMonth,
  shiftMonth,
  monthOptions,
  dueAt,
} from "../src/monthly-periods.mjs";
import { runMonthly, generateSnapshot } from "../src/monthly-reports.mjs";
import {
  requestRecipient,
  confirmRecipient,
  sendMonthlyJob,
  reconcileReportEvents,
  reportMessage,
} from "../src/monthly-email.mjs";

function statements(sql) {
  const list = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
    if (
      current.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    list.push(current.trim());
    current = "";
  }
  assert.equal(current.trim(), "");
  return list;
}
test("monthly periods close full Belgrade months through DST, leap years and year rollover", () => {
  for (const [period, from, to, pFrom, pTo] of [
    ["2024-02", "2024-02-01", "2024-02-29", "2024-01-01", "2024-01-31"],
    ["2026-01", "2026-01-01", "2026-01-31", "2025-12-01", "2025-12-31"],
    ["2026-03", "2026-03-01", "2026-03-31", "2026-02-01", "2026-02-28"],
  ]) {
    const o = monthOptions(period);
    assert.deepEqual(
      [o.from, o.to, o.previousFrom, o.previousTo],
      [from, to, pFrom, pTo],
    );
  }
  assert.equal(
    new Date(dueAt("2026-03", 540)).toISOString(),
    "2026-04-01T07:00:00.000Z",
  );
  assert.equal(
    new Date(dueAt("2026-10", 540)).toISOString(),
    "2026-11-01T08:00:00.000Z",
  );
  assert.equal(
    new Date(dueAt("2026-12", 0)).toISOString(),
    "2026-12-31T23:00:00.000Z",
  );
  assert.equal(currentMonth(Date.parse("2026-08-31T22:01:00Z")), "2026-09");
  assert.throws(() => monthOptions("2026-13"));
});
test("Monthly Worker + D1: immutable archive, scheduler, privacy and reliable notifications", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-monthly-")),
    ORIGIN = "https://monthly.example";
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
    bindings: {
      APP_ORIGIN: ORIGIN,
      APP_ENV: "test",
      EMAIL_ENABLED: "false",
      RESEND_WEBHOOK_SECRET: "whsec_" + Buffer.alloc(24, 5).toString("base64"),
    },
    d1Databases: { DB: "monthly-tests" },
    log: new Log(LogLevel.ERROR),
  });
  // The Worker entry point must be the first module.
  options.resourcePersistencePath = persist;
  let mf = new Miniflare(options),
    db = await mf.getD1Database("DB");
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  for (const sql of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(sql).run();
  const sql = (query, ...args) => db.prepare(query).bind(...args),
    sessions = {};
  for (const role of ["owner", "reception", "therapist", "other-owner"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      role,
      role + "@example.test",
      role,
      "test-only-unused",
      role === "therapist"
        ? "reception"
        : role === "other-owner"
          ? "owner"
          : role,
      new Date().toISOString(),
    ).run();
    await sql(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      role,
      csrf,
      Date.now() + 3600000,
      new Date().toISOString(),
    ).run();
  }
  async function raw(path, method = "GET", body, role = "owner", headers = {}) {
    const s = sessions[role];
    return mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        origin: ORIGIN,
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
  async function create(path, body) {
    const r = await request(path, "POST", body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const therapist = (await create("/therapists", { name: "Report Therapist" }))
    .id;
  await sql(
    "UPDATE users SET role='therapist',therapist_id=? WHERE id='therapist'",
    therapist,
  ).run();
  const service = (
    await create("/services", {
      name: "=SUM(1,1)",
      duration: 90,
      priceCents: 590000,
      color: "#2e87a0",
    })
  ).id;
  const client = (
    await create("/clients", {
      name: "PRIVATE CLIENT NAME",
      phone: "+38160111111",
      note: "PRIVATE CLIENT NOTE",
    })
  ).id;
  const thisMonth = currentMonth(),
    period = shiftMonth(thisMonth, -1),
    prior = shiftMonth(period, -1);
  const a = (
    await create("/appointments", {
      date: period + "-05",
      start: 600,
      duration: 90,
      therapistId: therapist,
      serviceId: service,
      roomId: "r1",
      bed: 0,
      status: "done",
      requestedTherapistId: therapist,
      grossCents: 590000,
      netCents: 570000,
      clientId: client,
      note: "PRIVATE APPOINTMENT NOTE",
    })
  ).appointment;
  await create("/appointments", {
    date: prior + "-03",
    start: 600,
    duration: 90,
    therapistId: therapist,
    serviceId: service,
    roomId: "r1",
    bed: 0,
    status: "done",
    grossCents: 590000,
    netCents: 590000,
  });
  const base = {
    name: "Monthly therapist report",
    minute: 540,
    filters: {
      group: "therapist",
      status: "all",
      requested: "all",
      dayBasis: "active",
      bonuses: true,
    },
    notifications: false,
    paused: false,
  };
  let schedule, archiveId;
  await t.test(
    "automatic schema, owner-only routes, verified recipients and stale schedule updates",
    async () => {
      const settings = await request("/reports/monthly");
      assert.equal(settings.status, 200, JSON.stringify(settings.data));
      assert.equal(settings.data.emailReady, false);
      assert.equal(
        await readFile("migrations/0007_monthly_reports.sql", "utf8"),
        MONTHLY_SCHEMA.map((s) => s + ";").join("\n\n") + "\n",
      );
      await db.batch(MONTHLY_SCHEMA.map((s) => db.prepare(s)));
      for (const role of ["reception", "therapist", "anonymous"])
        for (const [path, method, body] of [
          ["/reports/monthly", "GET"],
          ["/reports/archive", "GET"],
          ["/reports/monthly", "POST", base],
          [
            "/reports/recipients/request",
            "POST",
            { email: "other@example.test" },
          ],
        ])
          assert.equal(
            (await raw(path, method, body, role)).status,
            role === "anonymous" ? 401 : 403,
          );
      assert.equal(
        (
          await raw("/reports/monthly", "POST", base, "owner", {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await raw("/reports/monthly", "POST", base, "owner", {
            origin: "https://elsewhere.example",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/reports/monthly", "POST", {
            ...base,
            notifications: true,
            recipient: "unverified@example.test",
          })
        ).status,
        503,
      );
      schedule = await create("/reports/monthly", base);
      assert.equal(schedule.nextMonth, thisMonth);
      assert.equal(
        (
          await request("/reports/monthly/" + schedule.id, "PUT", {
            ...base,
            revision: 9,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            "/reports/monthly/" + schedule.id,
            "PUT",
            { ...base, revision: 1 },
            "other-owner",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "/reports/monthly/" + schedule.id + "/generate",
            "POST",
            { period: thisMonth },
          )
        ).status,
        400,
      );
    },
  );
  await t.test(
    "concurrent generation freezes reconciled current/prior values and formula-safe CSV without client identity",
    async () => {
      const pair = await Promise.all([
        request("/reports/monthly/" + schedule.id + "/generate", "POST", {
          period,
        }),
        request("/reports/monthly/" + schedule.id + "/generate", "POST", {
          period,
        }),
      ]);
      pair.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.data)));
      assert.equal(pair[0].data.id, pair[1].data.id);
      archiveId = pair[0].data.id;
      const p = (await request("/reports/archive/" + archiveId)).data;
      assert.equal(p.version, 1);
      assert.equal(p.report.totals.revenueCents, 570000);
      assert.equal(p.report.totals.requestedMinutes, 90);
      assert.equal(p.report.totals.requestedBonusCents, 75000);
      assert.equal(p.report.comparison.revenueCents.previous, 590000);
      const row = await sql(
        "SELECT * FROM report_snapshots WHERE id=?",
        archiveId,
      ).first();
      assert.ok(row.cutoff_audit_id > 0);
      assert.ok(row.cutoff_at);
      assert.doesNotMatch(
        JSON.stringify(row),
        /PRIVATE|client_id|client_name|clientId/,
      );
      assert.equal(
        (await sql("SELECT COUNT(*) n FROM report_snapshots").first()).n,
        1,
      );
      assert.match(row.details_csv, /'=SUM/);
      for (const view of ["summary", "details", "comparison"])
        assert.deepEqual(
          Buffer.from(
            await (
              await raw("/reports/archive/" + archiveId + ".csv?view=" + view)
            ).arrayBuffer(),
          ),
          Buffer.from(row[view + "_csv"]),
        );
      for (const role of ["reception", "therapist", "other-owner"])
        assert.equal(
          (
            await raw(
              "/reports/archive/" + archiveId + ".csv",
              "GET",
              undefined,
              role,
            )
          ).status,
          role === "other-owner" ? 404 : 403,
        );
      await assert.rejects(
        sql(
          "UPDATE report_snapshots SET summary_csv='changed' WHERE id=?",
          archiveId,
        ).run(),
        /report_history_immutable/,
      );
      await assert.rejects(
        sql("DELETE FROM report_snapshots WHERE id=?", archiveId).run(),
        /report_history_immutable/,
      );
    },
  );
  await t.test(
    "corrections preserve saved originals; idempotent new revisions retain original template even after edits",
    async () => {
      await sql(
        "UPDATE appointments SET net_cents=550000,version=version+1 WHERE id=?",
        a.id,
      ).run();
      assert.equal(
        (await request("/reports/archive/" + archiveId)).data.report.totals
          .revenueCents,
        570000,
      );
      const edit = await request("/reports/monthly/" + schedule.id, "PUT", {
        ...base,
        revision: 1,
        name: "New filter name",
        filters: { ...base.filters, status: "cancelled" },
      });
      assert.equal(edit.status, 200, JSON.stringify(edit.data));
      const body = {
        key: randomUUID(),
        reason: "Corrected appointment discount",
      };
      const pair = await Promise.all([
        request("/reports/archive/" + archiveId + "/revise", "POST", body),
        request("/reports/archive/" + archiveId + "/revise", "POST", body),
      ]);
      pair.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.data)));
      assert.equal(pair[0].data.id, pair[1].data.id);
      const newId = pair[0].data.id,
        p = (await request("/reports/archive/" + newId)).data;
      assert.equal(p.version, 2);
      assert.equal(p.template_revision, 1);
      assert.equal(p.report.totals.revenueCents, 550000);
      assert.equal(p.supersedes_id, archiveId);
      assert.equal(
        (
          await request("/reports/archive/" + archiveId + "/revise", "POST", {
            ...body,
            reason: "Changed replay",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/reports/archive/" + archiveId + "/revise", "POST", {
            key: randomUUID(),
            reason: "Stale revision",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            "/reports/monthly/" + schedule.id + "/generate",
            "POST",
            { period },
          )
        ).data.id,
        archiveId,
      );
      await assert.rejects(
        sql("UPDATE report_templates SET name='Changed'").run(),
        /report_history_immutable/,
      );
    },
  );
  await t.test(
    "scheduler catches up once, honours Belgrade time and pause, and saves empty months after app closure",
    async () => {
      const s = await create("/reports/monthly", {
          ...base,
          name: "Catch-up report",
        }),
        env = { DB: db, APP_ORIGIN: ORIGIN, EMAIL_ENABLED: "false" };
      const time = dueAt(thisMonth, 540);
      await runMonthly(env, time - 1);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM report_snapshots WHERE schedule_id=?",
            s.id,
          ).first()
        ).n,
        0,
      );
      await Promise.all([runMonthly(env, time), runMonthly(env, time)]);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM report_snapshots WHERE schedule_id=?",
            s.id,
          ).first()
        ).n,
        1,
      );
      let first = await sql(
        "SELECT report_json FROM report_snapshots WHERE schedule_id=?",
        s.id,
      ).first();
      assert.equal(JSON.parse(first.report_json).totals.revenueCents, 0);
      const current = (await request("/reports/monthly")).data.schedules.find(
        (r) => r.id === s.id,
      );
      await request("/reports/monthly/" + s.id, "PUT", {
        ...current,
        paused: true,
      });
      await runMonthly(env, dueAt(shiftMonth(thisMonth, 2), 540));
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM report_snapshots WHERE schedule_id=?",
            s.id,
          ).first()
        ).n,
        1,
      );
      await request("/reports/monthly/" + s.id, "PUT", {
        ...current,
        revision: 2,
        paused: false,
      });
      await runMonthly(env, dueAt(shiftMonth(thisMonth, 2), 540));
      await runMonthly(env, dueAt(shiftMonth(thisMonth, 2), 540));
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM report_snapshots WHERE schedule_id=?",
            s.id,
          ).first()
        ).n,
        3,
      );
      const worker = await mf.getWorker();
      const dispatched = await worker.scheduled({
        scheduledTime: dueAt(shiftMonth(thisMonth, 2), 540),
        cron: "*/15 * * * *",
      });
      assert.equal(dispatched.outcome, "ok");
      const before = await (
        await raw("/reports/archive/" + archiveId + ".csv")
      ).text();
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      assert.equal(
        await (await raw("/reports/archive/" + archiveId + ".csv")).text(),
        before,
      );
    },
  );
  await t.test(
    "pending data is marked and missing inputs never become invented zero totals",
    async () => {
      const s = await create("/reports/monthly", {
        ...base,
        name: "Incomplete data",
      });
      await sql(
        "UPDATE appointments SET status='booked' WHERE id=?",
        a.id,
      ).run();
      const saved = await request(
        "/reports/monthly/" + s.id + "/generate",
        "POST",
        { period },
      );
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      const p = (await request("/reports/archive/" + saved.data.id)).data;
      assert.equal(p.incomplete, 1);
      assert.equal(p.report.totals.pending, 1);
      assert.match(p.report.warnings[0], /Uncompleted/);
      await sql(
        "UPDATE appointments SET status='done',service_name='' WHERE id=?",
        a.id,
      ).run();
      const changed = await request(
        "/reports/archive/" + saved.data.id + "/revise",
        "POST",
        {
          key: randomUUID(),
          reason: "Inspect incomplete historical treatment",
        },
      );
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      const q = (await request("/reports/archive/" + changed.data.id)).data;
      assert.equal(q.incomplete, 1);
      assert.equal(q.report.totals, null);
      assert.match(q.report.error, /incomplete/i);
      assert.match(
        await (
          await raw("/reports/archive/" + changed.data.id + ".csv")
        ).text(),
        /Incomplete/,
      );
      await sql(
        "UPDATE appointments SET service_name='=SUM(1,1)' WHERE id=?",
        a.id,
      ).run();
    },
  );
  await t.test(
    "recipient verification is rate-limited, expires, consumes once and does not expose codes in API",
    async () => {
      const env = {
          DB: db,
          APP_ORIGIN: ORIGIN,
          EMAIL_ENABLED: "true",
          RESEND_API_KEY: "fake",
          RESEND_WEBHOOK_SECRET: "fake",
        },
        user = { id: "owner" },
        time = Date.now();
      const result = await requestRecipient(
        db,
        env,
        user,
        "notify@example.test",
        time,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /code_hash|verification code is/,
      );
      const job = await sql(
          "SELECT * FROM report_email_jobs WHERE id=?",
          result.job.id,
        ).first(),
        code = JSON.parse(job.payload_json).text.match(
          /code is ([A-F0-9]{10})/,
        )[1];
      await assert.rejects(
        requestRecipient(db, env, user, "other@example.test", time + 1000),
        /Wait one minute/,
      );
      await assert.rejects(
        confirmRecipient(
          db,
          user,
          "notify@example.test",
          "0000000000",
          time + 1001,
        ),
        /incorrect/,
      );
      await confirmRecipient(
        db,
        user,
        "notify@example.test",
        code,
        time + 1002,
      );
      await assert.rejects(
        confirmRecipient(db, user, "notify@example.test", code, time + 1003),
        /incorrect/,
      );
      assert.ok(
        (
          await sql(
            "SELECT verified_at FROM report_recipients WHERE email='notify@example.test'",
          ).first()
        ).verified_at,
      );
      const again = await requestRecipient(
          db,
          env,
          user,
          "new@example.test",
          time + 61000,
        ),
        againJob = await sql(
          "SELECT payload_json FROM report_email_jobs WHERE id=?",
          again.job.id,
        ).first(),
        expired = JSON.parse(againJob.payload_json).text.match(
          /code is ([A-F0-9]{10})/,
        )[1];
      await assert.rejects(
        confirmRecipient(db, user, "new@example.test", expired, time + 1300000),
        /expired/,
      );
      let sends = 0;
      await sendMonthlyJob(
        db,
        env,
        again.job.id,
        async () => {
          sends++;
        },
        time + 1300000,
      );
      assert.equal(sends, 0);
    },
  );
  await t.test(
    "queued notification keeps immutable payload/key, concurrent claims send once, signed delivery controls status",
    async () => {
      const env = {
        DB: db,
        APP_ORIGIN: ORIGIN,
        EMAIL_ENABLED: "true",
        RESEND_API_KEY: "fake",
        RESEND_WEBHOOK_SECRET: "fake",
      };
      // Configure the fictional test schedule after separately verifying its fictional recipient.
      const s = await create("/reports/monthly", {
        ...base,
        name: "Delivery test",
      });
      await sql(
        "INSERT INTO report_templates(schedule_id,revision,effective_month,name,filters_json,minute,notifications,recipient,created_at) VALUES(?,2,?,?,?,?,1,?,?)",
        s.id,
        prior,
        "Delivery test",
        JSON.stringify({ ...base.filters, therapist: "", service: "" }),
        540,
        "notify@example.test",
        new Date().toISOString(),
      ).run();
      await sql(
        "UPDATE report_schedules SET revision=2 WHERE id=?",
        s.id,
      ).run();
      const source = await sql(
        "SELECT * FROM report_schedules WHERE id=?",
        s.id,
      ).first();
      const result = await generateSnapshot(db, env, source, period),
        job = await sql(
          "SELECT * FROM report_email_jobs WHERE snapshot_id=?",
          result.id,
        ).first();
      assert.ok(job);
      assert.doesNotMatch(
        job.payload_json,
        /PRIVATE|570000|550000|75000|client/,
      );
      assert.match(job.payload_json, /#report=/);
      await assert.rejects(
        sql(
          "UPDATE report_email_jobs SET payload_json='{}' WHERE id=?",
          job.id,
        ).run(),
        /report_email_immutable/,
      );
      let calls = [];
      const transport = async (url, init) => {
        calls.push(init);
        return Response.json({ id: "monthly-provider-id" });
      };
      await Promise.all([
        sendMonthlyJob(db, env, job.id, transport),
        sendMonthlyJob(db, env, job.id, transport),
      ]);
      assert.equal(calls.length, 1);
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            job.id,
          ).first()
        ).status,
        "accepted",
      );
      assert.equal(calls[0].headers["Idempotency-Key"], "rei-report/" + job.id);
      assert.equal(calls[0].body, job.payload_json);
      await sendMonthlyJob(db, env, job.id, transport);
      assert.equal(calls.length, 1);
      const payload = JSON.stringify({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: "monthly-provider-id" },
        }),
        timestamp = String(Math.floor(Date.now() / 1000)),
        event = "monthly-event";
      const signature = createHmac("sha256", Buffer.alloc(24, 5))
        .update(`${event}.${timestamp}.${payload}`)
        .digest("base64");
      const response = await mf.dispatchFetch(ORIGIN + "/api/email/webhook", {
        method: "POST",
        headers: {
          "svix-id": event,
          "svix-timestamp": timestamp,
          "svix-signature": "v1," + signature,
        },
        body: payload,
      });
      assert.equal(response.status, 200, await response.text());
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            job.id,
          ).first()
        ).status,
        "delivered",
      );
      // A paused schedule cancels an unclaimed report notification before transport runs.
      const saved = await sql(
        "SELECT * FROM report_snapshots WHERE id=?",
        result.id,
      ).first();
      const correction = await generateSnapshot(db, env, source, period, {
        previous: saved,
        key: randomUUID(),
        reason: "Check notification pause",
      });
      const pending = await sql(
        "SELECT * FROM report_email_jobs WHERE snapshot_id=?",
        correction.id,
      ).first();
      await sql("UPDATE report_schedules SET paused=1 WHERE id=?", s.id).run();
      await sendMonthlyJob(db, env, pending.id, transport);
      assert.equal(calls.length, 1);
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            pending.id,
          ).first()
        ).status,
        "cancelled",
      );
      await sql("UPDATE report_schedules SET paused=0 WHERE id=?", s.id).run();
      // Late less-specific events cannot downgrade a delivered notification.
      await sql(
        "INSERT INTO email_events(id,provider_id,event_type,occurred_at,received_at) VALUES(?,?,?,?,?)",
        "late-event",
        "monthly-provider-id",
        "email.sent",
        new Date().toISOString(),
        new Date().toISOString(),
      ).run();
      await reconcileReportEvents(db, "monthly-provider-id");
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            job.id,
          ).first()
        ).status,
        "delivered",
      );
    },
  );
  await t.test(
    "uncertain delivery stops before provider deduplication expires; suppression and owner revocation stop sends",
    async () => {
      const env = {
          DB: db,
          APP_ORIGIN: ORIGIN,
          EMAIL_ENABLED: "true",
          RESEND_API_KEY: "fake",
          RESEND_WEBHOOK_SECRET: "fake",
        },
        time = Date.now();
      async function prepare(recipient = "notify@example.test") {
        const id = randomUUID();
        await sql(
          "INSERT INTO report_email_jobs(id,owner_id,kind,recipient,payload_json,created_at,updated_at,expires_at) VALUES(?,'owner','verification',?,'{}',?,?,?)",
          id,
          recipient,
          new Date().toISOString(),
          new Date().toISOString(),
          time + 48 * 3600000,
        ).run();
        await sql(
          "INSERT INTO report_recipients(owner_id,email,active_job_id,code_hash,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,email) DO UPDATE SET active_job_id=excluded.active_job_id,code_hash=excluded.code_hash,expires_at=excluded.expires_at",
          "owner",
          recipient,
          id,
          "fake",
          time + 48 * 3600000,
        ).run();
        return id;
      }
      const id = await prepare();
      let sent = [];
      const failure = async (u, init) => {
        sent.push(init);
        throw new Error("network timeout");
      };
      await sendMonthlyJob(db, env, id, failure, time);
      let job = await sql(
        "SELECT * FROM report_email_jobs WHERE id=?",
        id,
      ).first();
      assert.equal(job.status, "retry");
      await sendMonthlyJob(db, env, id, failure, job.next_attempt_at);
      assert.equal(sent.length, 2);
      assert.equal(sent[0].body, sent[1].body);
      assert.equal(
        sent[0].headers["Idempotency-Key"],
        sent[1].headers["Idempotency-Key"],
      );
      await sendMonthlyJob(db, env, id, failure, time + 23 * 3600000);
      assert.equal(sent.length, 2);
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            id,
          ).first()
        ).status,
        "uncertain",
      );
      const suppressed = await prepare("bounce@example.test");
      await sql(
        "INSERT INTO email_suppressions(recipient,reason,created_at) VALUES(?,'bounced',?)",
        "bounce@example.test",
        new Date().toISOString(),
      ).run();
      await sendMonthlyJob(db, env, suppressed, failure, time);
      assert.equal(sent.length, 2);
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            suppressed,
          ).first()
        ).status,
        "suppressed",
      );
      const blocked = await prepare();
      await sql("UPDATE users SET active=0 WHERE id='owner'").run();
      await sendMonthlyJob(db, env, blocked, failure, time);
      assert.equal(sent.length, 2);
      assert.equal(
        (
          await sql(
            "SELECT status FROM report_email_jobs WHERE id=?",
            blocked,
          ).first()
        ).status,
        "cancelled",
      );
      await sql("UPDATE users SET active=1 WHERE id='owner'").run();
    },
  );
});
