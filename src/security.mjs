import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};
export function validatePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    fail(400, "Use a password of 12–128 characters.");
  return value;
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$8$3$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 128) return false;
  const parts = String(stored).split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== "32768" ||
    parts[2] !== "8" ||
    parts[3] !== "3" ||
    !/^[a-f0-9]{32}$/.test(parts[4]) ||
    !/^[a-f0-9]{64}$/.test(parts[5])
  )
    return false;
  const actual = await derive(password, parts[4], 32, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, Buffer.from(parts[5], "hex"));
}
export const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  role: user.role,
  therapistId: user.therapist_id,
});
export function requireRole(user, ...roles) {
  if (!roles.includes(user.role))
    fail(403, "You do not have access to this action.");
}
export function sessionCookie(value, secure, expired = false) {
  return `${secure ? "__Host-rei_session" : "rei_session"}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : 43200}${secure ? "; Secure" : ""}`;
}
export function readSessionToken(request) {
  const name =
    new URL(request.url).protocol === "https:"
      ? "__Host-rei_session"
      : "rei_session";
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
export function secureHeaders(response) {
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return out;
}
export async function readJSON(request, maxBytes = 65536) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    fail(415, "Send JSON data.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Missing request data.");
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      fail(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    fail(400, "Invalid request data.");
  }
}
