import { randomUUID, randomBytes } from "node:crypto";
import { fail, digest } from "./security.mjs";
import { text, integer, isoDate } from "./domain.mjs";
import { belgradeToday } from "./reports.mjs";
const one = (db, sql, ...args) =>
  db
    .prepare(sql)
    .bind(...args)
    .first();
export function voucherChangeError(error) {
  const detail = String(error?.message || "");
  if (detail.includes("voucher_already_closed"))
    fail(
      409,
      "This voucher was voided, refunded or replaced. Open its history.",
    );
  if (detail.includes("voucher_balance_changed"))
    fail(
      409,
      "The voucher balance changed or it has already been used. Refresh and review it.",
    );
  if (detail.includes("voucher_closed_reversal"))
    fail(
      409,
      "This voucher has been closed. Its recorded uses cannot be reversed after a refund or cancellation.",
    );
  throw error;
}
export function correctionDetails(row, body, validateDesign, checkDate = true) {
  const input = body.details;
  if (!input || typeof input !== "object")
    fail(400, "Enter the corrected voucher details.");
  if (input.expiresOn !== null && typeof input.expiresOn !== "string")
    fail(400, "Choose a validity date or no expiry.");
  const expiresOn = input.expiresOn === null ? null : isoDate(input.expiresOn);
  if (
    checkDate &&
    expiresOn &&
    expiresOn !== row.expires_on &&
    expiresOn < belgradeToday()
  )
    fail(400, "The new validity date cannot be in the past.");
  return {
    recipientName: text(input.recipientName || "", 100, "recipient name", true),
    senderName: text(input.senderName || "", 100, "gift sender", true),
    message: text(input.message || "", 1000, "gift message", true),
    expiresOn,
    design: validateDesign(input.design),
  };
}
export async function changeVoucher(db, user, id, body, validateDesign) {
  const kind = body.kind;
  if (!["void", "refund", "replaced"].includes(kind))
    fail(400, "Choose Void, Refund or Correct details.");
  const requestId = text(body.requestId, 100, "request identifier");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))
    fail(400, "Start a new voucher action.");
  const reason = text(body.reason, 500, "reason");
  if (reason.length < 3) fail(400, "Give a reason with at least 3 characters.");
  if (body.confirmed !== true)
    fail(400, "Review and confirm this voucher action.");
  if (kind === "void" && body.noPaymentConfirmed !== true)
    fail(
      400,
      "Confirm this was an erroneous or duplicate sale with no separate payment to refund. Otherwise choose Refund.",
    );
  if (kind === "refund" && body.refundPaidConfirmed !== true)
    fail(
      400,
      "Confirm the money has already been returned outside this application.",
    );
  const row = await one(db, "SELECT * FROM voucher_register WHERE id=?", id);
  if (!row) fail(404, "Voucher not found.");
  const input = {
    voucherId: id,
    requestId,
    kind,
    reason,
    expectedRemainingCents: integer(
      body.expectedRemainingCents,
      1,
      100000000,
      "remaining value",
    ),
    paymentMethod:
      kind === "refund" ? text(body.paymentMethod, 30, "refund method") : "",
    paymentReference:
      kind === "refund"
        ? text(body.paymentReference || "", 120, "refund reference", true)
        : "",
    details:
      kind === "replaced"
        ? correctionDetails(row, body, validateDesign, false)
        : null,
  };
  if (
    kind === "refund" &&
    !["cash", "card", "bank_transfer", "other"].includes(input.paymentMethod)
  )
    fail(400, "Choose how the refund was paid.");
  const hash = digest(JSON.stringify(input));
  const replay = async () => {
    const old = await one(
      db,
      "SELECT * FROM voucher_changes WHERE request_id=?",
      requestId,
    );
    if (old && old.request_hash !== hash)
      fail(
        409,
        "This request was completed with different details. Start a new voucher action.",
      );
    return old;
  };
  const response = (entry, replayed) => ({
    ok: true,
    replayed,
    changeId: entry.id,
    kind: entry.kind,
    voucherId: entry.voucher_id,
    replacementId: entry.replacement_id || null,
  });
  const existing = await replay();
  if (existing) return response(existing, true);
  if (kind === "replaced") correctionDetails(row, body, validateDesign);
  const entry = {
    id: randomUUID(),
    kind,
    voucher_id: id,
    replacement_id: kind === "replaced" ? randomUUID() : null,
  };
  const code =
    kind === "replaced"
      ? "REI-" +
        randomBytes(12).toString("hex").toUpperCase().match(/.{4}/g).join("-")
      : null;
  try {
    await db
      .prepare(
        `INSERT INTO voucher_changes(id,voucher_id,request_id,request_hash,kind,expected_remaining_cents,amount_cents,reason,payment_method,payment_reference,replacement_id,replacement_code,replacement_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        entry.id,
        id,
        requestId,
        hash,
        kind,
        input.expectedRemainingCents,
        kind === "replaced" ? 0 : input.expectedRemainingCents,
        reason,
        input.paymentMethod,
        input.paymentReference,
        entry.replacement_id,
        code,
        input.details ? JSON.stringify(input.details) : null,
        user.id,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    const old = await replay();
    if (old) return response(old, true);
    voucherChangeError(error);
  }
  return response(entry, false);
}
