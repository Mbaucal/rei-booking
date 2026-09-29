import { fail, HttpError } from "./security.mjs";
import { phoneKey } from "./domain.mjs";
export const CLIENT_CONTACT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS client_instagram (client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE, instagram TEXT UNIQUE CHECK(instagram IS NULL OR length(instagram) BETWEEN 1 AND 30))`,
];
const initialized = new WeakMap();
export async function ensureClientContacts(db) {
  let p = initialized.get(db);
  if (!p) {
    p = db.batch(CLIENT_CONTACT_SCHEMA.map((q) => db.prepare(q))).catch((e) => {
      initialized.delete(db);
      throw e;
    });
    initialized.set(db, p);
  }
  await p;
}
export function instagramHandle(value = "") {
  if (typeof value !== "string" || value.length > 250)
    fail(400, "Enter a valid Instagram username or profile URL.");
  let handle = value.trim();
  if (!handle) return "";
  if (/^(https?:\/\/)?(www\.)?instagram\.com\//i.test(handle)) {
    let url;
    try {
      url = new URL(/^https?:/i.test(handle) ? handle : "https://" + handle);
    } catch {
      fail(400, "Enter a valid Instagram profile URL.");
    }
    if (
      !["instagram.com", "www.instagram.com"].includes(
        url.hostname.toLowerCase(),
      ) ||
      url.username ||
      url.password ||
      url.port
    )
      fail(400, "Enter an Instagram profile URL.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 1 ||
      [
        "p",
        "reel",
        "reels",
        "stories",
        "explore",
        "direct",
        "accounts",
      ].includes(parts[0].toLowerCase())
    )
      fail(400, "Use an Instagram profile, not a post or reel.");
    handle = parts[0];
  } else handle = handle.replace(/^@/, "");
  if (
    !/^[a-zA-Z0-9_](?:[a-zA-Z0-9_.]{0,28}[a-zA-Z0-9_])?$/.test(handle) ||
    handle.includes("..")
  )
    fail(
      400,
      "Instagram usernames use 1–30 letters, numbers, underscores or dots.",
    );
  return handle.toLowerCase();
}
export function instagramStatement(
  db,
  id,
  handle,
  write = true,
  guarded = false,
) {
  if (!write) return [];
  return [
    db
      .prepare(
        `INSERT INTO client_instagram(client_id,instagram) SELECT ?,? ${guarded ? "WHERE changes()=1" : ""} ON CONFLICT(client_id) DO UPDATE SET instagram=excluded.instagram`,
      )
      .bind(id, handle || null),
  ];
}
export async function clientMatches(db, input, excludeId = "") {
  const phone =
      input.phone_key ??
      phoneKey(typeof input.phone === "string" ? input.phone : ""),
    mail = (input.email_key ?? input.email ?? "").trim().toLowerCase(),
    instagram = instagramHandle(input.instagram ?? "");
  if (!phone && !mail && !instagram) return [];
  const rows = (
    await db
      .prepare(
        `SELECT c.id,c.name,c.phone,c.phone_key,c.email_key,COALESCE(i.instagram,'') AS instagram FROM clients c LEFT JOIN client_instagram i ON i.client_id=c.id WHERE c.id!=? AND (c.id IN(SELECT id FROM clients WHERE phone_key=? UNION SELECT id FROM clients WHERE email_key=? UNION SELECT client_id FROM client_instagram WHERE instagram=?)) ORDER BY c.name`,
      )
      .bind(excludeId, phone, mail, instagram)
      .all()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    instagram: r.instagram,
    matchedOn: [
      ...(phone && phone === r.phone_key ? ["phone"] : []),
      ...(mail && mail === r.email_key ? ["email"] : []),
      ...(instagram && instagram === r.instagram ? ["instagram"] : []),
    ],
  }));
}
export async function assertClientUnique(db, input, excludeId = "") {
  const matches = await clientMatches(db, input, excludeId);
  if (matches.length) {
    const e = new HttpError(
      409,
      "Client already exists: " +
        matches.map((c) => c.name).join(", ") +
        ". Open the existing profile or choose that client.",
    );
    e.matches = matches;
    throw e;
  }
}
export async function contactWrite(db, input, excludeId, operation) {
  await assertClientUnique(db, input, excludeId);
  try {
    return await operation();
  } catch (e) {
    if (String(e.message).includes("UNIQUE constraint failed"))
      await assertClientUnique(db, input, excludeId);
    throw e;
  }
}
