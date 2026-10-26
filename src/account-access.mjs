import { randomUUID } from "node:crypto";
import { email, text } from "./domain.mjs";
import {
  fail,
  hashPassword,
  publicUser,
  readJSON,
  requireRole,
  token,
} from "./security.mjs";
import { ensureAccountAccessSchema } from "./account-access-schema.mjs";

const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const all = async (db, sql, ...args) =>
  (await stmt(db, sql, ...args).all()).results;
const USER =
  "SELECT u.*,v.version FROM users u JOIN account_access_versions v ON v.user_id=u.id";
const STALE = "This account changed. Reload access before saving again.";
const ACTOR = `EXISTS(SELECT 1 FROM sessions s JOIN users actor ON actor.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND actor.id=? AND actor.role='owner' AND actor.active=1 AND actor.must_change_password=0)`;
const actorArgs = (principal) => [
  principal.token_hash,
  Date.now(),
  principal.id,
];
const PROFILE = `(?!='therapist' OR ?=0 OR EXISTS(SELECT 1 FROM therapists WHERE id=? AND active=1))`;

// The original email column is the unique login identifier; contact email stays on Team.
// Keeping the column avoids a destructive users-table migration and preserves recovery tools.
export function loginIdentifier(value) {
  const clean = text(value, 254, "email or username").toLowerCase();
  if (clean.includes("@")) return email(clean, false);
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(clean))
    fail(
      400,
      "Use an email or a username of 3–64 letters, numbers, dots, underscores or hyphens, starting with a letter.",
    );
  return clean;
}
function bodyLogin(body, fallback) {
  if (
    body.login !== undefined &&
    body.email !== undefined &&
    loginIdentifier(body.login) !== loginIdentifier(body.email)
  )
    fail(400, "Enter one login identifier.");
  return loginIdentifier(body.login ?? body.email ?? fallback);
}
export function accountView(row) {
  return {
    id: row.id,
    name: row.name,
    login: row.email,
    role: row.role,
    therapistId: row.therapist_id,
    active: !!row.active,
    mustChangePassword: !!row.must_change_password,
    version: row.version,
  };
}
export const accountSession = (
  principal,
  effective = principal,
  preview = null,
) => ({
  user: publicUser(effective),
  csrf: principal.csrf_token,
  mustChangePassword: preview ? false : !!principal.must_change_password,
  preview,
});
export async function resolveAccountPreview(db, principal) {
  const saved = await one(
    db,
    "SELECT * FROM account_previews WHERE session_token_hash=?",
    principal.token_hash,
  );
  if (!saved) return { user: principal, preview: null };
  const target = await one(
    db,
    `${USER} LEFT JOIN therapists t ON t.id=u.therapist_id WHERE u.id=? AND u.active=1 AND v.version=? AND u.role=? AND (u.role!='therapist' OR t.active=1)`,
    saved.target_user_id,
    saved.target_version,
    saved.target_role,
  );
  const available =
    principal.role === "owner" && !principal.must_change_password && !!target;
  return {
    user: available
      ? target
      : {
          id: saved.target_user_id,
          name: saved.target_name,
          role: saved.target_role,
          therapist_id: saved.target_therapist_id,
        },
    preview: {
      ownerName: principal.name,
      targetName: saved.target_name,
      targetId: saved.target_user_id,
      role: saved.target_role,
      unavailable: !available,
    },
  };
}
function previewEndAudit(db, principal, reason) {
  return stmt(
    db,
    `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'end_preview','user',target_user_id,?,? FROM account_previews WHERE session_token_hash=?`,
    principal.id,
    JSON.stringify({ readOnly: true, reason }),
    new Date().toISOString(),
    principal.token_hash,
  );
}
export async function logoutAccount(db, principal) {
  await db.batch([
    previewEndAudit(db, principal, "logout"),
    stmt(db, "DELETE FROM sessions WHERE token_hash=?", principal.token_hash),
  ]);
}
export async function previewRoute(request, db, principal, currentPreview) {
  requireRole(principal, "owner");
  if (principal.must_change_password)
    fail(403, "Change your temporary password before continuing.");
  if (request.method === "DELETE") {
    const saved = await one(
      db,
      "SELECT * FROM account_previews WHERE session_token_hash=?",
      principal.token_hash,
    );
    if (saved)
      await db.batch([
        previewEndAudit(db, principal, "return_to_owner"),
        stmt(
          db,
          "DELETE FROM account_previews WHERE session_token_hash=?",
          principal.token_hash,
        ),
      ]);
    return Response.json(accountSession(principal));
  }
  if (request.method !== "POST") fail(405, "Use the preview controls.");
  if (currentPreview)
    fail(403, "Return to Owner before opening another member preview.");
  const body = await readJSON(request, 4096),
    id = text(body.userId, 100, "account");
  const target = await one(db, `${USER} WHERE u.id=?`, id);
  if (
    !target ||
    !target.active ||
    !["reception", "therapist"].includes(target.role) ||
    target.id === principal.id
  )
    fail(400, "Choose an active reception or therapist account to preview.");
  if (
    target.role === "therapist" &&
    !(await one(
      db,
      "SELECT id FROM therapists WHERE id=? AND active=1",
      target.therapist_id,
    ))
  )
    fail(400, "Activate the therapist profile before previewing this account.");
  const marker = token(),
    at = new Date().toISOString();
  const results = await db.batch([
    stmt(
      db,
      `INSERT INTO account_previews(session_token_hash,target_user_id,target_version,target_name,target_role,target_therapist_id,mutation_token,created_at)
 SELECT ?,u.id,v.version,u.name,u.role,u.therapist_id,?,? FROM users u JOIN account_access_versions v ON v.user_id=u.id LEFT JOIN therapists t ON t.id=u.therapist_id
 WHERE u.id=? AND v.version=? AND u.active=1 AND u.role IN ('reception','therapist') AND (u.role!='therapist' OR t.active=1)
 AND EXISTS(SELECT 1 FROM sessions s JOIN users owner ON owner.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND owner.id=? AND owner.role='owner' AND owner.active=1 AND owner.must_change_password=0)`,
      principal.token_hash,
      marker,
      at,
      id,
      target.version,
      principal.token_hash,
      Date.now(),
      principal.id,
    ),
    stmt(
      db,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'start_preview','user',target_user_id,?,? FROM account_previews WHERE session_token_hash=? AND mutation_token=?`,
      principal.id,
      JSON.stringify({ role: target.role, readOnly: true }),
      at,
      principal.token_hash,
      marker,
    ),
  ]);
  if (!results[0].meta.changes) fail(409, STALE);
  const effective = await resolveAccountPreview(db, principal);
  return Response.json(
    accountSession(principal, effective.user, effective.preview),
  );
}
async function input(db, body, before = null) {
  const role = body.role ?? before?.role;
  if (!["owner", "reception", "therapist"].includes(role))
    fail(400, "Choose a user role.");
  const active =
    body.active !== undefined ? body.active : before ? !!before.active : true;
  if (typeof active !== "boolean") fail(400, "Set account access.");
  let therapistId =
    body.therapistId !== undefined
      ? body.therapistId
      : (before?.therapist_id ?? null);
  if (therapistId === "") therapistId = null;
  if (therapistId !== null)
    therapistId = text(therapistId, 100, "therapist profile");
  if (role === "therapist" && !therapistId)
    fail(400, "Choose a therapist profile.");
  if (therapistId) {
    const profile = await one(
      db,
      "SELECT id,active FROM therapists WHERE id=?",
      therapistId,
    );
    if (!profile) fail(400, "Choose an existing therapist profile.");
    if (role === "therapist" && active && !profile.active)
      fail(400, "Choose an active therapist profile.");
  }
  return {
    email: bodyLogin(body, before?.email),
    name: text(body.name ?? before?.name, 100, "name"),
    role,
    therapist_id: therapistId,
    active: active ? 1 : 0,
  };
}
async function saveAccount(db, principal, body, id = null) {
  const before = id ? await one(db, `${USER} WHERE u.id=?`, id) : null;
  if (id && !before) fail(404, "Account not found.");
  if (
    id &&
    (!Number.isSafeInteger(body.version) ||
      body.version < 1 ||
      before.version !== body.version)
  )
    fail(409, STALE);
  const values = await input(db, body, before);
  if (id === principal.id) {
    if (!values.active || values.role !== "owner")
      fail(400, "You cannot remove your own owner access.");
    if (body.password) fail(400, "Use Change password for your own account.");
    if (values.email !== before.email)
      fail(400, "Keep your owner login unchanged here.");
  }
  const replacingPassword = body.password !== undefined && body.password !== "";
  const hash =
    before && !replacingPassword
      ? before.password_hash
      : await hashPassword(body.password);
  const required =
    before && !replacingPassword ? before.must_change_password : 1;
  const accountId = id || randomUUID(),
    at = new Date().toISOString();
  if (!id) {
    const results = await db.batch([
      stmt(
        db,
        `INSERT INTO users(id,email,name,password_hash,role,therapist_id,active,must_change_password,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${ACTOR} AND ${PROFILE}`,
        accountId,
        values.email,
        values.name,
        hash,
        values.role,
        values.therapist_id,
        values.active,
        required,
        at,
        ...actorArgs(principal),
        values.role,
        values.active,
        values.therapist_id,
      ),
      stmt(
        db,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,after_json,created_at) SELECT ?,'create','user',?,?,? WHERE changes()=1`,
        principal.id,
        accountId,
        JSON.stringify({ ...values, passwordReset: true }),
        at,
      ),
    ]);
    if (!results[0].meta.changes) fail(409, STALE);
  } else {
    const marker = token(),
      guard =
        "EXISTS(SELECT 1 FROM account_access_versions WHERE user_id=? AND mutation_token=?)";
    const result = await db.batch([
      stmt(
        db,
        `UPDATE account_access_versions SET mutation_token=? WHERE user_id=? AND version=? AND ${ACTOR} AND ${PROFILE}`,
        marker,
        id,
        body.version,
        ...actorArgs(principal),
        values.role,
        values.active,
        values.therapist_id,
      ),
      stmt(
        db,
        `UPDATE users SET email=?,name=?,role=?,therapist_id=?,active=?,password_hash=?,must_change_password=? WHERE id=? AND ${guard}`,
        values.email,
        values.name,
        values.role,
        values.therapist_id,
        values.active,
        hash,
        required,
        id,
        id,
        marker,
      ),
      stmt(
        db,
        `DELETE FROM sessions WHERE user_id=? AND ${guard} AND token_hash!=?`,
        id,
        id,
        marker,
        id === principal.id ? principal.token_hash : "",
      ),
      stmt(
        db,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,before_json,after_json,created_at) SELECT ?,'update_access','user',?,?,?,? WHERE ${guard}`,
        principal.id,
        id,
        JSON.stringify(accountView(before)),
        JSON.stringify({ ...values, passwordReset: replacingPassword }),
        at,
        id,
        marker,
      ),
    ]);
    if (!result[0].meta.changes || !result[1].meta.changes) fail(409, STALE);
  }
  return accountView(await one(db, `${USER} WHERE u.id=?`, accountId));
}
export async function accountAccessRoutes(request, db, principal) {
  const { pathname: path } = new URL(request.url),
    method = request.method;
  const team = path.match(/^\/api\/therapists\/([^/]+)\/access$/),
    account = path.match(/^\/api\/users\/([^/]+)$/),
    active = path.match(/^\/api\/users\/([^/]+)\/active$/);
  if (!(team || path === "/api/users" || account || active)) return null;
  requireRole(principal, "owner");
  await ensureAccountAccessSchema(db);
  if (team && method === "GET") {
    if (!(await one(db, "SELECT id FROM therapists WHERE id=?", team[1])))
      fail(404, "Team member not found.");
    return Response.json({
      accounts: (
        await all(
          db,
          `${USER} WHERE u.therapist_id=? ORDER BY u.name,u.id`,
          team[1],
        )
      ).map(accountView),
    });
  }
  if (path === "/api/users" && method === "GET")
    return Response.json({
      users: (await all(db, `${USER} ORDER BY u.name,u.id`)).map((row) => ({
        ...accountView(row),
        email: row.email,
        therapist_id: row.therapist_id,
        must_change_password: row.must_change_password,
      })),
    });
  if (path === "/api/users" && method === "POST") {
    const account = await saveAccount(
      db,
      principal,
      await readJSON(request, 8192),
    );
    return Response.json({ id: account.id, account }, { status: 201 });
  }
  if (account && method === "PUT")
    return Response.json({
      account: await saveAccount(
        db,
        principal,
        await readJSON(request, 8192),
        account[1],
      ),
    });
  if (active && method === "PUT") {
    const body = await readJSON(request, 4096);
    if (typeof body.active !== "boolean") fail(400, "Set active status.");
    const target = await one(db, `${USER} WHERE u.id=?`, active[1]);
    if (!target) fail(404, "User not found.");
    if (target.id === principal.id)
      fail(400, "You cannot disable your own account.");
    await saveAccount(
      db,
      principal,
      { active: body.active, version: body.version ?? target.version },
      target.id,
    );
    return Response.json({ ok: true });
  }
  fail(405, "This account action is not available.");
}
