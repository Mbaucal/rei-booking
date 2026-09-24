import { decode, encode } from "./photo-codec.mjs";
import { fail, requireRole, readJSON } from "./security.mjs";
import { integer } from "./domain.mjs";
export function photoInput(value) {
  if (!value || typeof value !== "object")
    fail(400, "Choose a photo or remove the existing one.");
  const version = integer(value.version, 0, 100000000, "photo version");
  if (value.data === null)
    return { version, jpeg: null, width: null, height: null };
  if (
    typeof value.data !== "string" ||
    value.data.length > 204800 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    )
  )
    fail(400, "Upload a valid processed JPEG portrait.");
  const bytes = Buffer.from(value.data, "base64");
  if (
    bytes.length < 4 ||
    bytes.length > 153600 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[bytes.length - 2] !== 255 ||
    bytes[bytes.length - 1] !== 217
  )
    fail(
      400,
      "The photo is not a valid JPEG. Choose the original image again.",
    );
  let image;
  try {
    image = decode(bytes, {
      useTArray: true,
      tolerantDecoding: false,
      maxResolutionInMP: 0.27,
      maxMemoryUsageInMB: 16,
    });
  } catch {
    fail(
      400,
      "The photo could not be read. Choose a different JPG, PNG or WebP image.",
    );
  }
  if (image.width > 512 || image.height > 512)
    fail(400, "The processed portrait must be at most 512 pixels per side.");
  // Re-encode only decoded pixels, discarding metadata, comments and appended content.
  const jpeg = encode(
    { width: image.width, height: image.height, data: image.data },
    80,
  ).data;
  if (jpeg.length > 153600)
    fail(400, "The processed photo is too large. Choose a simpler image.");
  return {
    version,
    jpeg: new Uint8Array(jpeg),
    width: image.width,
    height: image.height,
  };
}
export function photoStatement(db, user, kind, id, p, afterEntity = false) {
  return db
    .prepare(
      `INSERT INTO profile_photos(kind,entity_id,version,expected_version,jpeg,width,height,updated_by,updated_at)
 SELECT ?,?,?,?,?,?,?,?,? ${afterEntity ? "WHERE changes()=1" : "WHERE 1"}
 ON CONFLICT(kind,entity_id) DO UPDATE SET version=excluded.version,expected_version=excluded.expected_version,jpeg=excluded.jpeg,width=excluded.width,height=excluded.height,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    )
    .bind(
      kind,
      id,
      p.version + 1,
      p.version,
      p.jpeg,
      p.width,
      p.height,
      user.id,
      new Date().toISOString(),
    );
}
export async function addPhotoMetadata(db, kind, records) {
  if (!records.length) return records;
  const meta = [];
  // Keep each statement below D1's bound-parameter limit, including kind.
  for (let start = 0; start < records.length; start += 80) {
    const chunk = records.slice(start, start + 80);
    const page = await db
      .prepare(
        `SELECT entity_id,version,jpeg IS NOT NULL AS present FROM profile_photos WHERE kind=? AND entity_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(kind, ...chunk.map((r) => r.id))
      .all();
    meta.push(...page.results);
  }
  const byId = new Map(meta.map((r) => [r.entity_id, r]));
  return records.map((r) => ({
    ...r,
    photoVersion: byId.get(r.id)?.version || 0,
    hasPhoto: !!byId.get(r.id)?.present,
  }));
}
export async function photoRoute(request, db, user, kind, id) {
  if (kind === "clients") requireRole(user, "owner", "reception");
  else if (!["GET", "HEAD"].includes(request.method))
    requireRole(user, "owner");
  const exists = await db
    .prepare(`SELECT id FROM ${kind} WHERE id=?`)
    .bind(id)
    .first();
  if (!exists) fail(404, "Profile not found.");
  if (["GET", "HEAD"].includes(request.method)) {
    const row = await db
      .prepare("SELECT jpeg FROM profile_photos WHERE kind=? AND entity_id=?")
      .bind(kind, id)
      .first();
    if (!row?.jpeg) fail(404, "No profile photo.");
    return new Response(
      request.method === "HEAD" ? null : new Uint8Array(row.jpeg),
      {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Disposition": 'inline; filename="profile.jpg"',
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  if (request.method === "PUT") {
    const input = photoInput(await readJSON(request, 210000));
    await photoStatement(db, user, kind, id, input).run();
    return Response.json({
      ok: true,
      photoVersion: input.version + 1,
      hasPhoto: input.jpeg !== null,
    });
  }
  fail(405, "This photo action is not supported.");
}
