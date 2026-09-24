import { randomUUID, randomBytes } from "node:crypto";
import { fail, digest, requireRole, readJSON } from "./security.mjs";
import { text, integer, isoDate, clientInput } from "./domain.mjs";
import { belgradeToday } from "./reports.mjs";
import { ensureSalesSchema } from "./sales-schema.mjs";
import { ensureVoucherChangeSchema } from "./voucher-change-schema.mjs";
import { changeVoucher, correctionDetails } from "./voucher-changes.mjs";
import { ensureRedemptionSchema } from "./redemption-schema.mjs";
import {
  redeemVoucher,
  reverseRedemption,
  redemptionHistory,
  redemptionAppointment,
  redemptionAppointments,
} from "./voucher-redemption.mjs";
import { DEFAULT_DESIGN, voucherContent } from "./voucher-render.mjs";
import {
  emailReady,
  prepareDelivery,
  sendDelivery,
  deliveryView,
} from "./voucher-email.mjs";

export const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => statement(db, sql, ...args).first();
const all = async (db, sql, ...args) =>
  (await statement(db, sql, ...args).all()).results;
const now = () => new Date().toISOString();
export function designInput(input) {
  if (
    !input ||
    !["ivory", "forest"].includes(input.theme) ||
    !["classic", "letter"].includes(input.layout) ||
    typeof input.showPrice !== "boolean"
  )
    fail(400, "Choose a voucher design.");
  return {
    theme: input.theme,
    layout: input.layout,
    title: text(input.title, 100, "voucher title"),
    terms: text(input.terms || "", 1000, "voucher terms", true),
    showPrice: input.showPrice,
  };
}
function itemInput(item) {
  if (!item || !["treatment", "amount"].includes(item.kind))
    fail(400, "Choose a voucher type.");
  if (item.expiresOn !== null && typeof item.expiresOn !== "string")
    fail(400, "Choose a validity date or explicitly select no expiry.");
  const expiresOn = item.expiresOn === null ? null : isoDate(item.expiresOn);
  return {
    kind: item.kind,
    serviceId:
      item.kind === "treatment" ? text(item.serviceId, 100, "treatment") : null,
    serviceVersion:
      item.kind === "treatment"
        ? integer(item.serviceVersion, 1, 100000000, "treatment version")
        : null,
    priceCents: integer(item.priceCents, 1, 100000000, "voucher price"),
    recipientName: text(item.recipientName || "", 100, "recipient name", true),
    senderName: text(item.senderName || "", 100, "gift sender", true),
    message: text(item.message || "", 1000, "gift message", true),
    expiresOn,
    design: designInput(item.design),
  };
}
function saleInput(body) {
  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > 20
  )
    fail(400, "Add between 1 and 20 vouchers.");
  const items = body.items.map(itemInput);
  if (body.buyerId && body.newBuyer)
    fail(400, "Choose an existing buyer or add a new one.");
  const buyerId = body.buyerId ? text(body.buyerId, 100, "buyer") : null;
  const newBuyer = body.newBuyer ? clientInput(body.newBuyer) : null;
  if (!["cash", "card", "bank_transfer", "other"].includes(body.paymentMethod))
    fail(400, "Choose a payment method.");
  if (body.paymentConfirmed !== true)
    fail(400, "Confirm that payment has been received.");
  const requestId = text(body.requestId, 100, "checkout identifier");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))
    fail(400, "Start a new checkout.");
  return {
    requestId,
    buyerId,
    newBuyer,
    items,
    paymentMethod: body.paymentMethod,
    paymentReference: text(
      body.paymentReference || "",
      120,
      "payment reference",
      true,
    ),
  };
}
async function hydrateItem(db, item) {
  if (item.expiresOn && item.expiresOn < belgradeToday())
    fail(400, "A new voucher cannot already be expired.");
  const s =
    item.kind === "treatment"
      ? await one(db, "SELECT * FROM services WHERE id=?", item.serviceId)
      : null;
  if (
    item.kind === "treatment" &&
    (!s?.active ||
      s.version !== item.serviceVersion ||
      s.price_cents !== item.priceCents)
  )
    fail(
      409,
      "This treatment or price changed. Refresh Treatments and add it to the cart again.",
    );
  return {
    ...item,
    serviceName: s?.name || "Custom amount",
    duration: s?.duration || null,
  };
}
export function voucherView(row) {
  return {
    id: row.id,
    saleId: row.sale_id,
    code: row.code,
    kind: row.kind,
    serviceId: row.service_id,
    serviceName: row.service_name,
    duration: row.duration,
    priceCents: row.price_cents,
    usedCents: row.used_cents || 0,
    remainingCents:
      row.available_cents ?? row.remaining_cents ?? row.price_cents,
    netSaleCents: row.net_sale_cents ?? row.price_cents,
    replacesId: row.replaces_id || null,
    closure: row.closure_kind
      ? {
          kind: row.closure_kind,
          amountCents: row.closure_amount_cents,
          reason: row.closure_reason,
          createdAt: row.closed_at,
          createdBy: row.closed_by,
          paymentMethod: row.refund_method,
          paymentReference: row.refund_reference,
          replacementId: row.replacement_id || null,
        }
      : null,
    recipientName: row.recipient_name,
    senderName: row.sender_name,
    message: row.message,
    expiresOn: row.expires_on,
    design: JSON.parse(row.design_json),
    issuedAt: row.issued_at,
    status: row.closure_kind
      ? { void: "voided", refund: "refunded", replaced: "replaced" }[
          row.closure_kind
        ]
      : row.remaining_cents === 0
        ? "redeemed"
        : row.expires_on && row.expires_on < belgradeToday()
          ? "expired"
          : row.used_cents > 0
            ? "partially_redeemed"
            : "issued",
  };
}
async function saleDetail(db, id) {
  const sale = await one(db, "SELECT * FROM sales WHERE id=?", id);
  if (!sale) fail(404, "Sale not found.");
  const vouchers = await all(
    db,
    "SELECT * FROM voucher_register WHERE sale_id=? ORDER BY id",
    id,
  );
  return {
    sale: {
      id: sale.id,
      reference: sale.reference,
      buyerId: sale.buyer_id,
      buyerName: sale.buyer_name,
      buyerEmail: sale.buyer_email,
      paymentMethod: sale.payment_method,
      paymentReference: sale.payment_reference,
      totalCents: sale.total_cents,
      netCents: vouchers.reduce((sum, v) => sum + v.net_sale_cents, 0),
      voidedCents: vouchers.reduce(
        (sum, v) =>
          sum + (v.closure_kind === "void" ? v.closure_amount_cents : 0),
        0,
      ),
      refundedCents: vouchers.reduce(
        (sum, v) =>
          sum + (v.closure_kind === "refund" ? v.closure_amount_cents : 0),
        0,
      ),
      createdAt: sale.created_at,
      vouchers: vouchers.map(voucherView),
    },
  };
}
export async function checkout(db, user, body) {
  const input = saleInput(body),
    requestHash = digest(JSON.stringify(input));
  const existing = await one(
    db,
    "SELECT id,request_hash FROM sales WHERE request_id=?",
    input.requestId,
  );
  if (existing) {
    if (existing.request_hash !== requestHash)
      fail(
        409,
        "This checkout was already completed with different contents. Start a new sale.",
      );
    return { ...(await saleDetail(db, existing.id)), replayed: true };
  }
  const items = await Promise.all(input.items.map((i) => hydrateItem(db, i)));
  const total = integer(
    items.reduce((sum, i) => sum + i.priceCents, 0),
    1,
    100000000,
    "sale total",
  );
  const buyer = input.newBuyer
    ? { ...input.newBuyer, id: randomUUID() }
    : input.buyerId
      ? await one(db, "SELECT * FROM clients WHERE id=?", input.buyerId)
      : null;
  if (input.buyerId && !buyer)
    fail(400, "The selected buyer no longer exists.");
  const id = randomUUID(),
    time = now(),
    reference = "REI-S-" + randomBytes(6).toString("hex").toUpperCase();
  const queries = [];
  if (input.newBuyer)
    queries.push(
      statement(
        db,
        "INSERT INTO clients(id,name,phone,phone_key,email,email_key,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        buyer.id,
        buyer.name,
        buyer.phone,
        buyer.phone_key,
        buyer.email,
        buyer.email_key,
        buyer.note,
        time,
        time,
      ),
    );
  queries.push(
    statement(
      db,
      `INSERT INTO sales(id,reference,request_id,request_hash,buyer_id,buyer_name,buyer_email,payment_method,payment_reference,total_cents,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      reference,
      input.requestId,
      requestHash,
      buyer?.id || null,
      buyer?.name || "",
      buyer?.email || "",
      input.paymentMethod,
      input.paymentReference,
      total,
      user.id,
      time,
    ),
  );
  for (const item of items) {
    const code =
      "REI-" +
      randomBytes(12).toString("hex").toUpperCase().match(/.{4}/g).join("-");
    queries.push(
      statement(
        db,
        `INSERT INTO gift_vouchers(id,sale_id,code,kind,service_id,service_version,service_name,duration,price_cents,recipient_name,sender_name,message,expires_on,design_json,issued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        id,
        code,
        item.kind,
        item.serviceId,
        item.serviceVersion,
        item.serviceName,
        item.duration,
        item.priceCents,
        item.recipientName,
        item.senderName,
        item.message,
        item.expiresOn,
        JSON.stringify(item.design),
        time,
      ),
    );
  }
  if (input.newBuyer)
    queries.push(
      statement(
        db,
        "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(?,?,?,?,?,?)",
        user.id,
        "create",
        "clients",
        buyer.id,
        JSON.stringify({ source: "voucher_sale", saleId: id }),
        time,
      ),
    );
  queries.push(
    statement(
      db,
      "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(?,?,?,?,?,?)",
      user.id,
      "complete_sale",
      "sale",
      id,
      JSON.stringify({
        reference,
        totalCents: total,
        count: items.length,
        paymentMethod: input.paymentMethod,
      }),
      time,
    ),
  );
  try {
    await db.batch(queries);
  } catch (error) {
    // A concurrent retry may have completed after the initial lookup. Every other
    // statement (including a staged buyer) rolls back with the unique request ID.
    const replay = await one(
      db,
      "SELECT id,request_hash FROM sales WHERE request_id=?",
      input.requestId,
    );
    if (replay?.request_hash === requestHash)
      return { ...(await saleDetail(db, replay.id)), replayed: true };
    if (String(error.message).includes("voucher_treatment_changed"))
      fail(
        409,
        "A treatment changed during checkout. Refresh it and try again.",
      );
    throw error;
  }
  return { ...(await saleDetail(db, id)), replayed: false };
}
function filters(params) {
  const q = text(params.get("q") || "", 100, "search", true),
    from = params.get("from") ? isoDate(params.get("from")) : null,
    to = params.get("to") ? isoDate(params.get("to")) : null;
  if (from && to && from > to) fail(400, "End date must follow start date.");
  const view = params.get("view") || "net";
  if (!["net", "all"].includes(view))
    fail(400, "Choose Net sales or All records.");
  return { q, from, to, view };
}
async function register(db, params, exporting = false) {
  const { q, from, to, view } = filters(params),
    page = exporting
      ? 0
      : integer(Number(params.get("page") || 0), 0, 1000000, "page");
  // UTC timestamps are converted to Belgrade dates in JS so DST and sale dates agree with the UI.
  // Date conversion is applied after a bounded indexed fetch; too-large exports fail explicitly.
  const candidate = await all(
    db,
    `SELECT v.*,s.reference,s.buyer_name,s.buyer_email,s.payment_method,s.payment_reference,s.created_at AS sale_created_at
FROM voucher_register v JOIN sales s ON s.id=v.sale_id
WHERE (?='' OR v.code LIKE ? ESCAPE '\\' OR s.buyer_name LIKE ? ESCAPE '\\' OR v.recipient_name LIKE ? ESCAPE '\\')
AND (? IS NULL OR s.created_at>=datetime(?,'-1 day')) AND (? IS NULL OR s.created_at<=datetime(?,'+2 days'))
ORDER BY s.created_at DESC,v.id DESC LIMIT 10001`,
    q,
    ...Array(3).fill("%" + q.replace(/[\\%_]/g, "\\$&") + "%"),
    from,
    from,
    to,
    to,
  );
  if (candidate.length > 10000)
    fail(
      400,
      "Choose a shorter date range or more specific search (maximum 10,000 vouchers).",
    );
  const rows = candidate
    .filter((r) => {
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Belgrade",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(r.sale_created_at));
      return (!from || date >= from) && (!to || date <= to);
    })
    .map((r) => ({
      ...voucherView(r),
      reference: r.reference,
      soldAt: r.sale_created_at,
      buyerName: r.buyer_name,
      buyerEmail: r.buyer_email,
      paymentMethod: r.payment_method,
      paymentReference: r.payment_reference,
    }));
  const visible =
    view === "all" ? rows : rows.filter((v) => v.netSaleCents > 0);
  return {
    vouchers: exporting ? visible : visible.slice(page * 50, page * 50 + 50),
    count: visible.length,
    recordCount: rows.length,
    page,
    view,
    totalCents: rows.reduce((sum, r) => sum + r.netSaleCents, 0),
    originalCents: rows.reduce(
      (sum, r) => sum + (r.status === "replaced" ? 0 : r.priceCents),
      0,
    ),
    voidedCents: rows.reduce(
      (sum, r) =>
        sum + (r.closure?.kind === "void" ? r.closure.amountCents : 0),
      0,
    ),
    refundedCents: rows.reduce(
      (sum, r) =>
        sum + (r.closure?.kind === "refund" ? r.closure.amountCents : 0),
      0,
    ),
  };
}
function vouchersCSV(rows) {
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[\s]*[=+@-]/, (m) => "'" + m)
      .replace(/"/g, '""') +
    '"';
  return (
    "\uFEFF" +
    [
      [
        "Sale",
        "Sold at (UTC)",
        "Issued at (UTC)",
        "Code",
        "Buyer",
        "Recipient name",
        "Type",
        "Treatment",
        "Minutes",
        "Face value (RSD)",
        "Payment method",
        "Payment reference",
        "Expiry",
        "Status",
        "Used voucher value (RSD)",
        "Remaining voucher value (RSD)",
        "Net sale (RSD)",
        "Voided value (RSD)",
        "Refunded value (RSD)",
        "Changed at (UTC)",
        "Changed by",
        "Reason",
        "Refund method",
        "Refund reference",
        "Replacement voucher ID",
      ],
      ...rows.map((v) => [
        v.reference,
        v.soldAt,
        v.issuedAt,
        v.code,
        v.buyerName || "Walk-in",
        v.recipientName,
        v.kind,
        v.serviceName,
        v.duration,
        (v.priceCents / 100).toFixed(2),
        v.paymentMethod,
        v.paymentReference,
        v.expiresOn || "No expiry",
        v.status,
        (v.usedCents / 100).toFixed(2),
        (v.remainingCents / 100).toFixed(2),
        (v.netSaleCents / 100).toFixed(2),
        (
          (v.closure?.kind === "void" ? v.closure.amountCents : 0) / 100
        ).toFixed(2),
        (
          (v.closure?.kind === "refund" ? v.closure.amountCents : 0) / 100
        ).toFixed(2),
        v.closure?.createdAt,
        v.closure?.createdBy,
        v.closure?.reason,
        v.closure?.paymentMethod,
        v.closure?.paymentReference,
        v.closure?.replacementId,
      ]),
    ]
      .map((r) => r.map(cell).join(","))
      .join("\r\n")
  );
}
export async function salesRoutes(request, env, user) {
  requireRole(user, "owner");
  const db = env.DB,
    url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  await ensureSalesSchema(db);
  await ensureRedemptionSchema(db);
  await ensureVoucherChangeSchema(db);
  const json = (value, status = 200) => Response.json(value, { status });
  const change = path.match(
    /^\/api\/sales\/vouchers\/([^/]+)\/(change|correction-preview)$/,
  );
  if (change && method === "POST") {
    const body = await readJSON(request, 8192);
    if (change[2] === "change") {
      const result = await changeVoucher(
        db,
        user,
        change[1],
        body,
        designInput,
      );
      return json(result, result.replayed ? 200 : 201);
    }
    const row = await one(
      db,
      "SELECT * FROM voucher_register WHERE id=?",
      change[1],
    );
    if (!row) fail(404, "Voucher not found.");
    if (row.closure_kind || row.used_cents > 0)
      fail(409, "Only an unused, open voucher can be corrected.");
    return json(
      voucherContent(
        {
          ...voucherView(row),
          ...correctionDetails(row, body, designInput),
          code: "PREVIEW",
        },
        env.APP_ORIGIN,
        { preview: true },
      ),
    );
  }
  if (path === "/api/sales/voucher-lookup" && method === "GET") {
    const code = text(
      url.searchParams.get("code"),
      100,
      "voucher code",
    ).toUpperCase();
    const row = await one(
      db,
      "SELECT * FROM voucher_register WHERE code=?",
      code,
    );
    if (!row) fail(404, "Voucher not found. Check the complete code.");
    return json({ voucher: voucherView(row) });
  }
  if (path === "/api/sales/redemption-appointments" && method === "GET")
    return json({
      appointments: await redemptionAppointments(
        db,
        isoDate(url.searchParams.get("date")),
      ),
    });
  const appointment = path.match(/^\/api\/sales\/appointments\/([^/]+)$/);
  if (appointment && method === "GET")
    return json(await redemptionAppointment(db, appointment[1]));
  if (path === "/api/sales/redemptions" && method === "POST") {
    const result = await redeemVoucher(db, user, await readJSON(request, 4096));
    return json(result, result.replayed ? 200 : 201);
  }
  const correction = path.match(
    /^\/api\/sales\/redemptions\/([^/]+)\/reverse$/,
  );
  if (correction && method === "POST")
    return json(
      await reverseRedemption(
        db,
        user,
        correction[1],
        await readJSON(request, 4096),
      ),
    );
  if (path === "/api/sales/settings" && method === "GET") {
    const settings = await one(
      db,
      "SELECT * FROM voucher_settings WHERE id='default'",
    );
    return json({
      design: settings ? JSON.parse(settings.design_json) : DEFAULT_DESIGN,
      version: settings?.version || 0,
      emailReady: emailReady(env),
      from: "Rei Thailand Massage <info@reithailandmassage.com>",
    });
  }
  if (path === "/api/sales/settings" && method === "PUT") {
    const body = await readJSON(request, 8192),
      design = designInput(body.design),
      version = integer(body.version, 0, 100000000, "design version"),
      time = now();
    const result = await db.batch([
      statement(
        db,
        `INSERT INTO voucher_settings(id,design_json,version,updated_at) SELECT 'default',?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM voucher_settings WHERE id='default' AND version=?)
ON CONFLICT(id) DO UPDATE SET design_json=excluded.design_json,version=voucher_settings.version+1,updated_at=excluded.updated_at WHERE voucher_settings.version=?`,
        JSON.stringify(design),
        time,
        version,
        version,
        version,
      ),
      statement(
        db,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'update_template','voucher_settings','default',?,? WHERE changes()=1`,
        user.id,
        JSON.stringify(design),
        time,
      ),
    ]);
    if (!result[0].meta.changes)
      fail(409, "This design changed. Refresh before saving.");
    return json({ ok: true });
  }
  if (path === "/api/sales/preview" && method === "POST") {
    const body = await readJSON(request, 8192),
      item = await hydrateItem(db, itemInput(body));
    return json(
      voucherContent({ ...item, code: "PREVIEW" }, env.APP_ORIGIN, {
        preview: true,
      }),
    );
  }
  if (path === "/api/sales/checkout" && method === "POST") {
    const result = await checkout(db, user, await readJSON(request, 131072));
    return json(result, result.replayed ? 200 : 201);
  }
  if (
    (path === "/api/sales/vouchers" || path === "/api/sales/vouchers.csv") &&
    method === "GET"
  ) {
    const result = await register(db, url.searchParams, path.endsWith(".csv"));
    if (path.endsWith(".csv"))
      return new Response(vouchersCSV(result.vouchers), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="rei-gift-vouchers.csv"',
        },
      });
    return json(result);
  }
  const sale = path.match(/^\/api\/sales\/orders\/([^/]+)$/);
  if (sale && method === "GET") return json(await saleDetail(db, sale[1]));
  const voucher = path.match(
    /^\/api\/sales\/vouchers\/([^/]+)(\/print|\/email-preview)?$/,
  );
  if (voucher) {
    const row = await one(
      db,
      "SELECT * FROM voucher_register WHERE id=?",
      voucher[1],
    );
    if (!row) fail(404, "Voucher not found.");
    const value = voucherView(row);
    if (voucher[2] === "/print" && method === "GET")
      return new Response(
        voucherContent(value, env.APP_ORIGIN, { print: true }).html,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    if (voucher[2] === "/email-preview" && method === "POST")
      return json(
        await prepareDelivery(
          db,
          env,
          user,
          value,
          await readJSON(request, 4096),
        ),
      );
    if (!voucher[2] && method === "GET")
      return json({
        voucher: value,
        ...(await saleDetail(db, row.sale_id)),
        preview: voucherContent(value, env.APP_ORIGIN),
        deliveries: (
          await all(
            db,
            "SELECT * FROM voucher_deliveries WHERE voucher_id=? ORDER BY created_at DESC",
            row.id,
          )
        ).map((d) => ({
          ...deliveryView(d),
          canSend:
            !value.closure &&
            value.status === "issued" &&
            deliveryView(d).canSend,
        })),
        redemptions: await redemptionHistory(db, "voucher_id", row.id),
      });
  }
  const delivery = path.match(/^\/api\/sales\/deliveries\/([^/]+)$/);
  if (delivery && method === "GET") {
    const row = await one(
      db,
      "SELECT d.*,c.kind AS closure_kind FROM voucher_deliveries d LEFT JOIN voucher_changes c ON c.voucher_id=d.voucher_id WHERE d.id=?",
      delivery[1],
    );
    if (!row) fail(404, "Email preview not found.");
    const saved = JSON.parse(row.payload_json);
    return json({
      delivery: {
        ...deliveryView(row),
        canSend: !row.closure_kind && deliveryView(row).canSend,
      },
      preview: { html: saved.html, text: saved.text },
      from: saved.from,
    });
  }
  const send = path.match(/^\/api\/sales\/deliveries\/([^/]+)\/send$/);
  if (send && method === "POST")
    return json({ delivery: await sendDelivery(db, env, user, send[1]) });
  fail(404, "Sales action not found.");
}
