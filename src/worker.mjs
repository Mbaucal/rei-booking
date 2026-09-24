import { monthlyRoutes, runMonthly } from "./monthly-reports.mjs";
import { ensurePhotoSchema } from "./photo-schema.mjs";
import {
  photoInput,
  photoStatement,
  addPhotoMetadata,
  photoRoute,
} from "./photos.mjs";
import { randomUUID } from "node:crypto";
import {
  fail,
  HttpError,
  token,
  digest,
  hashPassword,
  verifyPassword,
  publicUser,
  requireRole,
  readSessionToken,
  sessionCookie,
  secureHeaders,
  readJSON,
} from "./security.mjs";
import {
  text,
  integer,
  isoDate,
  email,
  phoneKey,
  clientInput,
  therapistInput,
  serviceInput,
  projectAppointment,
  projectTherapist,
} from "./domain.mjs";
import { ensureReportSchema } from "./report-schema.mjs";
import { salesRoutes } from "./sales.mjs";
import { emailWebhook } from "./voucher-email.mjs";
import {
  bonusInput,
  reportOptions,
  buildReport,
  comparison,
  reportCSV,
} from "./reports.mjs";

const now = () => new Date().toISOString();
const json = (value, status = 200, headers = {}) =>
  Response.json(value, { status, headers });
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const all = async (db, sql, ...args) =>
  (await stmt(db, sql, ...args).all()).results;
const CONFLICT_MESSAGE = "This record changed. Refresh it before saving again.";
const APP_SELECT = `SELECT a.*,s.color,c.name AS client_name FROM appointments a JOIN services s ON s.id=a.service_id LEFT JOIN clients c ON c.id=a.client_id`;
// Valid scrypt encoding with a fixed salt, used only to equalize missing-account work.
const DUMMY_HASH =
  "scrypt$32768$8$3$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";

async function authenticate(request, db) {
  const raw = readSessionToken(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) fail(401, "Please sign in.");
  const found = await one(
    db,
    `SELECT u.*,s.token_hash,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN therapists t ON t.id=u.therapist_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND (u.role!='therapist' OR t.active=1)`,
    digest(raw),
    Date.now(),
  );
  if (!found) fail(401, "Please sign in.");
  return found;
}
function checkOrigin(request, env) {
  const url = new URL(request.url);
  if (env.APP_ORIGIN !== url.origin)
    fail(503, "Application address is not configured.");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    fail(400, "HTTPS is required.");
  if (
    !["GET", "HEAD"].includes(request.method) &&
    request.headers.get("origin") !== env.APP_ORIGIN
  )
    fail(403, "Request origin is not allowed.");
}
async function rateLimit(db, key, limit) {
  const time = Date.now(),
    start = time - 900000;
  const record = await one(
    db,
    `INSERT INTO login_limits(key,window_start,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts`,
    key,
    time,
    start,
    start,
  );
  if (record.attempts > limit)
    fail(429, "Too many sign-in attempts. Try again in 15 minutes.");
}
async function login(request, env) {
  const body = await readJSON(request, 4096),
    mail = email(body.email, false);
  await rateLimit(
    env.DB,
    "ip:" + digest(request.headers.get("cf-connecting-ip") || "local"),
    60,
  );
  await rateLimit(env.DB, "email:" + digest(mail), 12);
  const user = await one(env.DB, "SELECT * FROM users WHERE email=?", mail);
  const valid = await verifyPassword(
    body.password,
    user?.password_hash || DUMMY_HASH,
  );
  if (!valid || !user?.active) fail(401, "Email or password is incorrect.");
  if (
    user.role === "therapist" &&
    !(await one(
      env.DB,
      "SELECT id FROM therapists WHERE id=? AND active=1",
      user.therapist_id,
    ))
  )
    fail(401, "Email or password is incorrect.");
  const raw = token(),
    csrf = token();
  await env.DB.batch([
    stmt(env.DB, "DELETE FROM sessions WHERE expires_at<=?", Date.now()),
    stmt(
      env.DB,
      "DELETE FROM login_limits WHERE window_start<?",
      Date.now() - 86400000,
    ),
    stmt(
      env.DB,
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      user.id,
      csrf,
      Date.now() + 43200000,
      now(),
    ),
  ]);
  return json(
    {
      user: publicUser(user),
      csrf,
      mustChangePassword: !!user.must_change_password,
    },
    200,
    {
      "Set-Cookie": sessionCookie(
        raw,
        new URL(request.url).protocol === "https:",
      ),
    },
  );
}
async function auditedWrite(
  db,
  query,
  user,
  entity,
  id,
  action,
  before,
  after,
  extra = [],
) {
  const result = await db.batch([
    query,
    ...extra,
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,before_json,after_json,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1`,
      user.id,
      action,
      entity,
      id,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
      now(),
    ),
  ]);
  if (!result[0].meta.changes) fail(409, CONFLICT_MESSAGE);
}
async function saveEntity(db, user, entity, body, id) {
  const config = {
    clients: { parse: clientInput, table: "clients" },
    therapists: { parse: therapistInput, table: "therapists" },
    services: { parse: serviceInput, table: "services" },
  }[entity];
  if (entity === "clients") requireRole(user, "owner", "reception");
  else requireRole(user, "owner");
  const values = config.parse(body),
    keys = Object.keys(values),
    time = now();
  let before = null;
  if (id) {
    before = await one(db, `SELECT * FROM ${config.table} WHERE id=?`, id);
    if (!before) fail(404, "Record not found.");
    integer(body.version, 1, 100000000, "record version");
  }
  const recordId = id || randomUUID();
  const bonus =
    entity === "therapists" && body.bonus !== undefined
      ? bonusInput(body.bonus)
      : null;
  if (bonus && before)
    before.bonus = await one(
      db,
      "SELECT mode,regular_rate,requested_rate FROM therapist_bonus_rules WHERE therapist_id=?",
      id,
    );
  const query = id
    ? stmt(
        db,
        `UPDATE ${config.table} SET ${keys.map((k) => k + "=?").join(",")},updated_at=?,version=version+1 WHERE id=? AND version=?`,
        ...Object.values(values),
        time,
        id,
        body.version,
      )
    : stmt(
        db,
        `INSERT INTO ${config.table}(id,${keys.join(",")},created_at,updated_at) VALUES(${Array(
          keys.length + 3,
        )
          .fill("?")
          .join(",")})`,
        recordId,
        ...Object.values(values),
        time,
        time,
      );
  const photo =
    entity !== "services" && body.photo !== undefined
      ? photoInput(body.photo)
      : null;
  await auditedWrite(
    db,
    query,
    user,
    entity,
    recordId,
    id ? "update" : "create",
    before,
    bonus ? { ...values, bonus } : values,
    [
      ...(bonus
        ? [
            stmt(
              db,
              `INSERT INTO therapist_bonus_rules(therapist_id,mode,regular_rate,requested_rate,updated_at)
SELECT ?,?,?,?,? WHERE changes()=1
ON CONFLICT(therapist_id) DO UPDATE SET mode=excluded.mode,regular_rate=excluded.regular_rate,requested_rate=excluded.requested_rate,updated_at=excluded.updated_at`,
              recordId,
              bonus.mode,
              bonus.regular_rate,
              bonus.requested_rate,
              time,
            ),
          ]
        : []),
      ...(photo
        ? [photoStatement(db, user, entity, recordId, photo, true)]
        : []),
    ],
  );
  return json({ id: recordId }, id ? 200 : 201);
}
async function saveAppointment(db, user, body, id) {
  requireRole(user, "owner", "reception");
  const old = id
    ? await one(db, "SELECT * FROM appointments WHERE id=?", id)
    : null;
  if (id && !old) fail(404, "Appointment not found.");
  if (id) integer(body.version, 1, 100000000, "record version");
  const variant = await one(
    db,
    "SELECT * FROM services WHERE id=?",
    text(body.serviceId, 100, "treatment"),
  );
  if (!variant || (!variant.active && variant.id !== old?.service_id))
    fail(400, "Choose an active treatment.");
  const date = isoDate(body.date),
    start = integer(body.start, 600, 1315, "start time"),
    duration = integer(body.duration, 5, 720, "duration");
  if (start % 5 || duration % 5 || start + duration > 1320)
    fail(400, "Use 5-minute steps within 10:00–22:00.");
  const status = body.status || "booked";
  if (!["booked", "confirmed", "done", "cancelled", "no_show"].includes(status))
    fail(400, "Choose an appointment status.");
  const serviceChanged = !old || old.service_id !== variant.id;
  let gross = serviceChanged ? variant.price_cents : old.gross_cents,
    net = serviceChanged ? variant.price_cents : old.net_cents;
  if (user.role === "owner") {
    if (body.grossCents !== undefined)
      gross = integer(body.grossCents, 0, 100000000, "full price");
    if (body.netCents !== undefined)
      net = integer(body.netCents, 0, gross, "price after discount");
  } else if (body.grossCents !== undefined || body.netCents !== undefined)
    fail(403, "Only the owner can change financial values.");
  if (net > gross) fail(400, "Discounted price cannot exceed the full price.");
  if (body.newClient && (id || body.clientId))
    fail(
      400,
      "Add a new client only to a new appointment without an existing client selected.",
    );
  const newClient = body.newClient
    ? { id: randomUUID(), ...clientInput(body.newClient) }
    : null;
  const time = now(),
    values = {
      client_id: newClient?.id || body.clientId || null,
      therapist_id: text(body.therapistId, 100, "therapist"),
      service_id: variant.id,
      service_name: serviceChanged ? variant.name : old.service_name,
      date,
      start_minute: start,
      duration,
      room_id: text(body.roomId, 100, "room"),
      bed: integer(body.bed, 0, 1, "table"),
      status,
      requested_therapist_id: body.requestedTherapistId || null,
      note: text(body.note || "", 2000, "note", true),
      gross_cents: gross,
      net_cents: net,
      updated_at: time,
      cancelled_at: status === "cancelled" ? old?.cancelled_at || time : null,
      updated_by: user.id,
      mutation_id: randomUUID(),
    };
  const recordId = id || randomUUID(),
    keys = Object.keys(values);
  const keepRule =
    old && (old.therapist_id === values.therapist_id || old.status === "done");
  const rule = keepRule
    ? (await one(
        db,
        "SELECT mode,regular_rate,requested_rate FROM appointment_bonus_rules WHERE appointment_id=?",
        id,
      )) || {
        mode: "hourly",
        regular_rate: old.bonus_regular_cents_hour,
        requested_rate: old.bonus_requested_cents_hour,
      }
    : (await one(
        db,
        "SELECT mode,regular_rate,requested_rate FROM therapist_bonus_rules WHERE therapist_id=?",
        values.therapist_id,
      )) || { mode: "hourly", regular_rate: 10000, requested_rate: 50000 };
  const appointmentQuery = id
    ? stmt(
        db,
        `UPDATE appointments SET ${keys.map((k) => k + "=?").join(",")},version=version+1 WHERE id=? AND version=? RETURNING id`,
        ...Object.values(values),
        id,
        body.version,
      )
    : stmt(
        db,
        `INSERT INTO appointments(id,${keys.join(",")},created_at) VALUES(${Array(
          keys.length + 2,
        )
          .fill("?")
          .join(",")}) RETURNING id`,
        recordId,
        ...Object.values(values),
        time,
      );
  const ruleQuery = stmt(
    db,
    `INSERT INTO appointment_bonus_rules(appointment_id,mode,regular_rate,requested_rate,captured_at)
SELECT id,?,?,?,? FROM appointments WHERE id=? AND mutation_id=?
ON CONFLICT(appointment_id) DO UPDATE SET mode=excluded.mode,regular_rate=excluded.regular_rate,requested_rate=excluded.requested_rate,captured_at=CASE WHEN appointment_bonus_rules.mode=excluded.mode AND appointment_bonus_rules.regular_rate=excluded.regular_rate AND appointment_bonus_rules.requested_rate=excluded.requested_rate THEN appointment_bonus_rules.captured_at ELSE excluded.captured_at END`,
    rule.mode,
    rule.regular_rate,
    rule.requested_rate,
    time,
    recordId,
    values.mutation_id,
  );
  let saved;
  if (newClient) {
    const clientKeys = Object.keys(newClient);
    const results = await db.batch([
      stmt(
        db,
        `INSERT INTO clients(${clientKeys.join(",")},created_at,updated_at) VALUES(${Array(
          clientKeys.length + 2,
        )
          .fill("?")
          .join(",")})`,
        ...Object.values(newClient),
        time,
        time,
      ),
      appointmentQuery,
      ruleQuery,
      stmt(
        db,
        "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(?,?,?,?,?,?)",
        user.id,
        "create",
        "clients",
        newClient.id,
        JSON.stringify(newClient),
        time,
      ),
    ]);
    saved = results[1].results[0];
  } else saved = (await db.batch([appointmentQuery, ruleQuery]))[0].results[0];
  if (!saved) fail(409, CONFLICT_MESSAGE);
  return json(
    {
      appointment: projectAppointment(
        await one(db, APP_SELECT + " WHERE a.id=?", recordId),
        user.role,
      ),
    },
    id ? 200 : 201,
  );
}
async function routes(request, env) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method,
    db = env.DB;
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (path === "/api/email/webhook") return emailWebhook(request, env);
  checkOrigin(request, env);
  if (path === "/api/health" && method === "GET")
    return json({ ok: true, version: "0.7.0", environment: env.APP_ENV });
  if (path === "/api/login" && method === "POST") return login(request, env);
  const user = await authenticate(request, db);
  if (
    !["GET", "HEAD"].includes(method) &&
    digest(request.headers.get("x-csrf-token") || "") !==
      digest(user.csrf_token)
  )
    fail(403, "The session changed. Refresh the page.");
  if (path === "/api/session" && method === "GET")
    return json({
      user: publicUser(user),
      csrf: user.csrf_token,
      mustChangePassword: !!user.must_change_password,
    });
  if (path === "/api/logout" && method === "POST") {
    await stmt(
      db,
      "DELETE FROM sessions WHERE token_hash=?",
      user.token_hash,
    ).run();
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie("", url.protocol === "https:", true),
    });
  }
  if (path === "/api/password" && method === "POST") {
    const body = await readJSON(request, 4096);
    await rateLimit(db, "password:" + user.id, 12);
    if (!(await verifyPassword(body.currentPassword, user.password_hash)))
      fail(400, "Current password is incorrect.");
    const hash = await hashPassword(body.newPassword);
    await db.batch([
      stmt(
        db,
        "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
        hash,
        user.id,
      ),
      stmt(db, "DELETE FROM sessions WHERE user_id=?", user.id),
    ]);
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie("", url.protocol === "https:", true),
    });
  }
  if (user.must_change_password)
    fail(403, "Change your temporary password before continuing.");
  await ensureReportSchema(db);
  await ensurePhotoSchema(db);
  const photoMatch = path.match(
    /^\/api\/photos\/(clients|therapists)\/([^/]+)$/,
  );
  if (photoMatch)
    return photoRoute(request, db, user, photoMatch[1], photoMatch[2]);
  if (path.startsWith("/api/sales/")) return salesRoutes(request, env, user);
  if (path === "/api/catalogue" && method === "GET") {
    const [therapists, rooms, services] = await Promise.all([
      all(
        db,
        "SELECT t.*,b.mode AS bonus_mode,b.regular_rate,b.requested_rate FROM therapists t LEFT JOIN therapist_bonus_rules b ON b.therapist_id=t.id ORDER BY t.name",
      ),
      all(db, "SELECT * FROM rooms ORDER BY id"),
      all(db, "SELECT * FROM services ORDER BY name,duration"),
    ]);
    return json({
      therapists: await addPhotoMetadata(
        db,
        "therapists",
        therapists.map((t) => projectTherapist(t, user.role)),
      ),
      rooms,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        duration: s.duration,
        color: s.color,
        active: !!s.active,
        version: s.version,
        ...(user.role === "owner" ? { priceCents: s.price_cents } : {}),
      })),
    });
  }
  if (
    /^\/api\/reports\/(monthly|archive|recipients|notifications)(\/|$)/.test(
      path,
    )
  )
    return monthlyRoutes(request, env, user);
  if (
    ["/api/reports/appointments", "/api/reports/appointments.csv"].includes(
      path,
    ) &&
    method === "GET"
  ) {
    requireRole(user, "owner");
    const options = reportOptions(url.searchParams);
    const rows = await all(
      db,
      `SELECT a.*,t.name AS therapist_name,rt.name AS requested_name,b.mode AS bonus_mode,b.regular_rate,b.requested_rate
FROM appointments a JOIN therapists t ON t.id=a.therapist_id LEFT JOIN therapists rt ON rt.id=a.requested_therapist_id LEFT JOIN appointment_bonus_rules b ON b.appointment_id=a.id
WHERE a.date BETWEEN ? AND ? ORDER BY a.date,a.start_minute,a.id LIMIT 20001`,
      options.compare ? options.previousFrom : options.from,
      options.to,
    );
    if (rows.length > 20000)
      fail(
        400,
        "Choose a shorter report period (maximum 20,000 appointments).",
      );
    const therapists = await all(
      db,
      "SELECT id,name FROM therapists ORDER BY name",
    );
    const report = buildReport(rows, options, therapists);
    if (path.endsWith(".csv"))
      return new Response(
        reportCSV(
          report,
          url.searchParams.get("view") || "summary",
          url.searchParams.get("bonuses") !== "0",
        ),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="rei-appointments-${options.from}-${options.to}.csv"`,
          },
        },
      );
    const previous = options.compare
      ? buildReport(
          rows,
          { ...options, from: options.previousFrom, to: options.previousTo },
          therapists,
        ).totals
      : null;
    return json({
      ...report,
      previous,
      comparison: previous ? comparison(report.totals, previous) : null,
    });
  }
  if (path === "/api/clients" && method === "GET") {
    requireRole(user, "owner", "reception");
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length > 100) fail(400, "Search is too long.");
    const normalized = /^[+\d\s().-]+$/.test(q) ? phoneKey(q) : null;
    const rows = await all(
      db,
      "SELECT id,name,phone,email,note,version,created_at FROM clients WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR (? IS NOT NULL AND phone_key LIKE ?) ORDER BY name LIMIT 100",
      "%" + q + "%",
      "%" + q + "%",
      "%" + q + "%",
      normalized,
      normalized ? "%" + normalized + "%" : null,
    );
    return json({ clients: await addPhotoMetadata(db, "clients", rows) });
  }
  const clientMatch = path.match(/^\/api\/clients\/([^/]+)$/);
  if (clientMatch && method === "GET") {
    requireRole(user, "owner", "reception");
    const client = await one(
      db,
      "SELECT id,name,phone,email,note,version,created_at FROM clients WHERE id=?",
      clientMatch[1],
    );
    if (!client) fail(404, "Client not found.");
    const items = await all(
      db,
      APP_SELECT +
        " WHERE a.client_id=? ORDER BY a.date DESC,a.start_minute DESC LIMIT 500",
      client.id,
    );
    return json({
      client: (await addPhotoMetadata(db, "clients", [client]))[0],
      appointments: items.map((a) => projectAppointment(a, user.role)),
    });
  }
  if (path === "/api/appointments" && method === "GET") {
    const from = isoDate(url.searchParams.get("from")),
      to = isoDate(url.searchParams.get("to") || from);
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 30)
      fail(400, "Choose a range of up to 31 days.");
    const rows = await all(
      db,
      APP_SELECT +
        " WHERE a.date BETWEEN ? AND ? ORDER BY a.date,a.start_minute",
      from,
      to,
    );
    return json({
      appointments: rows.map((a) => projectAppointment(a, user.role)),
    });
  }
  if (path === "/api/appointments" && method === "POST")
    return saveAppointment(db, user, await readJSON(request), null);
  const appointmentMatch = path.match(/^\/api\/appointments\/([^/]+)$/);
  if (appointmentMatch && method === "PUT")
    return saveAppointment(
      db,
      user,
      await readJSON(request),
      appointmentMatch[1],
    );
  for (const entity of ["clients", "therapists", "services"]) {
    if (path === "/api/" + entity && method === "POST")
      return saveEntity(
        db,
        user,
        entity,
        await readJSON(request, 250000),
        null,
      );
    const match = path.match(new RegExp("^/api/" + entity + "/([^/]+)$"));
    if (match && method === "PUT")
      return saveEntity(
        db,
        user,
        entity,
        await readJSON(request, 250000),
        match[1],
      );
  }
  if (path === "/api/users" && method === "GET") {
    requireRole(user, "owner");
    return json({
      users: await all(
        db,
        "SELECT id,name,email,role,therapist_id,active,must_change_password FROM users ORDER BY name",
      ),
    });
  }
  if (path === "/api/users" && method === "POST") {
    requireRole(user, "owner");
    const body = await readJSON(request, 8192),
      mail = email(body.email, false),
      name = text(body.name, 100, "name");
    if (!["owner", "reception", "therapist"].includes(body.role))
      fail(400, "Choose a user role.");
    const therapistId =
      body.role === "therapist"
        ? text(body.therapistId, 100, "therapist profile")
        : null;
    if (
      therapistId &&
      !(await one(
        db,
        "SELECT id FROM therapists WHERE id=? AND active=1",
        therapistId,
      ))
    )
      fail(400, "Choose an active therapist profile.");
    const hash = await hashPassword(body.password),
      id = randomUUID();
    await auditedWrite(
      db,
      stmt(
        db,
        "INSERT INTO users(id,email,name,password_hash,role,therapist_id,must_change_password,created_at) VALUES(?,?,?,?,?,?,1,?)",
        id,
        mail,
        name,
        hash,
        body.role,
        therapistId,
        now(),
      ),
      user,
      "user",
      id,
      "create",
      null,
      { email: mail, name, role: body.role, therapistId },
    );
    return json({ id }, 201);
  }
  const userMatch = path.match(/^\/api\/users\/([^/]+)\/active$/);
  if (userMatch && method === "PUT") {
    requireRole(user, "owner");
    if (userMatch[1] === user.id)
      fail(400, "You cannot disable your own account.");
    const body = await readJSON(request, 4096);
    if (typeof body.active !== "boolean") fail(400, "Set active status.");
    const target = await one(
      db,
      "SELECT id,active FROM users WHERE id=?",
      userMatch[1],
    );
    if (!target) fail(404, "User not found.");
    await db.batch([
      stmt(
        db,
        "UPDATE users SET active=? WHERE id=?",
        body.active ? 1 : 0,
        target.id,
      ),
      stmt(db, "DELETE FROM sessions WHERE user_id=?", target.id),
      stmt(
        db,
        "INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) VALUES(?,?,?,?,?,?)",
        user.id,
        "set_active",
        "user",
        target.id,
        JSON.stringify({ active: body.active }),
        now(),
      ),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/audit" && method === "GET") {
    requireRole(user, "owner");
    return json({
      events: await all(
        db,
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT 100",
      ),
    });
  }
  fail(404, "This feature is not available in the first development release.");
}
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonthly(env, controller.scheduledTime));
  },
  async fetch(request, env) {
    try {
      return secureHeaders(await routes(request, env));
    } catch (error) {
      let status = error instanceof HttpError ? error.status : 500,
        message =
          error instanceof HttpError
            ? error.message
            : "The request could not be completed.";
      const detail = String(error?.message || "");
      if (detail.includes("photo_conflict")) {
        status = 409;
        message = "This photo changed. Reopen the profile before saving again.";
      } else if (detail.includes("photo_missing_profile")) {
        status = 404;
        message = "Profile not found.";
      } else if (detail.includes("booking_slots.")) {
        status = 409;
        message =
          "That therapist or table is already booked. Choose another time or resource.";
      } else if (detail.includes("therapist_unavailable")) {
        status = 409;
        message = "The therapist is not available at this time.";
      } else if (detail.includes("existing_appointments")) {
        status = 409;
        message =
          "Existing appointments conflict with these working hours. Move them first.";
      } else if (detail.includes("room_capacity")) {
        status = 400;
        message = "Choose a valid table for this room.";
      } else if (detail.includes("redeemed_appointment_locked")) {
        status = 409;
        message =
          "Reverse the voucher use in Sales before changing this appointment. Notes can still be edited.";
      } else if (detail.includes("UNIQUE constraint failed")) {
        status = 409;
        message =
          "These details already exist. Refresh or select the existing record.";
      } else if (detail.includes("FOREIGN KEY constraint failed")) {
        status = 400;
        message =
          "A selected client, therapist, room or treatment no longer exists.";
      }
      return secureHeaders(json({ error: message }, status));
    }
  },
};
