import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { encode, decode } from "../src/photo-codec.mjs";
import { PHOTO_SCHEMA } from "../src/photo-schema.mjs";
import { addPhotoMetadata } from "../src/photos.mjs";
import { createPhotoDraft, processPhoto } from "../public/photos.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { digest, token } from "../src/security.mjs";

const ORIGIN = "https://redemption.example";
function statements(sql) {
  const result = [];
  let part = "";
  for (const line of sql.split("\n")) {
    part += line + "\n";
    if (
      part.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    result.push(part.trim());
    part = "";
  }
  assert.equal(part.trim(), "");
  return result;
}
test("Private profile photos: processing, transactional storage and role boundaries", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-photo-"));
  const options = convertV4MiniflareOptions({
    modules: [
      "worker.mjs",
      "photos.mjs",
      "photo-schema.mjs",
      "photo-codec.mjs",
      "security.mjs",
      "domain.mjs",
      "reports.mjs",
      "report-schema.mjs",
      "sales.mjs",
      "sales-schema.mjs",
      "redemption-schema.mjs",
      "voucher-redemption.mjs",
      "voucher-changes.mjs",
      "voucher-change-schema.mjs",
      "voucher-render.mjs",
      "voucher-email.mjs",
    ].map((f) => ({ type: "ESModule", path: resolve("src", f) })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: ORIGIN, APP_ENV: "test" },
    d1Databases: { DB: "redemption-tests" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("DB");
  for (const sql of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(sql).run();
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  const sessions = {};
  for (const role of ["owner", "reception", "therapist"]) {
    const raw = token(),
      csrf = token();
    sessions[role] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      role,
      role + "@example.test",
      role,
      "test-only-unused",
      role === "therapist" ? "reception" : role,
      new Date().toISOString(),
    ).run();
    await sql(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      role,
      csrf,
      Date.now() + 3600000,
      new Date().toISOString(),
    ).run();
  }
  async function raw(path, method = "GET", body, role = "owner", headers = {}) {
    const session = sessions[role];
    return mf.dispatchFetch(ORIGIN + "/api" + path, {
      method,
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(session
          ? {
              cookie: "__Host-rei_session=" + session.raw,
              "x-csrf-token": session.csrf,
            }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function request(...args) {
    const r = await raw(...args);
    return { status: r.status, data: await r.json() };
  }
  async function create(path, body) {
    const r = await request(path, "POST", body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const tid = (await create("/therapists", { name: "Gift therapist" })).id;
  await sql(
    "UPDATE users SET role='therapist',therapist_id=? WHERE id='therapist'",
    tid,
  ).run();
  const serviceId = (
    await create("/services", {
      name: "Gift massage",
      duration: 60,
      priceCents: 470000,
      color: "#2e87a0",
    })
  ).id;
  const secondServiceId = (
    await create("/services", {
      name: "Another massage",
      duration: 60,
      priceCents: 470000,
      color: "#2e87a0",
    })
  ).id;

  const makeImage = (width = 3, height = 2) =>
    encode(
      {
        width,
        height,
        data: new Uint8Array(width * height * 4).fill(170),
        comments: ["PRIVATE EXIF-LIKE COMMENT"],
      },
      80,
    ).data.toString("base64");
  const original = makeImage();
  const client = (
    await create("/clients", {
      name: "Photo Client",
      phone: "+381601234567",
      photo: { version: 0, data: original },
    })
  ).id;
  const path = "/photos/clients/" + client;
  const profile = async () => (await request("/clients/" + client)).data.client;
  await t.test(
    "processed portraits persist and metadata is stripped; schema can be reapplied",
    async () => {
      assert.equal(
        await readFile("migrations/0006_profile_photos.sql", "utf8"),
        PHOTO_SCHEMA.map((s) => s + ";").join("\n\n") + "\n",
      );
      await db.batch(PHOTO_SCHEMA.map((s) => db.prepare(s)));
      const r = await raw(path);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/jpeg");
      assert.match(r.headers.get("cache-control"), /no-store/);
      assert.equal(
        r.headers.get("cross-origin-resource-policy"),
        "same-origin",
      );
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.ok(!bytes.toString().includes("PRIVATE EXIF-LIKE COMMENT"));
      const image = decode(bytes);
      assert.equal(image.width, 3);
      assert.equal(image.height, 2);
      assert.equal((await profile()).hasPhoto, true);
      assert.equal((await profile()).photoVersion, 1);
      assert.equal(
        (await request("/clients?q=Photo")).data.clients[0].hasPhoto,
        true,
      );
      const audit = (await request("/audit")).data.events.filter(
        (e) => e.entity_id === client,
      );
      assert.ok(audit.some((e) => e.action === "save_photo"));
      assert.ok(!JSON.stringify(audit).includes(original));
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      const after = await raw(path);
      assert.equal(after.status, 200);
      assert.deepEqual(Buffer.from(await after.arrayBuffer()), bytes);
    },
  );
  await t.test(
    "only permitted roles read/write images; unauthenticated, cross-origin and stale sessions fail",
    async () => {
      assert.equal(
        (await raw(path, "GET", undefined, "reception")).status,
        200,
      );
      for (const method of ["GET", "HEAD", "PUT"])
        for (const role of ["anonymous", "therapist"]) {
          assert.equal(
            (
              await raw(
                path,
                method,
                method === "PUT" ? { version: 1, data: null } : undefined,
                role,
              )
            ).status,
            role === "anonymous" ? 401 : 403,
          );
        }
      assert.equal(
        (
          await request(path, "PUT", { version: 1, data: null }, "owner", {
            "x-csrf-token": "wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(path, "PUT", { version: 1, data: null }, "owner", {
            origin: "https://foreign.example",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "/photos/clients/missing",
            "GET",
            undefined,
            "therapist",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "/photos/therapists/" + tid,
            "PUT",
            { version: 0, data: original },
            "reception",
          )
        ).status,
        403,
      );
      const saved = await request("/photos/therapists/" + tid, "PUT", {
        version: 0,
        data: original,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.equal(
        (await raw("/photos/therapists/" + tid, "GET", undefined, "therapist"))
          .status,
        200,
      );
      const catalogue = (
        await request("/catalogue", "GET", undefined, "therapist")
      ).data;
      assert.equal(
        catalogue.therapists.find((t) => t.id === tid).hasPhoto,
        true,
      );
      assert.ok(!JSON.stringify(catalogue).includes("Photo Client"));
      const appt = await create("/appointments", {
        date: "2026-09-24",
        start: 600,
        duration: 60,
        serviceId,
        therapistId: tid,
        roomId: "r1",
        bed: 0,
        clientId: client,
        status: "booked",
      });
      const calendar = (
        await request(
          "/appointments?from=2026-09-24",
          "GET",
          undefined,
          "therapist",
        )
      ).data;
      assert.ok(!JSON.stringify(calendar).includes(client));
      assert.ok(!JSON.stringify(calendar).includes("photo"));
      assert.ok(!JSON.stringify(calendar).includes("Photo Client"));
    },
  );
  await t.test(
    "invalid images, dimensions and oversized requests preserve the existing photo",
    async () => {
      const initial = Buffer.from(await (await raw(path)).arrayBuffer());
      for (const data of [
        "",
        Buffer.from('<svg onload="alert(1)"></svg>').toString("base64"),
        "/9j/2Q==",
        makeImage(513, 1),
        "A".repeat(204804),
      ]) {
        const r = await request(path, "PUT", { version: 1, data });
        assert.equal(r.status, 400, JSON.stringify(r.data));
      }
      assert.equal(
        (await request(path, "PUT", { version: 1, data: "A".repeat(260000) }))
          .status,
        413,
      );
      assert.deepEqual(
        Buffer.from(await (await raw(path)).arrayBuffer()),
        initial,
      );
      assert.equal((await profile()).photoVersion, 1);
    },
  );
  await t.test(
    "team/client form commits photo atomically; failures roll back fields, bonus and image",
    async () => {
      const clientBefore = await profile();
      let r = await request("/clients/" + client, "PUT", {
        ...clientBefore,
        name: "Must not save",
        photo: { version: 1, data: "bad" },
      });
      assert.equal(r.status, 400);
      assert.equal((await profile()).name, clientBefore.name);
      const body = {
        name: "Changed therapist",
        version: 1,
        bonus: { mode: "hourly", regularRate: 11100, requestedRate: 55500 },
        photo: { version: 0, data: original },
      };
      r = await request("/therapists/" + tid, "PUT", body);
      assert.equal(r.status, 409);
      let t = (await request("/catalogue")).data.therapists.find(
        (t) => t.id === tid,
      );
      assert.equal(t.name, "Gift therapist");
      assert.equal(t.bonus.regularRate, 10000);
      assert.equal(t.version, 1);
      r = await request("/therapists/" + tid, "PUT", {
        ...body,
        photo: { version: 1, data: original },
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      t = (await request("/catalogue")).data.therapists.find(
        (t) => t.id === tid,
      );
      assert.equal(t.name, "Changed therapist");
      assert.equal(t.photoVersion, 2);
      assert.equal(t.version, 2);
      assert.equal(t.bonus.regularRate, 11100);
      // A stale entity edit cannot overwrite a newer photo, even with a valid photo version.
      r = await request("/therapists/" + tid, "PUT", {
        ...body,
        photo: { version: 2, data: null },
      });
      assert.equal(r.status, 409);
      assert.equal((await raw("/photos/therapists/" + tid)).status, 200);
      r = await request("/clients", "POST", {
        name: "Duplicate",
        phone: clientBefore.phone,
        photo: { version: 0, data: original },
      });
      assert.equal(r.status, 409);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) n FROM profile_photos WHERE kind='clients'",
          ).first()
        ).n,
        1,
      );
    },
  );
  await t.test(
    "concurrent replacement has one winner; removal keeps revision and frees bytes",
    async () => {
      const r = await Promise.all([
        request(path, "PUT", { version: 1, data: makeImage(2, 3) }),
        request(path, "PUT", { version: 1, data: makeImage(4, 2) }),
      ]);
      assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
      assert.equal((await profile()).photoVersion, 2);
      assert.equal(
        (await request(path, "PUT", { version: 2, data: null }, "reception"))
          .status,
        200,
      );
      assert.equal((await raw(path)).status, 404);
      assert.equal((await profile()).hasPhoto, false);
      assert.equal((await profile()).photoVersion, 3);
      assert.equal(
        (await request(path, "PUT", { version: 0, data: original })).status,
        409,
      );
      const row = await sql(
        "SELECT jpeg FROM profile_photos WHERE kind='clients' AND entity_id=?",
        client,
      ).first();
      assert.equal(row.jpeg, null);
      assert.equal(
        (await request(path, "PUT", { version: 3, data: original })).status,
        200,
      );
      assert.equal((await profile()).photoVersion, 4);
    },
  );
});

test("photo metadata handles a full client page and larger team catalogue within D1 binding limits", async () => {
  const records = Array.from({ length: 181 }, (_, n) => ({
    id: "id-" + n,
    name: "Profile " + n,
  }));
  const db = {
    prepare(query) {
      assert.ok(!query.includes("SELECT jpeg"));
      return {
        bind(kind, ...ids) {
          assert.equal(kind, "clients");
          assert.ok(
            ids.length + 1 <= 100,
            "D1 supports at most 100 bound parameters",
          );
          return {
            async all() {
              return {
                results: ids
                  .filter((id) => Number(id.slice(3)) % 2 === 0)
                  .map((entity_id) => ({ entity_id, version: 3, present: 1 })),
              };
            },
          };
        },
      };
    },
  };
  for (const size of [0, 100, 181]) {
    const result = await addPhotoMetadata(
      db,
      "clients",
      records.slice(0, size),
    );
    assert.equal(result.length, size);
    result.forEach((r, index) => {
      assert.equal(r.id, records[index].id);
      assert.equal(r.hasPhoto, index % 2 === 0);
      assert.equal(r.photoVersion, index % 2 === 0 ? 3 : 0);
      assert.equal(records[index].hasPhoto, undefined);
    });
  }
});

test("photo drafts ignore late processing after replacement, removal, undo or profile/session change", async () => {
  let active = true;
  const pending = [];
  const process = () =>
    new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const draft = createPhotoDraft(
    "/old-private-photo",
    4,
    () => active,
    process,
  );
  const old = draft.choose({});
  const latest = draft.choose({});
  pending[1].resolve("data:image/jpeg;base64,NEW");
  assert.equal(await latest, true);
  pending[0].resolve("data:image/jpeg;base64,OLD");
  assert.equal(await old, false);
  assert.equal(draft.payload().data, "NEW");
  const removing = draft.choose({});
  draft.remove();
  pending[2].resolve("data:image/jpeg;base64,LATE");
  assert.equal(await removing, false);
  assert.equal(draft.payload().data, null);
  const undoing = draft.choose({});
  draft.undo();
  pending[3].reject(new Error("stale error"));
  assert.equal(await undoing, false);
  assert.equal(draft.payload(), undefined);
  const leaving = draft.choose({});
  assert.throws(() => draft.payload(), /Wait/);
  active = false;
  pending[4].resolve("data:image/jpeg;base64,PRIVATE");
  assert.equal(await leaving, false);
  assert.equal(draft.value, "/old-private-photo");
  assert.throws(() => draft.payload(), /Reopen/);
});
test("browser rejects mismatched signatures, unsupported types and oversized originals before decode", async () => {
  for (const file of [
    new File(["<svg/>"], "fake.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array([255, 216, 255])], "wrong.png", {
      type: "image/png",
    }),
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.jpg", {
      type: "image/jpeg",
    }),
  ])
    await assert.rejects(processPhoto(file));
});

test("browser processing preserves proportions, applies orientation, flattens transparency and releases decoded pixels", async () => {
  const previousDocument = globalThis.document,
    previousBitmap = globalThis.createImageBitmap;
  const calls = [];
  let closed = false;
  globalThis.createImageBitmap = async (_file, options) => {
    calls.push(options);
    return {
      width: 1200,
      height: 600,
      close() {
        closed = true;
      },
    };
  };
  const context = {
    fillRect(...a) {
      calls.push(["fill", ...a]);
    },
    drawImage(...a) {
      calls.push(["draw", ...a.slice(1)]);
    },
  };
  const canvas = {
    getContext() {
      return context;
    },
    toDataURL(type) {
      assert.equal(type, "image/jpeg");
      return "data:image/jpeg;base64,QUJD";
    },
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return canvas;
    },
  };
  try {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    assert.equal(
      await processPhoto(
        new File([bytes], "portrait.png", { type: "image/png" }),
      ),
      "data:image/jpeg;base64,QUJD",
    );
    assert.equal(canvas.width, 512);
    assert.equal(canvas.height, 256);
    assert.equal(context.fillStyle, "#ffffff");
    assert.deepEqual(calls[0], { imageOrientation: "from-image" });
    assert.ok(closed);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previousBitmap;
  }
});
