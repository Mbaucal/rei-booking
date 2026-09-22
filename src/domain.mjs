import { fail } from "./security.mjs";
export function text(value, max, label, optional = false) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (!optional && !value.trim())
  )
    fail(400, `Enter a valid ${label}.`);
  return value.trim();
}
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(400, `Enter a valid ${label}.`);
  return value;
}
export function isoDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T12:00:00Z")) ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail(400, "Choose a valid date.");
  return value;
}
export function email(value, optional = true) {
  const clean = text(value || "", 254, "email", optional).toLowerCase();
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean))
    fail(400, "Enter a valid email.");
  return clean;
}
export function phoneKey(value) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = "381" + digits.slice(1);
  return digits || null;
}
export const defaultWeek = () =>
  Array.from({ length: 7 }, () => ({ enabled: true, start: 600, end: 1320 }));
export function clientInput(input) {
  const name = text(input.name, 100, "client name"),
    phone = text(input.phone || "", 30, "phone", true),
    mail = email(input.email);
  if (
    phone &&
    (!/^[+\d\s().-]+$/.test(phone) ||
      phone.replace(/\D/g, "").length < 7 ||
      phone.replace(/\D/g, "").length > 15)
  )
    fail(400, "Enter a valid phone number.");
  return {
    name,
    phone,
    phone_key: phoneKey(phone),
    email: mail,
    email_key: mail || null,
    note: text(input.note || "", 2000, "note", true),
  };
}
export function therapistInput(input) {
  const week = input.weekly || defaultWeek();
  if (!Array.isArray(week) || week.length !== 7)
    fail(400, "Set all seven working days.");
  const weekly = week.map((d) => {
    if (typeof d?.enabled !== "boolean") fail(400, "Set working days.");
    const start = integer(d.start, 600, 1320, "start time"),
      end = integer(d.end, 600, 1320, "end time");
    if (start % 5 || end % 5 || start >= end)
      fail(400, "Working hours use 5-minute steps and end after the start.");
    return { enabled: d.enabled, start, end };
  });
  const off = input.timeOff || [];
  if (!Array.isArray(off) || off.length > 400)
    fail(400, "Choose valid time off dates.");
  if (input.active !== undefined && typeof input.active !== "boolean")
    fail(400, "Set active status.");
  return {
    name: text(input.name, 70, "display name"),
    full_name: text(input.fullName || "", 160, "full name", true),
    email: email(input.email),
    phone: text(input.phone || "", 30, "phone", true),
    note: text(input.note || "", 2000, "note", true),
    active: input.active === false ? 0 : 1,
    weekly_json: JSON.stringify(weekly),
    time_off_json: JSON.stringify([...new Set(off.map(isoDate))].sort()),
  };
}
export function serviceInput(input) {
  const duration = integer(input.duration, 5, 720, "duration");
  if (duration % 5) fail(400, "Duration uses 5-minute steps.");
  if (!/^#[a-fA-F0-9]{6}$/.test(input.color))
    fail(400, "Choose a valid treatment colour.");
  return {
    name: text(input.name, 120, "treatment name"),
    duration,
    price_cents: integer(input.priceCents, 0, 100000000, "price"),
    color: input.color,
    active: input.active === false ? 0 : 1,
  };
}
export function projectAppointment(row, role) {
  const out = {
    id: row.id,
    therapistId: row.therapist_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    date: row.date,
    start: row.start_minute,
    duration: row.duration,
    roomId: row.room_id,
    bed: row.bed,
    status: row.status,
    requestedTherapistId: row.requested_therapist_id,
    version: row.version,
    color: row.color,
  };
  if (role !== "therapist")
    Object.assign(out, {
      clientId: row.client_id,
      clientName: row.client_name || null,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      cancelledAt: row.cancelled_at,
    });
  if (role === "owner")
    Object.assign(out, {
      grossCents: row.gross_cents,
      netCents: row.net_cents,
    });
  return out;
}
export function projectTherapist(row, role) {
  const out = {
    id: row.id,
    name: row.name,
    active: !!row.active,
    weekly: JSON.parse(row.weekly_json),
    timeOff: JSON.parse(row.time_off_json),
    version: row.version,
  };
  if (role === "owner")
    Object.assign(out, {
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      note: row.note,
      bonus: {
        mode: row.bonus_mode || "hourly",
        regularRate: row.regular_rate ?? 10000,
        requestedRate: row.requested_rate ?? 50000,
      },
    });
  return out;
}
