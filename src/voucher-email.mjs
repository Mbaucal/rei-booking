import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "./security.mjs";
import { text, email } from "./domain.mjs";
import { belgradeToday } from "./reports.mjs";
import { ensureSalesSchema } from "./sales-schema.mjs";
import { voucherContent } from "./voucher-render.mjs";

const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const FROM = "Rei Thailand Massage <info@reithailandmassage.com>";
export const emailReady = (env) =>
  env.EMAIL_ENABLED === "true" &&
  !!env.RESEND_API_KEY &&
  !!env.RESEND_WEBHOOK_SECRET;
export function deliveryView(row) {
  return {
    id: row.id,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorCode: row.error_code,
    retryAt: row.next_attempt_at,
    canSend: ["prepared", "retry", "sending"].includes(row.status),
  };
}
function destination(value) {
  const result = email(value, false);
  if (/[<>"',;\\\x00-\x20\x7f]/.test(result))
    fail(400, "Enter one recipient email address.");
  return result;
}
export async function prepareDelivery(db, env, user, voucher, body) {
  if (voucher.status !== "issued")
    fail(409, "Only an unexpired issued voucher can be emailed.");
  const to = destination(body.recipientEmail),
    subject = text(body.subject, 160, "email subject");
  if (/[\r\n\x00-\x1f]/.test(subject))
    fail(400, "Enter a single-line subject.");
  if (
    await one(
      db,
      "SELECT recipient FROM email_suppressions WHERE recipient=?",
      to,
    )
  )
    fail(
      409,
      "Delivery to this address is blocked after a bounce or complaint. Check the address.",
    );
  const content = voucherContent(voucher, env.APP_ORIGIN);
  const payload = {
    from: FROM,
    to: [to],
    subject,
    html: content.html,
    text: content.text,
  };
  let old = await one(
    db,
    "SELECT * FROM voucher_deliveries WHERE voucher_id=? AND recipient=?",
    voucher.id,
    to,
  );
  if (!old) {
    const id = randomUUID(),
      time = new Date().toISOString();
    await db.batch([
      stmt(
        db,
        `INSERT INTO voucher_deliveries(id,voucher_id,recipient,subject,payload_json,status,created_by,created_at,updated_at)
VALUES(?,?,?,?,?,'prepared',?,?,?) ON CONFLICT(voucher_id,recipient) DO NOTHING`,
        id,
        voucher.id,
        to,
        subject,
        JSON.stringify(payload),
        user.id,
        time,
        time,
      ),
      stmt(
        db,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'prepare_email','voucher_delivery',?, ?,? WHERE changes()=1`,
        user.id,
        id,
        JSON.stringify({ voucherId: voucher.id, recipient: to }),
        time,
      ),
    ]);
    old = await one(
      db,
      "SELECT * FROM voucher_deliveries WHERE voucher_id=? AND recipient=?",
      voucher.id,
      to,
    );
  }
  // A retry always previews the persisted content. No silent changes to destination,
  // subject or voucher design, and no second send to the same recipient in this release.
  if (old.subject !== subject)
    fail(
      409,
      "An email for this voucher and recipient already exists. Open it in delivery history.",
    );
  const saved = JSON.parse(old.payload_json);
  return {
    delivery: deliveryView(old),
    preview: { html: saved.html, text: saved.text },
    from: saved.from,
  };
}

export async function sendDelivery(db, env, user, id, transport = fetch) {
  if (!emailReady(env))
    fail(
      503,
      "Email sending is not configured yet. Complete sender verification and email settings first.",
    );
  let job = await one(
    db,
    "SELECT d.*,v.expires_on FROM voucher_deliveries d JOIN gift_vouchers v ON v.id=d.voucher_id WHERE d.id=?",
    id,
  );
  if (!job) fail(404, "Email preview not found.");
  if (["accepted", "delayed", "delivered"].includes(job.status))
    return deliveryView(job);
  if (!["prepared", "sending", "retry"].includes(job.status))
    fail(
      409,
      "This delivery needs review; it will not be sent again automatically.",
    );
  if (job.expires_on && job.expires_on < belgradeToday())
    fail(409, "This voucher has expired.");
  const time = Date.now();
  if (job.first_attempt_at && time - job.first_attempt_at >= 23 * 3600000) {
    await stmt(
      db,
      "UPDATE voucher_deliveries SET status='uncertain',error_code='review_provider',updated_at=? WHERE id=? AND status IN ('sending','retry')",
      new Date(time).toISOString(),
      id,
    ).run();
    fail(
      409,
      "The retry window ended. Check the email in Resend before taking further action.",
    );
  }
  if (job.next_attempt_at > time || job.lease_until > time)
    return deliveryView(job);
  if (
    await one(
      db,
      "SELECT recipient FROM email_suppressions WHERE recipient=?",
      job.recipient,
    )
  )
    fail(409, "This recipient is suppressed after a bounce or complaint.");
  const claim = await stmt(
    db,
    `UPDATE voucher_deliveries SET status='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),lease_until=?,updated_at=?
WHERE id=? AND status IN ('prepared','sending','retry') AND lease_until<=? AND next_attempt_at<=? RETURNING *`,
    time,
    time + 60000,
    new Date(time).toISOString(),
    id,
    time,
    time,
  ).first();
  if (!claim)
    return deliveryView(
      await one(db, "SELECT * FROM voucher_deliveries WHERE id=?", id),
    );
  job = claim;
  let result, response;
  try {
    response = await transport("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "rei-voucher/" + id,
      },
      body: job.payload_json,
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    result = await response.json();
  } catch {
    await retry(db, job, "connection_unconfirmed");
    return deliveryView(
      await one(db, "SELECT * FROM voucher_deliveries WHERE id=?", id),
    );
  }
  if (
    response.ok &&
    typeof result.id === "string" &&
    /^[a-zA-Z0-9-]{1,100}$/.test(result.id)
  ) {
    await db.batch([
      stmt(
        db,
        `UPDATE voucher_deliveries SET provider_id=?,status='accepted',status_rank=1,lease_until=0,error_code=NULL,updated_at=? WHERE id=? AND status='sending'`,
        result.id,
        new Date().toISOString(),
        id,
      ),
      stmt(
        db,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'email_accepted','voucher_delivery',?,?,? WHERE changes()=1`,
        user.id,
        id,
        JSON.stringify({ providerId: result.id }),
        new Date().toISOString(),
      ),
    ]);
    await reconcileEvents(db, result.id);
  } else if (
    response.status === 429 ||
    response.status >= 500 ||
    response.ok ||
    (response.status === 409 &&
      result?.name === "concurrent_idempotent_requests")
  ) {
    await retry(
      db,
      job,
      response.status === 429 ? "rate_limited" : "provider_unconfirmed",
    );
  } else {
    await db.batch([
      stmt(
        db,
        "UPDATE voucher_deliveries SET status='failed',status_rank=4,lease_until=0,error_code=?,updated_at=? WHERE id=? AND status='sending'",
        "provider_" + response.status,
        new Date().toISOString(),
        id,
      ),
      stmt(
        db,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'email_failed','voucher_delivery',?,?,? WHERE changes()=1`,
        user.id,
        id,
        JSON.stringify({ status: response.status }),
        new Date().toISOString(),
      ),
    ]);
  }
  return deliveryView(
    await one(db, "SELECT * FROM voucher_deliveries WHERE id=?", id),
  );
}
async function retry(db, job, code) {
  const delay = Math.min(300000, 15000 * 2 ** Math.min(job.attempts, 5));
  await stmt(
    db,
    "UPDATE voucher_deliveries SET status='retry',lease_until=0,next_attempt_at=?,error_code=?,updated_at=? WHERE id=? AND status='sending'",
    Date.now() + delay,
    code,
    new Date().toISOString(),
    job.id,
  ).run();
}
const EVENTS = {
  "email.sent": ["accepted", 1],
  "email.delivery_delayed": ["delayed", 2],
  "email.delivered": ["delivered", 3],
  "email.failed": ["failed", 4],
  "email.bounced": ["bounced", 5],
  "email.complained": ["complained", 6],
  "email.suppressed": ["suppressed", 6],
};
export async function reconcileEvents(db, providerId) {
  const events = (
    await stmt(
      db,
      "SELECT * FROM email_events WHERE provider_id=? ORDER BY occurred_at,id",
      providerId,
    ).all()
  ).results;
  for (const event of events) {
    const [status, rank] = EVENTS[event.event_type] || [];
    if (!status) continue;
    await db.batch([
      stmt(
        db,
        "UPDATE voucher_deliveries SET status=?,status_rank=?,error_code=NULL,updated_at=? WHERE provider_id=? AND status_rank<?",
        status,
        rank,
        event.received_at,
        providerId,
        rank,
      ),
      stmt(
        db,
        `INSERT INTO email_suppressions(recipient,reason,created_at) SELECT recipient,?,? FROM voucher_deliveries WHERE provider_id=? AND ? IN ('bounced','complained','suppressed') ON CONFLICT(recipient) DO NOTHING`,
        status,
        event.received_at,
        providerId,
        status,
      ),
    ]);
  }
}
export function verifyWebhook(raw, headers, secret, time = Date.now()) {
  const id = headers.get("svix-id") || "",
    timestamp = headers.get("svix-timestamp") || "",
    signatures = headers.get("svix-signature") || "";
  if (
    !/^[-\w]{1,100}$/.test(id) ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(time / 1000 - Number(timestamp)) > 300 ||
    !/^whsec_[A-Za-z0-9+/]+=*$/.test(secret || "")
  )
    fail(400, "Invalid webhook signature.");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16) fail(400, "Invalid webhook signature.");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${raw}`)
    .digest();
  const valid = signatures.split(" ").some((signature) => {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value) return false;
    const actual = Buffer.from(value, "base64");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
  if (!valid) fail(400, "Invalid webhook signature.");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(400, "Invalid webhook payload.");
  }
  return { id, data };
}
export async function emailWebhook(request, env) {
  if (!env.RESEND_WEBHOOK_SECRET) fail(503, "Email webhook is not configured.");
  if (request.method !== "POST") fail(405, "Use POST.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Missing webhook payload.");
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      fail(413, "Webhook payload too large.");
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8"),
    { id, data } = verifyWebhook(
      raw,
      request.headers,
      env.RESEND_WEBHOOK_SECRET,
    );
  if (!EVENTS[data?.type]) return Response.json({ ok: true });
  if (
    typeof data.data?.email_id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(data.data.email_id) ||
    !Number.isFinite(Date.parse(data.created_at))
  )
    fail(400, "Invalid email event.");
  await ensureSalesSchema(env.DB);
  await stmt(
    env.DB,
    "INSERT INTO email_events(id,provider_id,event_type,occurred_at,received_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    id,
    data.data.email_id,
    data.type,
    new Date(data.created_at).toISOString(),
    new Date().toISOString(),
  ).run();
  await reconcileEvents(env.DB, data.data.email_id);
  return Response.json({ ok: true });
}
