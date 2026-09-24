import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { digest, token } from "../src/security.mjs";
import { SALES_SCHEMA } from "../src/sales-schema.mjs";
import { DEFAULT_DESIGN } from "../src/voucher-render.mjs";
import { sendDelivery, verifyWebhook } from "../src/voucher-email.mjs";

const ORIGIN = "https://rei-sales.example",
  SECRET =
    "whsec_" +
    Buffer.from("fictional-webhook-secret-for-tests").toString("base64");
function statements(sql) {
  const out = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
    const s = current.trim();
    if (
      s.startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    if (s) out.push(s);
    current = "";
  }
  assert.equal(current.trim(), "");
  return out;
}
test("voucher signature verification matches the published Svix vector and rejects changes/replay", () => {
  const raw = '{"event_type":"ping","data":{"success":true}}',
    headers = new Headers({
      "svix-id": "msg_loFOjxBNrRLzqYUf",
      "svix-timestamp": "1731705121",
      "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
    });
  const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
  assert.equal(
    verifyWebhook(raw, headers, secret, 1731705121000).data.event_type,
    "ping",
  );
  assert.throws(() => verifyWebhook(raw + " ", headers, secret, 1731705121000));
  assert.throws(() => verifyWebhook(raw, headers, secret, 1731705500000));
});

test("Sales Worker + D1: atomic checkout, immutable gifts and independently addressed email", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        "worker.mjs",
        "security.mjs",
        "domain.mjs",
        "reports.mjs",
        "report-schema.mjs",
        "sales.mjs",
        "sales-schema.mjs",
        "redemption-schema.mjs",
        "voucher-redemption.mjs",
        "voucher-render.mjs",
        "voucher-email.mjs",
      ].map((f) => ({ type: "ESModule", path: resolve("src", f) })),
      modulesRoot: resolve("src"),
      compatibilityDate: "2026-09-22",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        APP_ORIGIN: ORIGIN,
        APP_ENV: "test",
        RESEND_WEBHOOK_SECRET: SECRET,
      },
      d1Databases: { DB: "sales-integration" },
      log: new Log(LogLevel.ERROR),
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const sql of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(sql).run();
  const sessions = {};
  for (const role of ["owner", "reception", "therapist"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { cookie: "__Host-rei_session=" + raw, csrf };
    await db
      .prepare(
        "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        role,
        role + "@example.test",
        role,
        "unused-test-hash",
        role === "therapist" ? "reception" : role,
        new Date().toISOString(),
      )
      .run();
    await db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(
        digest(raw),
        role,
        csrf,
        Date.now() + 3600000,
        new Date().toISOString(),
      )
      .run();
  }
  async function rawRequest(
    path,
    role = "owner",
    method = "GET",
    body,
    extra = {},
  ) {
    const session = sessions[role];
    return mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function request(...args) {
    const r = await rawRequest(...args);
    return { status: r.status, data: await r.json() };
  }
  let serviceId, buyerId, voucherId, saleId, template;
  const item = (extra = {}) => ({
    kind: "treatment",
    serviceId,
    serviceVersion: 1,
    priceCents: 590000,
    recipientName: "Gift recipient",
    senderName: "A friend",
    message: "Enjoy <your> time & relax",
    expiresOn: null,
    design: { ...DEFAULT_DESIGN },
    ...extra,
  });
  const payload = (extra = {}) => ({
    requestId: randomUUID(),
    items: [item()],
    buyerId,
    paymentMethod: "card",
    paymentReference: "Card terminal 123",
    paymentConfirmed: true,
    ...extra,
  });
  await t.test(
    "schema initializes automatically, settings version checks and permissions",
    async () => {
      const settings = await request("/sales/settings");
      assert.equal(settings.status, 200);
      assert.equal(settings.data.emailReady, false);
      assert.equal((await request("/sales/settings", "nobody")).status, 401);
      assert.equal((await request("/sales/settings", "reception")).status, 403);
      const body = {
        version: 0,
        design: { ...DEFAULT_DESIGN, title: "First saved design" },
      };
      assert.equal(
        (await request("/sales/settings", "owner", "PUT", body)).status,
        200,
      );
      assert.equal(
        (await request("/sales/settings", "owner", "PUT", body)).status,
        409,
      );
      template = (await request("/sales/settings")).data;
      assert.equal(template.version, 1);
      assert.equal(
        (
          await request("/sales/settings", "owner", "PUT", {
            ...body,
            version: 1,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action='update_template'",
            )
            .first()
        ).n,
        2,
      );
      const migration = await readFile("migrations/0003_sales.sql", "utf8");
      assert.equal(
        migration,
        SALES_SCHEMA.map((s) => s + ";").join("\n\n") + "\n",
      );
      await db.batch(SALES_SCHEMA.map((sql) => db.prepare(sql)));
    },
  );
  await t.test(
    "create menu and optional buyer without triggering delivery",
    async () => {
      const service = await request("/services", "owner", "POST", {
        name: "Test Rei Combination",
        duration: 90,
        priceCents: 590000,
        color: "#d7bb81",
      });
      assert.equal(service.status, 201);
      serviceId = service.data.id;
      const buyer = await request("/clients", "owner", "POST", {
        name: "=Formula buyer",
        phone: "+381600000090",
        email: "buyer@example.test",
      });
      assert.equal(buyer.status, 201);
      buyerId = buyer.data.id;
      assert.equal(
        (
          await request(
            "/sales/checkout",
            "owner",
            "POST",
            payload({ paymentConfirmed: false }),
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            "/sales/checkout",
            "owner",
            "POST",
            payload({ items: [item({ expiresOn: undefined })] }),
          )
        ).status,
        400,
      );
      const sale = await request(
        "/sales/checkout",
        "owner",
        "POST",
        payload({
          items: [
            item(),
            item({
              kind: "amount",
              priceCents: 150050,
              recipientName: "Someone else",
            }),
          ],
        }),
      );
      assert.equal(sale.status, 201, JSON.stringify(sale.data));
      saleId = sale.data.sale.id;
      voucherId = sale.data.sale.vouchers.find(
        (v) => v.kind === "treatment",
      ).id;
      assert.equal(sale.data.sale.totalCents, 740050);
      assert.equal(sale.data.sale.vouchers.length, 2);
      assert.equal(new Set(sale.data.sale.vouchers.map((v) => v.code)).size, 2);
      assert.equal(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM voucher_deliveries")
            .first()
        ).n,
        0,
      );
      const detail = (await request("/sales/vouchers/" + voucherId)).data;
      assert.doesNotMatch(
        detail.preview.html,
        /buyer@example|Formula buyer|<your>/,
      );
      assert.match(detail.preview.html, /&lt;your&gt;/);
      assert.equal(detail.voucher.design.showPrice, false);
    },
  );
  await t.test(
    "concurrent retries return one sale and one new client; changed retry rejects",
    async () => {
      const body = payload({
        buyerId: null,
        newBuyer: { name: "Atomic new buyer", phone: "+381600000099" },
      });
      const results = await Promise.all([
        request("/sales/checkout", "owner", "POST", body),
        request("/sales/checkout", "owner", "POST", body),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
      assert.equal(results[0].data.sale.id, results[1].data.sale.id);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM clients WHERE name='Atomic new buyer'",
            )
            .first()
        ).n,
        1,
      );
      assert.equal(
        (
          await request("/sales/checkout", "owner", "POST", {
            ...body,
            paymentMethod: "cash",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action='complete_sale'",
            )
            .first()
        ).n,
        2,
      );
      const original = results[0].data.sale;
      await db
        .prepare(
          "UPDATE services SET name='Changed menu',duration=60,price_cents=999000,version=2 WHERE id=?",
        )
        .bind(serviceId)
        .run();
      const replay = await request("/sales/checkout", "owner", "POST", body);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.sale.id, original.id);
      const rejected = await request(
        "/sales/checkout",
        "owner",
        "POST",
        payload({ buyerId: null, newBuyer: { name: "Must not be created" } }),
      );
      assert.equal(rejected.status, 409);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM clients WHERE name='Must not be created'",
            )
            .first()
        ).n,
        0,
      );
      const v = (await request("/sales/vouchers/" + voucherId)).data.voucher;
      assert.equal(v.serviceName, "Test Rei Combination");
      assert.equal(v.duration, 90);
      assert.equal(v.priceCents, 590000);
      await assert.rejects(
        db
          .prepare("UPDATE gift_vouchers SET price_cents=1 WHERE id=?")
          .bind(voucherId)
          .run(),
        /issued_voucher_immutable/,
      );
      await assert.rejects(
        db.prepare("DELETE FROM sales WHERE id=?").bind(saleId).run(),
        /completed_sale_immutable/,
      );
      // Catch a menu change after the application read; roll back the staged buyer.
      await assert.rejects(
        db.batch([
          db.prepare(
            "INSERT INTO clients(id,name,created_at,updated_at) VALUES('rollback-buyer','Rollback buyer','2030-01-01','2030-01-01')",
          ),
          db
            .prepare(
              `INSERT INTO gift_vouchers SELECT 'stale-gift',sale_id,'STALE-CODE',kind,service_id,service_version,service_name,duration,price_cents,recipient_name,sender_name,message,expires_on,design_json,issued_at FROM gift_vouchers WHERE id=?`,
            )
            .bind(voucherId),
        ]),
        /voucher_treatment_changed/,
      );
      assert.equal(
        await db
          .prepare("SELECT id FROM clients WHERE id='rollback-buyer'")
          .first(),
        null,
      );
    },
  );
  await t.test(
    "sold register, formula-safe CSV, print and reports preserve role boundaries",
    async () => {
      const list = await request("/sales/vouchers?q=Formula");
      assert.equal(list.data.count, 2);
      assert.equal(list.data.totalCents, 740050);
      const csv = await rawRequest("/sales/vouchers.csv?q=Formula");
      assert.equal(csv.status, 200);
      assert.match(await csv.text(), /"'=Formula buyer"/);
      const printed = await rawRequest(`/sales/vouchers/${voucherId}/print`);
      assert.equal(printed.status, 200);
      assert.match(await printed.text(), /Print \/ Save as PDF/);
      const before = await request("/reports/appointments?preset=last30");
      assert.equal(before.data.totals.revenueCents, 0);
      // A therapist fixture must be active to authenticate before the Sales permission check.
      const therapist = await request("/therapists", "owner", "POST", {
        name: "Test therapist",
      });
      await db
        .prepare(
          "UPDATE users SET therapist_id=?,role='therapist' WHERE id='therapist'",
        )
        .bind(therapist.data.id)
        .run();
      for (const role of ["reception", "therapist"])
        for (const path of [
          "/sales/settings",
          "/sales/vouchers",
          "/sales/vouchers.csv",
          `/sales/vouchers/${voucherId}/print`,
          `/sales/orders/${saleId}`,
        ])
          assert.equal((await rawRequest(path, role)).status, 403);
      assert.equal(
        (
          await request("/sales/checkout", "owner", "POST", payload(), {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
    },
  );
  let deliveryId;
  await t.test(
    "email preview has explicit recipient, immutable payload and no implicit buyer copy",
    async () => {
      const path = `/sales/vouchers/${voucherId}/email-preview`,
        body = {
          recipientEmail: "gift@example.test",
          subject: "A private gift",
        };
      const first = await request(path, "owner", "POST", body);
      assert.equal(first.status, 200, JSON.stringify(first.data));
      deliveryId = first.data.delivery.id;
      assert.equal(
        (await request(path, "owner", "POST", body)).data.delivery.id,
        deliveryId,
      );
      assert.equal(
        (await request(path, "owner", "POST", { ...body, subject: "Changed" }))
          .status,
        409,
      );
      const row = await db
          .prepare("SELECT * FROM voucher_deliveries WHERE id=?")
          .bind(deliveryId)
          .first(),
        saved = JSON.parse(row.payload_json);
      assert.deepEqual(saved.to, ["gift@example.test"]);
      assert.equal(
        saved.from,
        "Rei Thailand Massage <info@reithailandmassage.com>",
      );
      assert.equal(saved.cc, undefined);
      assert.equal(saved.bcc, undefined);
      assert.doesNotMatch(row.payload_json, /buyer@example/);
      assert.equal(
        (
          await request(path, "owner", "POST", {
            ...body,
            recipientEmail: "one@example.test,two@example.test",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            `/sales/deliveries/${deliveryId}/send`,
            "owner",
            "POST",
            {},
          )
        ).status,
        503,
      );
      assert.equal(
        (await request(path, "reception", "POST", body)).status,
        403,
      );
    },
  );
  const live = {
      EMAIL_ENABLED: "true",
      RESEND_API_KEY: "fictional-key-never-sent",
      RESEND_WEBHOOK_SECRET: SECRET,
    },
    user = { id: "owner" };
  const webhook = async (
    type,
    providerId,
    id = randomUUID(),
    timestamp = Math.floor(Date.now() / 1000),
  ) => {
    const raw = JSON.stringify({
      type,
      created_at: new Date().toISOString(),
      data: { email_id: providerId },
    });
    const signature = createHmac(
      "sha256",
      Buffer.from(SECRET.slice(6), "base64"),
    )
      .update(`${id}.${timestamp}.${raw}`)
      .digest("base64");
    return mf.dispatchFetch(ORIGIN + "/api/email/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": String(timestamp),
        "svix-signature": "v1," + signature,
      },
      body: raw,
    });
  };
  await t.test(
    "email claim is atomic; accepted means accepted, signed callbacks control delivery",
    async () => {
      let calls = 0;
      const transport = async (url, options) => {
        calls++;
        assert.equal(url, "https://api.resend.com/emails");
        assert.equal(
          options.headers["Idempotency-Key"],
          "rei-voucher/" + deliveryId,
        );
        assert.deepEqual(JSON.parse(options.body).to, ["gift@example.test"]);
        return Response.json({ id: "provider-one" });
      };
      await Promise.all([
        sendDelivery(db, live, user, deliveryId, transport),
        sendDelivery(db, live, user, deliveryId, transport),
      ]);
      assert.equal(calls, 1);
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM voucher_deliveries WHERE id=?")
            .bind(deliveryId)
            .first()
        ).status,
        "accepted",
      );
      assert.equal(
        (await sendDelivery(db, live, user, deliveryId, transport)).status,
        "accepted",
      );
      assert.equal(calls, 1);
      assert.equal(
        (await webhook("email.delivered", "provider-one")).status,
        200,
      );
      assert.equal((await webhook("email.sent", "provider-one")).status, 200);
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM voucher_deliveries WHERE id=?")
            .bind(deliveryId)
            .first()
        ).status,
        "delivered",
      );
      const eventId = randomUUID();
      await webhook("email.bounced", "provider-one", eventId);
      await webhook("email.bounced", "provider-one", eventId);
      const history = await request("/sales/deliveries/" + deliveryId);
      assert.equal(history.status, 200);
      assert.equal(history.data.delivery.status, "bounced");
      assert.match(history.data.preview.text, /Test Rei Combination/);
      assert.equal(
        (await request("/sales/deliveries/" + deliveryId, "reception")).status,
        403,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM email_events WHERE id=?")
            .bind(eventId)
            .first()
        ).n,
        1,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM voucher_deliveries WHERE id=?")
            .bind(deliveryId)
            .first()
        ).status,
        "bounced",
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM email_suppressions WHERE recipient='gift@example.test'",
            )
            .first()
        ).n,
        1,
      );
      assert.equal(
        (
          await webhook(
            "email.sent",
            "provider-one",
            randomUUID(),
            Math.floor(Date.now() / 1000) - 3600,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await rawRequest("/email/webhook", "nobody", "POST", {
            type: "email.delivered",
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "network retry reuses exact payload/key, never resends after provider idempotency expiry",
    async () => {
      const d = (
        await request(
          `/sales/vouchers/${voucherId}/email-preview`,
          "owner",
          "POST",
          { recipientEmail: "retry@example.test", subject: "Retry gift" },
        )
      ).data.delivery;
      let firstBody, firstKey;
      const uncertain = await sendDelivery(
        db,
        live,
        user,
        d.id,
        async (url, options) => {
          firstBody = options.body;
          firstKey = options.headers["Idempotency-Key"];
          throw new Error("simulated network loss");
        },
      );
      assert.equal(uncertain.status, "retry");
      await db
        .prepare("UPDATE voucher_deliveries SET next_attempt_at=0 WHERE id=?")
        .bind(d.id)
        .run();
      // A callback can arrive before the API response is recorded.
      await webhook("email.delivered", "provider-retry");
      const retried = await sendDelivery(
        db,
        live,
        user,
        d.id,
        async (url, options) => {
          assert.equal(options.body, firstBody);
          assert.equal(options.headers["Idempotency-Key"], firstKey);
          return Response.json({ id: "provider-retry" });
        },
      );
      assert.equal(retried.status, "delivered");
      const stale = (
        await request(
          `/sales/vouchers/${voucherId}/email-preview`,
          "owner",
          "POST",
          { recipientEmail: "uncertain@example.test", subject: "Needs review" },
        )
      ).data.delivery;
      await db
        .prepare(
          "UPDATE voucher_deliveries SET status='retry',first_attempt_at=? WHERE id=?",
        )
        .bind(Date.now() - 24 * 3600000, stale.id)
        .run();
      await assert.rejects(
        sendDelivery(db, live, user, stale.id, () => {
          throw new Error("must never send");
        }),
        /retry window ended/,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM voucher_deliveries WHERE id=?")
            .bind(stale.id)
            .first()
        ).status,
        "uncertain",
      );
    },
  );
});
