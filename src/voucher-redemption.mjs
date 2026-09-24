import { voucherChangeError } from "./voucher-changes.mjs";
import { randomUUID } from "node:crypto";
import { fail, digest } from "./security.mjs";
import { integer, text } from "./domain.mjs";
import { belgradeToday } from "./reports.mjs";

const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const all = async (db, sql, ...args) =>
  (await stmt(db, sql, ...args).all()).results;
const requestId = (value) => {
  const id = text(value, 100, "request identifier");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id))
    fail(400, "Start a new voucher action.");
  return id;
};
export function redemptionError(error) {
  const message = String(error?.message || "");
  const errors = {
    redemption_appointment_changed:
      "Choose a completed appointment dated today or earlier. Refresh if it was edited.",
    redemption_voucher_unavailable:
      "This voucher has expired or its remaining value changed. Refresh and review it.",
    redemption_amount_exceeded:
      "This amount exceeds the appointment's remaining value. Refresh and review it.",
    redemption_entitlement_mismatch:
      "The voucher must match the appointment's treatment and duration.",
    redeemed_appointment_locked:
      "Reverse the voucher use in Sales before changing this appointment. Notes can still be edited.",
  };
  for (const [code, explanation] of Object.entries(errors))
    if (message.includes(code)) fail(409, explanation);
  voucherChangeError(error);
}
export function redemptionView(r) {
  const snapshot = JSON.parse(r.appointment_json);
  return {
    id: r.id,
    voucherId: r.voucher_id,
    code: r.code,
    appointmentId: r.appointment_id,
    date: snapshot.date,
    start: snapshot.start,
    serviceName: snapshot.serviceName,
    duration: snapshot.duration,
    appliedCents: r.applied_cents,
    debitedCents: r.debited_cents,
    createdAt: r.created_at,
    createdBy: r.actor_name,
    reversedAt: r.reversed_at || null,
    reversedBy: r.reversed_by || null,
    reason: r.reason || "",
  };
}
const HISTORY = `SELECT r.*,v.code,a.date,a.start_minute,a.service_name,a.duration,
 u.name AS actor_name,x.created_at AS reversed_at,x.reason,reverse_actor.name AS reversed_by
FROM voucher_redemptions r JOIN gift_vouchers v ON v.id=r.voucher_id
JOIN appointments a ON a.id=r.appointment_id JOIN users u ON u.id=r.created_by
LEFT JOIN voucher_redemption_reversals x ON x.redemption_id=r.id
LEFT JOIN users reverse_actor ON reverse_actor.id=x.created_by`;
export async function redemptionHistory(db, field, id) {
  if (!["voucher_id", "appointment_id"].includes(field))
    throw new Error("Invalid history field");
  return (
    await all(
      db,
      HISTORY + ` WHERE r.${field}=? ORDER BY r.created_at DESC,r.id DESC`,
      id,
    )
  ).map(redemptionView);
}
const APPOINTMENTS = `SELECT a.*,c.name AS client_name,t.name AS therapist_name,
 COALESCE((SELECT SUM(applied_cents) FROM active_voucher_redemptions WHERE appointment_id=a.id),0) AS covered_cents
FROM appointments a LEFT JOIN clients c ON c.id=a.client_id JOIN therapists t ON t.id=a.therapist_id`;
const appointmentView = (a) => ({
  id: a.id,
  version: a.version,
  date: a.date,
  start: a.start_minute,
  serviceId: a.service_id,
  serviceName: a.service_name,
  duration: a.duration,
  status: a.status,
  clientName: a.client_name || "Walk-in",
  therapistName: a.therapist_name,
  netCents: a.net_cents,
  coveredCents: a.covered_cents,
  uncoveredCents: a.net_cents - a.covered_cents,
});
export async function redemptionAppointments(db, date) {
  return (
    await all(
      db,
      APPOINTMENTS +
        " WHERE a.date=? AND a.status='done' AND a.date<=? ORDER BY a.start_minute,a.id",
      date,
      belgradeToday(),
    )
  ).map(appointmentView);
}
export async function redemptionAppointment(db, id) {
  const row = await one(db, APPOINTMENTS + " WHERE a.id=?", id);
  if (!row) fail(404, "Appointment not found.");
  return {
    appointment: appointmentView(row),
    redemptions: await redemptionHistory(db, "appointment_id", id),
  };
}
async function replay(db, table, key, hash) {
  const row = await one(db, `SELECT * FROM ${table} WHERE request_id=?`, key);
  if (row && row.request_hash !== hash)
    fail(
      409,
      "This request was already used with different details. Start a new voucher action.",
    );
  return row;
}
export async function redeemVoucher(db, user, body) {
  const input = {
    requestId: requestId(body.requestId),
    voucherId: text(body.voucherId, 100, "voucher"),
    appointmentId: text(body.appointmentId, 100, "appointment"),
    appointmentVersion: integer(
      body.appointmentVersion,
      1,
      100000000,
      "appointment version",
    ),
    appliedCents: integer(body.appliedCents, 1, 100000000, "voucher amount"),
  };
  if (body.confirmed !== true) fail(400, "Review and confirm the voucher use.");
  const hash = digest(JSON.stringify(input));
  const existing = await replay(
    db,
    "voucher_redemptions",
    input.requestId,
    hash,
  );
  const response = async (id, replayed) => ({
    redemption: redemptionView(await one(db, HISTORY + " WHERE r.id=?", id)),
    replayed,
  });
  if (existing) return response(existing.id, true);
  const voucher = await one(
    db,
    "SELECT * FROM gift_vouchers WHERE id=?",
    input.voucherId,
  );
  if (!voucher) fail(404, "Voucher not found.");
  const appointment = await one(
    db,
    APPOINTMENTS + " WHERE a.id=?",
    input.appointmentId,
  );
  if (!appointment) fail(404, "Appointment not found.");
  if (appointment.version !== input.appointmentVersion)
    fail(409, "This appointment changed. Refresh and review it.");
  const id = randomUUID(),
    time = new Date().toISOString();
  try {
    // The trigger reads balances and appointment version in the same write transaction.
    await stmt(
      db,
      `INSERT INTO voucher_redemptions(id,request_id,request_hash,voucher_id,appointment_id,appointment_version,applied_cents,debited_cents,redeemed_on,appointment_json,created_by,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.requestId,
      hash,
      input.voucherId,
      input.appointmentId,
      input.appointmentVersion,
      input.appliedCents,
      voucher.kind === "treatment" ? voucher.price_cents : input.appliedCents,
      belgradeToday(),
      JSON.stringify(appointmentView(appointment)),
      user.id,
      time,
    ).run();
  } catch (error) {
    const saved = await replay(
      db,
      "voucher_redemptions",
      input.requestId,
      hash,
    );
    if (saved) return response(saved.id, true);
    redemptionError(error);
  }
  return response(id, false);
}
export async function reverseRedemption(db, user, id, body) {
  const input = {
    id: text(id, 100, "voucher use"),
    requestId: requestId(body.requestId),
    reason: text(body.reason, 500, "correction reason"),
  };
  if (input.reason.length < 3)
    fail(400, "Give a reason for this correction (at least 3 characters).");
  if (body.confirmed !== true)
    fail(
      400,
      "Confirm this correction. It restores voucher value and does not refund a payment.",
    );
  const hash = digest(JSON.stringify(input));
  if (await replay(db, "voucher_redemption_reversals", input.requestId, hash))
    return { ok: true, replayed: true };
  if (!(await one(db, "SELECT id FROM voucher_redemptions WHERE id=?", id)))
    fail(404, "Voucher use not found.");
  try {
    await stmt(
      db,
      "INSERT INTO voucher_redemption_reversals(id,redemption_id,request_id,request_hash,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      randomUUID(),
      id,
      input.requestId,
      hash,
      input.reason,
      user.id,
      new Date().toISOString(),
    ).run();
  } catch (error) {
    if (await replay(db, "voucher_redemption_reversals", input.requestId, hash))
      return { ok: true, replayed: true };
    if (
      await one(
        db,
        "SELECT id FROM voucher_redemption_reversals WHERE redemption_id=?",
        id,
      )
    )
      fail(409, "This voucher use was already reversed. Refresh the history.");
    voucherChangeError(error);
  }
  return { ok: true, replayed: false };
}
