import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { digest, token } from "../src/security.mjs";
import { VOUCHER_CHANGE_SCHEMA } from "../src/voucher-change-schema.mjs";
import { REDEMPTION_SCHEMA } from "../src/redemption-schema.mjs";
import { DEFAULT_DESIGN } from "../src/voucher-render.mjs";
import { belgradeToday } from "../src/reports.mjs";
import { sendDelivery } from "../src/voucher-email.mjs";

const ORIGIN = "https://redemption.example";
function statements(sql) {
  const result = [];
  let part = "";
  for (const line of sql.split("\n")) {
    part += line + "\n";
    if (
      part.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    result.push(part.trim());
    part = "";
  }
  assert.equal(part.trim(), "");
  return result;
}
test("Voucher Worker + D1: balances, linked treatments, concurrent use and corrections", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        "worker.mjs",
        "monthly-schema.mjs",
        "monthly-periods.mjs",
        "monthly-email.mjs",
        "monthly-reports.mjs",
        "photos.mjs",
        "photo-schema.mjs",
        "photo-codec.mjs",
        "security.mjs",
        "domain.mjs",
        "reports.mjs",
        "report-schema.mjs",
        "sales.mjs",
        "sales-schema.mjs",
        "redemption-schema.mjs",
        "voucher-redemption.mjs",
        "voucher-changes.mjs",
        "voucher-change-schema.mjs",
        "voucher-render.mjs",
        "voucher-email.mjs",
      ].map((f) => ({ type: "ESModule", path: resolve("src", f) })),
      modulesRoot: resolve("src"),
      compatibilityDate: "2026-09-22",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { APP_ORIGIN: ORIGIN, APP_ENV: "test" },
      d1Databases: { DB: "redemption-tests" },
      log: new Log(LogLevel.ERROR),
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const sql of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(sql).run();
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  const sessions = {};
  for (const role of ["owner", "reception", "therapist"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      role,
      role + "@example.test",
      role,
      "test-only-unused",
      role === "therapist" ? "reception" : role,
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
    const session = sessions[role];
    return mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(session
          ? {
              cookie: "__Host-rei_session=" + session.raw,
              "x-csrf-token": session.csrf,
            }
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
  const tid = (await create("/therapists", { name: "Gift therapist" })).id;
  await sql(
    "UPDATE users SET role='therapist',therapist_id=? WHERE id='therapist'",
    tid,
  ).run();
  const serviceId = (
    await create("/services", {
      name: "Gift massage",
      duration: 60,
      priceCents: 470000,
      color: "#2e87a0",
    })
  ).id;
  const secondServiceId = (
    await create("/services", {
      name: "Another massage",
      duration: 60,
      priceCents: 470000,
      color: "#2e87a0",
    })
  ).id;
  let dayOffset = 0;
  async function booking(extra = {}) {
    // Each booking has its own past day, so collision outcomes depend only on voucher use.
    const date = new Date(Date.UTC(2025, 0, 1 + dayOffset++))
      .toISOString()
      .slice(0, 10);
    return (
      await create("/appointments", {
        date,
        start: 600,
        duration: 60,
        therapistId: tid,
        serviceId,
        roomId: "r1",
        bed: 0,
        status: "done",
        requestedTherapistId: tid,
        grossCents: 470000,
        netCents: 470000,
        ...extra,
      })
    ).appointment;
  }
  async function gift(kind = "amount", priceCents = 470000, extra = {}) {
    const result = await create("/sales/checkout", {
      requestId: randomUUID(),
      paymentMethod: "cash",
      paymentConfirmed: true,
      items: [
        {
          kind,
          priceCents,
          serviceId,
          serviceVersion: 1,
          expiresOn: null,
          design: DEFAULT_DESIGN,
          ...extra,
        },
      ],
    });
    return result.sale.vouchers[0];
  }
  const input = (v, a, cents = a.netCents) => ({
    requestId: randomUUID(),
    voucherId: v.id,
    appointmentId: a.id,
    appointmentVersion: a.version,
    appliedCents: cents,
    confirmed: true,
  });
  const redeem = (body, role = "owner") =>
    request("/sales/redemptions", "POST", body, role);
  const lookup = async (v) =>
    (await request("/sales/voucher-lookup?code=" + v.code.toLowerCase())).data
      .voucher;
  const reverse = (id, extra = {}) =>
    request("/sales/redemptions/" + id + "/reverse", "POST", {
      requestId: randomUUID(),
      reason: "Wrong appointment selected",
      confirmed: true,
      ...extra,
    });

  await t.test(
    "additive schema, lookup and all redemption routes enforce permissions and CSRF",
    async () => {
      const v = await gift(),
        a = await booking(),
        body = input(v, a);
      assert.equal(
        await readFile("migrations/0004_voucher_redemptions.sql", "utf8"),
        REDEMPTION_SCHEMA.map((s) => s + ";").join("\n\n") + "\n",
      );
      await db.batch(REDEMPTION_SCHEMA.map((s) => db.prepare(s)));
      assert.equal((await lookup(v)).id, v.id);
      for (const role of ["reception", "therapist", "anonymous"]) {
        const status = role === "anonymous" ? 401 : 403;
        for (const path of [
          "/sales/voucher-lookup?code=" + v.code,
          "/sales/appointments/" + a.id,
          "/sales/redemption-appointments?date=" + a.date,
        ])
          assert.equal(
            (await request(path, "GET", undefined, role)).status,
            status,
          );
        assert.equal((await redeem(body, role)).status, status);
        assert.equal(
          (
            await request(
              "/sales/redemptions/missing/reverse",
              "POST",
              {},
              role,
            )
          ).status,
          status,
        );
      }
      assert.equal(
        (
          await request("/sales/redemptions", "POST", body, "owner", {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (await request("/sales/voucher-lookup?code=NOT-FOUND")).status,
        404,
      );
      assert.equal(
        (await request("/sales/redemption-appointments?date=bad")).status,
        400,
      );
    },
  );
  await t.test(
    "partial amount use, identical concurrent retries and immutable sale/report values",
    async () => {
      const v = await gift(),
        a = await booking();
      const reportPath =
        "/reports/appointments?" +
        new URLSearchParams({ preset: "custom", from: a.date, to: a.date });
      const beforeResponse = await request(reportPath);
      assert.equal(
        beforeResponse.status,
        200,
        JSON.stringify(beforeResponse.data),
      );
      const before = beforeResponse.data;
      const body = input(v, a, 170000);
      const results = await Promise.all([redeem(body), redeem(body)]);
      assert.deepEqual(
        results.map((r) => r.status).sort(),
        [200, 201],
        JSON.stringify(results),
      );
      assert.equal(
        results[0].data.redemption.id,
        results[1].data.redemption.id,
      );
      const used = await lookup(v);
      assert.equal(used.status, "partially_redeemed");
      assert.equal(used.remainingCents, 300000);
      const changed = await redeem({ ...body, appliedCents: 160000 });
      assert.equal(changed.status, 409);
      assert.equal((await redeem(input(v, a, 300000))).status, 201);
      assert.equal((await lookup(v)).remainingCents, 0);
      assert.equal((await lookup(v)).status, "redeemed");
      assert.equal((await redeem(input(v, a, 1))).status, 409);
      const detail = (await request("/sales/appointments/" + a.id)).data;
      assert.equal(detail.appointment.coveredCents, 470000);
      assert.equal(detail.redemptions.length, 2);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM audit_log WHERE action='redeem_voucher' AND json_extract(after_json,'$.voucherId')=?",
            v.id,
          ).first()
        ).n,
        2,
      );
      assert.deepEqual((await request(reportPath)).data, before);
      assert.equal(
        (await request("/sales/orders/" + v.saleId)).data.sale.totalCents,
        470000,
      );
      assert.equal(
        (
          await sql(
            "SELECT price_cents FROM gift_vouchers WHERE id=?",
            v.id,
          ).first()
        ).price_cents,
        470000,
      );
      const csv = await (await raw("/sales/vouchers.csv?q=" + v.code)).text();
      assert.match(csv, /Remaining voucher value/);
      assert.match(csv, /"redeemed","4700.00","0.00"/);
    },
  );
  await t.test(
    "different concurrent requests cannot overspend a voucher or overcover an appointment",
    async () => {
      const v = await gift(),
        a = await booking(),
        b = await booking();
      const attempts = await Promise.all([
        redeem(input(v, a)),
        redeem(input(v, b)),
      ]);
      assert.deepEqual(
        attempts.map((r) => r.status).sort(),
        [201, 409],
        JSON.stringify(attempts),
      );
      assert.equal((await lookup(v)).remainingCents, 0);
      const target = await booking(),
        x = await gift(),
        y = await gift();
      const coverage = await Promise.all([
        redeem(input(x, target)),
        redeem(input(y, target)),
      ]);
      assert.deepEqual(
        coverage.map((r) => r.status).sort(),
        [201, 409],
        JSON.stringify(coverage),
      );
      assert.equal(
        (await request("/sales/appointments/" + target.id)).data.appointment
          .coveredCents,
        target.netCents,
      );
      assert.equal(
        (await lookup(x)).remainingCents + (await lookup(y)).remainingCents,
        470000,
      );
    },
  );
  await t.test(
    "treatment vouchers require exact service and duration, cover one entire discounted appointment",
    async () => {
      const v = await gift("treatment"),
        wrong = await booking({ serviceId: secondServiceId }),
        long = await booking({ duration: 90 }),
        right = await booking({ netCents: 390000 });
      assert.equal((await redeem(input(v, wrong))).status, 409);
      assert.equal((await redeem(input(v, long))).status, 409);
      assert.equal((await redeem(input(v, right, 100000))).status, 409);
      const result = await redeem(input(v, right));
      assert.equal(result.status, 201, JSON.stringify(result));
      assert.equal(result.data.redemption.appliedCents, 390000);
      assert.equal(result.data.redemption.debitedCents, 470000);
      assert.equal((await lookup(v)).remainingCents, 0);
      assert.equal((await redeem(input(v, await booking()))).status, 409);
      const partial = await booking(),
        amount = await gift("amount", 100000),
        treatment = await gift("treatment");
      assert.equal((await redeem(input(amount, partial, 100000))).status, 201);
      assert.equal(
        (await redeem(input(treatment, partial, 370000))).status,
        409,
      );
    },
  );
  await t.test(
    "uncompleted, future, expired, stale and invalid uses are rejected without ledger writes",
    async () => {
      const v = await gift(),
        booked = await booking({ status: "booked" }),
        future = await booking({ date: "2099-01-01" }),
        zero = await booking({ netCents: 0 });
      for (const a of [booked, future, zero])
        assert.equal((await redeem(input(v, a, 1))).status, 409);
      const a = await booking();
      assert.equal(
        (await redeem({ ...input(v, a), appointmentVersion: 2 })).status,
        409,
      );
      for (const extra of [
        { appliedCents: 0 },
        { appliedCents: 1.5 },
        { confirmed: false },
        { requestId: "bad" },
      ])
        assert.equal((await redeem({ ...input(v, a), ...extra })).status, 400);
      const current = await gift("amount", 470000, {
        expiresOn: belgradeToday(),
      });
      assert.equal((await redeem(input(current, a))).status, 201);
      // An older issued voucher is inserted as a migration fixture; issued rows are never edited.
      const oldId = randomUUID(),
        oldCode = randomUUID().toUpperCase();
      await sql(
        `INSERT INTO gift_vouchers(id,sale_id,code,kind,service_id,service_name,duration,price_cents,recipient_name,sender_name,message,expires_on,design_json,issued_at)
SELECT ?,sale_id,?,kind,service_id,service_name,duration,price_cents,recipient_name,sender_name,message,'2020-01-01',design_json,issued_at FROM gift_vouchers WHERE id=?`,
        oldId,
        oldCode,
        v.id,
      ).run();
      const expired = { id: oldId, code: oldCode };
      assert.equal((await lookup(expired)).status, "expired");
      assert.equal((await redeem(input(expired, await booking()))).status, 409);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?",
            v.id,
          ).first()
        ).n,
        0,
      );
    },
  );
  await t.test(
    "corrections restore once, preserve history and unlock edits without replaying old uses",
    async () => {
      const v = await gift("treatment"),
        a = await booking(),
        body = input(v, a);
      const result = await redeem(body);
      assert.equal(result.status, 201);
      const r = result.data.redemption;
      for (const extra of [
        { status: "cancelled" },
        { netCents: 100000 },
        { start: 660 },
        { requestedTherapistId: null },
      ]) {
        const response = await request("/appointments/" + a.id, "PUT", {
          ...a,
          ...extra,
        });
        assert.equal(response.status, 409, JSON.stringify(response));
        assert.match(response.data.error, /Reverse the voucher/);
      }
      const notes = await request("/appointments/" + a.id, "PUT", {
        ...a,
        note: "A note remains editable",
      });
      assert.equal(notes.status, 200);
      const updated = notes.data.appointment;
      assert.equal((await reverse(r.id, { reason: "x" })).status, 400);
      assert.equal((await reverse(r.id, { confirmed: false })).status, 400);
      const correction = {
        requestId: randomUUID(),
        reason: "Selected the wrong visit",
        confirmed: true,
      };
      const responses = await Promise.all([
        reverse(r.id, correction),
        reverse(r.id, correction),
      ]);
      assert.deepEqual(
        responses.map((x) => x.status),
        [200, 200],
      );
      assert.equal((await lookup(v)).remainingCents, 470000);
      assert.equal((await reverse(r.id)).status, 409);
      assert.equal(
        (await reverse(r.id, { ...correction, reason: "Changed reason" }))
          .status,
        409,
      );
      const moved = await request("/appointments/" + a.id, "PUT", {
        ...updated,
        start: 660,
        status: "cancelled",
      });
      assert.equal(moved.status, 200);
      const historic = (await request("/sales/vouchers/" + v.id)).data
        .redemptions[0];
      assert.equal(historic.start, 600);
      assert.equal(historic.reason, correction.reason);
      assert.ok(historic.reversedAt);
      assert.equal((await redeem(body)).status, 200);
      assert.equal((await lookup(v)).remainingCents, 470000);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM audit_log WHERE action='reverse_redemption' AND entity_id=?",
            r.id,
          ).first()
        ).n,
        1,
      );
      await assert.rejects(
        sql(
          "UPDATE voucher_redemptions SET applied_cents=1 WHERE id=?",
          r.id,
        ).run(),
        /redemption_immutable/,
      );
      await assert.rejects(
        sql(
          "DELETE FROM voucher_redemption_reversals WHERE redemption_id=?",
          r.id,
        ).run(),
        /redemption_immutable/,
      );
      assert.equal((await redeem(input(v, await booking()))).status, 201);
    },
  );
  await t.test(
    "a preview prepared before voucher use cannot send the old full entitlement afterwards",
    async () => {
      const v = await gift(),
        a = await booking();
      const previewResponse = await request(
        "/sales/vouchers/" + v.id + "/email-preview",
        "POST",
        { recipientEmail: "recipient@example.test", subject: "Your gift" },
      );
      assert.equal(previewResponse.status, 200);
      const preview = previewResponse.data;
      assert.equal((await redeem(input(v, a, 100000))).status, 201);
      assert.equal(
        (
          await request("/sales/vouchers/" + v.id + "/email-preview", "POST", {
            recipientEmail: "recipient@example.test",
            subject: "Your gift",
          })
        ).status,
        409,
      );
      let sends = 0;
      await assert.rejects(
        sendDelivery(
          db,
          {
            EMAIL_ENABLED: "true",
            RESEND_API_KEY: "test-only",
            RESEND_WEBHOOK_SECRET: "test-only",
          },
          { id: "owner" },
          preview.delivery.id,
          async () => {
            sends++;
            return Response.json({ id: "unused" });
          },
        ),
        /already been used/,
      );
      assert.equal(sends, 0);
      assert.equal(
        (await request("/sales/deliveries/" + preview.delivery.id)).status,
        200,
      );
    },
  );
  const changeInput = (v, kind = "void", extra = {}) => ({
    requestId: randomUUID(),
    kind,
    expectedRemainingCents: v.remainingCents,
    reason: "Duplicate entry",
    confirmed: true,
    noPaymentConfirmed: true,
    refundPaidConfirmed: true,
    paymentMethod: "cash",
    paymentReference: "return-123",
    ...extra,
  });
  const change = (v, body, role = "owner", headers = {}) =>
    request(`/sales/vouchers/${v.id}/change`, "POST", body, role, headers);
  await t.test(
    "voucher changes migrate repeatedly and require owner, CSRF and explicit refund/void confirmation",
    async () => {
      assert.equal(
        await readFile("migrations/0005_voucher_changes.sql", "utf8"),
        VOUCHER_CHANGE_SCHEMA.map((s) => s + ";").join("\n\n") + "\n",
      );
      for (const statement of statements(
        await readFile("migrations/0005_voucher_changes.sql", "utf8"),
      ))
        await db.prepare(statement).run();
      await db.batch(VOUCHER_CHANGE_SCHEMA.map((s) => db.prepare(s)));
      const v = await gift();
      for (const role of ["anonymous", "reception", "therapist"]) {
        assert.equal(
          (await change(v, changeInput(v), role)).status,
          role === "anonymous" ? 401 : 403,
        );
        assert.equal(
          (
            await request(
              `/sales/vouchers/${v.id}/correction-preview`,
              "POST",
              {},
              role,
            )
          ).status,
          role === "anonymous" ? 401 : 403,
        );
      }
      assert.equal(
        (await change(v, changeInput(v), "owner", { "x-csrf-token": "bad" }))
          .status,
        403,
      );
      for (const body of [
        changeInput(v, "void", { noPaymentConfirmed: false }),
        changeInput(v, "refund", { refundPaidConfirmed: false }),
        changeInput(v, "refund", { paymentMethod: "invalid" }),
        changeInput(v, "void", { reason: "x" }),
        changeInput(v, "void", { confirmed: false }),
      ])
        assert.equal((await change(v, body)).status, 400);
      assert.equal(
        (await change(v, changeInput(v, "void", { expectedRemainingCents: 1 })))
          .status,
        409,
      );
      assert.equal((await lookup(v)).status, "issued");
    },
  );
  await t.test(
    "void excludes net sales, preserves all-record CSV/history and stops voucher use/email",
    async () => {
      const v = await gift(),
        body = changeInput(v, "void", { reason: "=Duplicate sale" });
      const email = (
        await request(`/sales/vouchers/${v.id}/email-preview`, "POST", {
          recipientEmail: "gift@example.test",
          subject: "Your gift",
        })
      ).data;
      const results = await Promise.all([change(v, body), change(v, body)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
      assert.equal(results[0].data.changeId, results[1].data.changeId);
      assert.equal(
        (await change(v, { ...body, reason: "Different reason" })).status,
        409,
      );
      const closed = await lookup(v);
      assert.equal(closed.status, "voided");
      assert.equal(closed.remainingCents, 0);
      assert.equal(closed.netSaleCents, 0);
      const net = (await request("/sales/vouchers?q=" + v.code)).data;
      assert.equal(net.count, 0);
      assert.equal(net.totalCents, 0);
      assert.equal(net.voidedCents, v.priceCents);
      const all = (await request("/sales/vouchers?view=all&q=" + v.code)).data;
      assert.equal(all.count, 1);
      assert.equal(all.vouchers[0].closure.reason, body.reason);
      assert.equal(all.originalCents, v.priceCents);
      const csv = await (
        await raw("/sales/vouchers.csv?view=all&q=" + v.code)
      ).text();
      assert.match(csv, /Voided value/);
      assert.ok(csv.includes("'=Duplicate sale"));
      assert.ok(
        !(await (await raw("/sales/vouchers.csv?q=" + v.code)).text()).includes(
          v.code,
        ),
      );
      const order = (await request("/sales/orders/" + v.saleId)).data.sale;
      assert.equal(order.totalCents, v.priceCents);
      assert.equal(order.netCents, 0);
      assert.equal(order.voidedCents, v.priceCents);
      assert.match(
        await (await raw(`/sales/vouchers/${v.id}/print`)).text(),
        /VOID — not valid/,
      );
      assert.equal((await redeem(input(v, await booking()))).status, 409);
      assert.equal(
        (
          await request(`/sales/vouchers/${v.id}/email-preview`, "POST", {
            recipientEmail: "new@example.test",
            subject: "gift",
          })
        ).status,
        409,
      );
      assert.equal(
        (await request("/sales/deliveries/" + email.delivery.id)).data.delivery
          .canSend,
        false,
      );
      let sends = 0;
      await assert.rejects(
        sendDelivery(
          db,
          {
            EMAIL_ENABLED: "true",
            RESEND_API_KEY: "test-only",
            RESEND_WEBHOOK_SECRET: "test-only",
          },
          { id: "owner" },
          email.delivery.id,
          async () => {
            sends++;
            return Response.json({ id: "unused" });
          },
        ),
        /voided|refunded|replaced/,
      );
      assert.equal(sends, 0);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM audit_log WHERE action='voucher_void' AND entity_id=?",
            v.id,
          ).first()
        ).n,
        1,
      );
      await assert.rejects(
        sql("DELETE FROM voucher_changes WHERE voucher_id=?", v.id).run(),
        /voucher_change_immutable/,
      );
      await assert.rejects(
        sql(
          "UPDATE voucher_changes SET reason='altered' WHERE voucher_id=?",
          v.id,
        ).run(),
        /voucher_change_immutable/,
      );
    },
  );
  await t.test(
    "refund closes only remaining value, retains earned value and cannot restore a refunded balance",
    async () => {
      const v = await gift(),
        a = await booking(),
        use = input(v, a, 170000);
      const reportPath =
        "/reports/appointments?from=" + a.date + "&to=" + a.date;
      const before = (await request(reportPath)).data;
      const useResult = await redeem(use);
      assert.equal(useResult.status, 201);
      const partial = await lookup(v);
      assert.equal(partial.remainingCents, 300000);
      assert.equal(
        (await change(partial, changeInput(partial, "void"))).status,
        409,
      );
      const body = changeInput(partial, "refund", {
        reason: "Customer cancelled unused balance",
      });
      const result = await change(partial, body);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal((await change(partial, body)).status, 200);
      const closed = await lookup(v);
      assert.equal(closed.netSaleCents, 170000);
      assert.equal(closed.remainingCents, 0);
      assert.equal(closed.status, "refunded");
      assert.equal(closed.closure.amountCents, 300000);
      const register = (await request("/sales/vouchers?q=" + v.code)).data;
      assert.equal(register.count, 1);
      assert.equal(register.totalCents, 170000);
      assert.equal(register.refundedCents, 300000);
      const history = (await request("/sales/vouchers/" + v.id)).data
        .redemptions;
      assert.equal((await reverse(history[0].id)).status, 409);
      assert.equal((await redeem(use)).status, 200);
      assert.equal((await lookup(v)).remainingCents, 0);
      assert.deepEqual((await request(reportPath)).data, before);
      const unused = await gift();
      assert.equal(
        (await change(unused, changeInput(unused, "refund"))).status,
        201,
      );
      assert.equal(
        (await request("/sales/vouchers?q=" + unused.code)).data.count,
        0,
      );
      assert.match(
        await (await raw(`/sales/vouchers/${unused.id}/print`)).text(),
        /REFUNDED — not valid/,
      );
    },
  );
  await t.test(
    "simultaneous voucher use and closure has one winner; no overspend or double refund",
    async () => {
      for (const kind of ["void", "refund", "replaced"]) {
        const v = await gift(),
          a = await booking();
        const details = {
          recipientName: "Correct name",
          senderName: "",
          message: "",
          expiresOn: null,
          design: DEFAULT_DESIGN,
        };
        const results = await Promise.all([
          redeem(input(v, a)),
          change(v, changeInput(v, kind, { details })),
        ]);
        assert.deepEqual(
          results.map((r) => r.status).sort(),
          [201, 409],
          JSON.stringify(results),
        );
      }
      const v = await gift();
      const results = await Promise.all([
        change(v, changeInput(v, "refund")),
        change(v, changeInput(v, "void")),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM voucher_changes WHERE voucher_id=?",
            v.id,
          ).first()
        ).n,
        1,
      );
    },
  );
  await t.test(
    "corrected vouchers retain archived treatment/value, replace the code once and reconcile a replacement chain",
    async () => {
      const v = await gift("treatment", 470000, { serviceId: secondServiceId });
      await sql(
        "UPDATE services SET version=2,active=0,price_cents=590000 WHERE id=?",
        secondServiceId,
      ).run();
      const details = {
        recipientName: "Correct recipient",
        senderName: "Sender",
        message: "<script>no</script>",
        expiresOn: null,
        design: { ...DEFAULT_DESIGN, theme: "forest" },
        priceCents: 1,
        serviceId: "wrong",
      };
      const preview = await request(
        `/sales/vouchers/${v.id}/correction-preview`,
        "POST",
        { details },
      );
      assert.equal(preview.status, 200);
      assert.match(preview.data.html, /Correct recipient/);
      assert.ok(!preview.data.html.includes("<script>no</script>"));
      const body = changeInput(v, "replaced", {
        reason: "Name and design corrected",
        details,
      });
      const results = await Promise.all([change(v, body), change(v, body)]);
      assert.deepEqual(
        results.map((r) => r.status).sort(),
        [200, 201],
        JSON.stringify(results),
      );
      const id = results[0].data.replacementId;
      assert.ok(id);
      assert.equal(id, results[1].data.replacementId);
      const original = await lookup(v);
      assert.equal(original.status, "replaced");
      assert.equal(original.remainingCents, 0);
      const next = (await request("/sales/vouchers/" + id)).data.voucher;
      assert.notEqual(next.code, v.code);
      assert.equal(next.saleId, v.saleId);
      assert.equal(next.replacesId, v.id);
      assert.equal(next.priceCents, 470000);
      assert.equal(next.serviceId, secondServiceId);
      assert.equal(next.recipientName, details.recipientName);
      assert.equal(next.design.theme, "forest");
      assert.equal(
        (await request("/sales/orders/" + v.saleId)).data.sale.netCents,
        470000,
      );
      assert.equal(
        (await redeem(input(v, await booking({ serviceId })))).status,
        409,
      );
      assert.equal(
        (
          await sql(
            "SELECT recipient_name FROM gift_vouchers WHERE id=?",
            v.id,
          ).first()
        ).recipient_name,
        v.recipientName,
      );
      const second = await change(
        next,
        changeInput(next, "replaced", {
          details: { ...details, recipientName: "Final name" },
        }),
      );
      assert.equal(second.status, 201);
      const final = (
        await request("/sales/vouchers/" + second.data.replacementId)
      ).data.voucher;
      assert.equal(
        (await change(final, changeInput(final, "refund"))).status,
        201,
      );
      const sale = (await request("/sales/orders/" + v.saleId)).data.sale;
      assert.equal(sale.totalCents, 470000);
      assert.equal(sale.netCents, 0);
      assert.equal(sale.refundedCents, 470000);
      assert.equal(sale.vouchers.length, 3);
      assert.equal((await change(v, body)).status, 200);
    },
  );
});
