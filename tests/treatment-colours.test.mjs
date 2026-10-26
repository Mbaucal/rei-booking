import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { digest, token } from "../src/security.mjs";
import { ensureHistorySalonSchema } from "../src/history-salon-schema.mjs";
import {
  TREATMENT_COLOURS,
  suggestedTreatmentColour,
  ensureImportedTreatmentColours,
} from "../src/treatment-colours.mjs";

function statements(input) {
  const out = [];
  let current = "";
  for (const line of input.split("\n")) {
    current += `${line}\n`;
    if (
      current.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    out.push(current.trim());
    current = "";
  }
  assert.equal(current.trim(), "");
  return out;
}

test("treatment palette groups real menu naming patterns across durations", () => {
  const groups = {
    combination: [
      "Rei Combination 60min",
      "REI COMBINATION 90 min",
      "Rei Combination90min",
    ],
    thai: ["NUAD Thai 60", "Nuad Thai 90", "NUAD Thai60"],
    aroma: [
      "Relaxing Aroma Oil 45 min",
      "Relaxing Aroma Oil Massage 2h",
      "Relaxing Aroma Oil90min",
    ],
    foot: ["Foot 30", "Foot 60 min (Package only)", "Foot60min"],
    facial: ["H & F 30 (Package only)", "Head & Facial 60", "H and F 45"],
    back: ["HBNS 45 (Package only)", "BNSH 30", "Back Neck & Shoulders 60"],
    other: ["Additional 30min for gift card 60+30", "Fictional new treatment"],
  };
  assert.equal(new Set(TREATMENT_COLOURS.map((entry) => entry.color)).size, 7);
  for (const [key, names] of Object.entries(groups)) {
    const color = TREATMENT_COLOURS.find((entry) => entry.key === key).color;
    for (const name of names)
      assert.equal(suggestedTreatmentColour(name), color);
  }
});

test("import palette upgrade is guarded, audited, repeatable and leaves manual choices authoritative", async (t) => {
  const origin = "https://palette.example";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: (await readdir("src"))
        .filter((file) => file.endsWith(".mjs"))
        .sort((a, b) => (a === "worker.mjs" ? -1 : b === "worker.mjs" ? 1 : 0))
        .map((file) => ({ type: "ESModule", path: resolve("src", file) })),
      modulesRoot: resolve("src"),
      compatibilityDate: "2026-09-22",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { APP_ORIGIN: origin, APP_ENV: "test", EMAIL_ENABLED: "false" },
      d1Databases: { DB: "palette-tests" },
      log: new Log(LogLevel.ERROR),
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  await db.batch(
    statements(await readFile("migrations/0001_core.sql", "utf8")).map((q) =>
      db.prepare(q),
    ),
  );
  const sessions = {};
  for (const role of ["owner", "reception"]) {
    const raw = token();
    sessions[role] = raw;
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
      role,
      `${role}@example.test`,
      `Fictional ${role}`,
      "unused",
      role,
      "2026-10-01",
    ).run();
    await sql(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      role,
      token(),
      Date.now() + 3600000,
      "2026-10-01",
    ).run();
  }
  const schemaBefore = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
  ).results;
  await ensureImportedTreatmentColours(db, "owner");
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
    ).results,
    schemaBefore,
    "palette does not initialize history schema",
  );
  await ensureHistorySalonSchema(db);
  const createdAt = "2026-10-20T10:00:00.000Z";
  await sql(
    "INSERT INTO history_salon_receipts(id,owner_id,request_id,body_hash,mutation_token,result_json,created_at) VALUES('receipt','owner','request','hash','mutation',?,?)",
    JSON.stringify({ createdServices: 10 }),
    createdAt,
  ).run();
  async function seed(id, name, changes = {}) {
    const entry = {
      color: "#2e87a0",
      version: 1,
      createdAt,
      updatedAt: createdAt,
      linked: true,
      linkCreatedAt: createdAt,
      ...changes,
    };
    await sql(
      "INSERT INTO services(id,name,duration,price_cents,color,version,created_at,updated_at) VALUES(?,?,60,470000,?,?,?,?)",
      id,
      name,
      entry.color,
      entry.version,
      entry.createdAt,
      entry.updatedAt,
    ).run();
    if (entry.linked)
      await sql(
        "INSERT INTO history_catalogue_links(kind,source,label_key,duration,entity_id,created_by,created_at) VALUES('service','fictional',?,60,?,'owner',?)",
        id,
        id,
        entry.linkCreatedAt,
      ).run();
  }
  await seed("combo", "Rei Combination 60min");
  await seed("thai", "NUAD Thai 60", { color: "#2E87A0" });
  await seed("aroma", "Relaxing Aroma Oil 60");
  await seed("custom", "Foot 60", { color: "#abcdef" });
  await seed("manual-blue", "Foot 60", { version: 2 });
  await seed("unlinked", "Foot 60", { linked: false });
  await seed("preexisting", "Foot 60", {
    createdAt: "2026-10-19",
    updatedAt: "2026-10-19",
  });
  await seed("no-receipt", "Foot 60", {
    createdAt: "2026-10-21",
    updatedAt: "2026-10-21",
    linkCreatedAt: "2026-10-21",
  });
  await seed("changed", "Foot 60", { updatedAt: "2026-10-21" });
  const before = (await db.prepare("SELECT * FROM services ORDER BY id").all())
    .results;
  async function catalogue(role) {
    const r = await mf.dispatchFetch(`${origin}/api/catalogue`, {
      headers: { cookie: `__Host-rei_session=${sessions[role]}` },
    });
    assert.equal(r.status, 200);
    return r.json();
  }
  await catalogue("reception");
  assert.deepEqual(
    (await db.prepare("SELECT * FROM services ORDER BY id").all()).results,
    before,
  );
  const result = await catalogue("owner");
  assert.deepEqual(result.treatmentColours, TREATMENT_COLOURS);
  for (const previous of before) {
    const current = await sql(
      "SELECT * FROM services WHERE id=?",
      previous.id,
    ).first();
    if (["combo", "thai", "aroma"].includes(previous.id)) {
      assert.equal(current.color, suggestedTreatmentColour(current.name));
      assert.equal(current.version, 2);
      assert.notEqual(current.updated_at, previous.updated_at);
      assert.deepEqual(
        {
          ...current,
          color: previous.color,
          version: previous.version,
          updated_at: previous.updated_at,
        },
        previous,
      );
    } else assert.deepEqual(current, previous);
  }
  const audit = (
    await db
      .prepare(
        "SELECT * FROM audit_log WHERE action='apply_treatment_palette' ORDER BY entity_id",
      )
      .all()
  ).results;
  assert.equal(audit.length, 3);
  assert.ok(audit.every((entry) => entry.actor_id === "owner"));
  assert.equal(JSON.parse(audit[0].before_json).version, 1);
  assert.equal(JSON.parse(audit[0].after_json).version, 2);
  await catalogue("owner");
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM audit_log WHERE action='apply_treatment_palette'",
        )
        .first()
    ).n,
    3,
  );

  // A new DB facade models another Worker isolate. The version guard prevents
  // another upgrade and protects an owner explicitly choosing the old blue.
  const facade = () => ({
    prepare: (...args) => db.prepare(...args),
    batch: (...args) => db.batch(...args),
  });
  await sql(
    "UPDATE services SET color='#2e87a0',version=version+1 WHERE id='combo'",
  ).run();
  await ensureImportedTreatmentColours(facade(), "owner");
  assert.equal(
    (await sql("SELECT color FROM services WHERE id='combo'").first()).color,
    "#2e87a0",
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM audit_log WHERE action='apply_treatment_palette'",
        )
        .first()
    ).n,
    3,
  );

  await seed("race", "Foot 60");
  const racingDb = facade();
  racingDb.batch = async (prepared) => {
    await sql(
      "UPDATE services SET color='#123456',version=2 WHERE id='race'",
    ).run();
    return db.batch(prepared);
  };
  await ensureImportedTreatmentColours(racingDb, "owner");
  assert.equal(
    (await sql("SELECT color FROM services WHERE id='race'").first()).color,
    "#123456",
  );
  assert.equal(
    (
      await sql(
        "SELECT count(*) AS n FROM audit_log WHERE action='apply_treatment_palette' AND entity_id='race'",
      ).first()
    ).n,
    0,
  );

  await seed("atomic", "H & F 30");
  await db
    .prepare(
      "CREATE TRIGGER reject_palette BEFORE UPDATE ON services WHEN NEW.id='atomic' AND NEW.version=2 BEGIN SELECT RAISE(ABORT,'fictional update failure'); END",
    )
    .run();
  const retryDb = facade();
  await assert.rejects(
    ensureImportedTreatmentColours(retryDb, "owner"),
    /fictional update failure/,
  );
  assert.equal(
    (await sql("SELECT color FROM services WHERE id='atomic'").first()).color,
    "#2e87a0",
  );
  assert.equal(
    (
      await sql(
        "SELECT count(*) AS n FROM audit_log WHERE action='apply_treatment_palette' AND entity_id='atomic'",
      ).first()
    ).n,
    0,
    "the earlier audit insert rolls back if the color update fails",
  );
  await db.prepare("DROP TRIGGER reject_palette").run();
  await ensureImportedTreatmentColours(retryDb, "owner");
  assert.equal(
    (await sql("SELECT color FROM services WHERE id='atomic'").first()).color,
    suggestedTreatmentColour("H & F 30"),
  );
});
