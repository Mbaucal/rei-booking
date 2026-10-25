import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import {
  HISTORY_ARCHIVE_SCHEMA,
  ensureHistoryArchiveSchema,
} from "../src/history-archive-schema.mjs";
import {
  HISTORY_BULK_SCHEMA,
  ensureHistoryBulkSchema,
} from "../src/history-bulk-schema.mjs";
import {
  historyIdentityMigration,
  ensureHistoryIdentitySchema,
} from "../src/history-identity-schema.mjs";

function binding(sqlite) {
  let failOnce = false;
  function prepare(sql, values = []) {
    return {
      bind(...args) {
        return prepare(sql, args);
      },
      execute() {
        if (failOnce && sql === "DROP TABLE history_archive") {
          failOnce = false;
          throw new Error("Injected migration interruption");
        }
        const q = sqlite.prepare(sql);
        return {
          results: q.columns().length
            ? q.all(...values)
            : (q.run(...values), []),
        };
      },
    };
  }
  return {
    prepare,
    failMigrationOnce() {
      failOnce = true;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((q) => q.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function legacyFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('owner');
    CREATE TABLE clients(id TEXT PRIMARY KEY); INSERT INTO clients VALUES('client'),('other');
    CREATE TABLE appointments(id TEXT PRIMARY KEY);
    CREATE TABLE history_preview_rows(preview_id TEXT,record_json TEXT);
  `);
  for (const sql of [...HISTORY_ARCHIVE_SCHEMA, ...HISTORY_BULK_SCHEMA])
    sqlite.exec(sql);
  sqlite.exec(`INSERT INTO history_imports VALUES('import','owner','req','hash','commit','fresha','preview',1,'{"originalReceipt":true}','2026-10-25');
    INSERT INTO history_archive_refs VALUES('fresha','ref','reference','appointment');
    INSERT INTO history_archive VALUES('archived','import','fresha','ref','','client','evidence','New','unknown','2026-09-01',600,60,'{"sourceClientLabel":"Source person","raw":{"netSales":"4700"}}','2026-10-25');
    INSERT INTO history_import_jobs(id,owner_id,request_id,input_hash,preview_id,preview_version,source,phase,total,counts_json,client_revision,archive_revision,native_revision,confirmation_token,created_at,updated_at)
      VALUES('job','owner','req','input','preview',1,'fresha','reviewing',1,'{}',0,1,0,'token',1,1);
    INSERT INTO history_import_job_keys VALUES('job','ref','','evidence','client','archived');
  `);
  return { sqlite, db: binding(sqlite) };
}
const rows = (sqlite, table) =>
  sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
const revision = (sqlite) =>
  sqlite.prepare("SELECT revision FROM history_archive_state WHERE id=1").get()
    .revision;
function addUnlinked(sqlite) {
  sqlite.exec(`INSERT INTO history_archive_refs VALUES('fresha','unlinked','reference-two','appointment');
    INSERT INTO history_archive VALUES('unlinked','import','fresha','unlinked','',NULL,'evidence-two','New','unknown','2026-09-02',600,60,'{"sourceClientLabel":"Second person"}','2026-10-25');
    INSERT INTO history_archive_client_links(archive_id,client_id,created_by,created_at) VALUES('unlinked','other','owner','2026-10-25');`);
}

test("identity migration file matches the runtime upgrade sequence", async () => {
  assert.equal(
    await readFile("migrations/0016_history_identity.sql", "utf8"),
    historyIdentityMigration().join(";\n\n") + ";\n",
  );
});
test("populated legacy archive upgrade preserves evidence, references, receipts, keys and revision", async () => {
  const { sqlite, db } = legacyFixture();
  try {
    const tables = [
        "history_archive",
        "history_archive_refs",
        "history_imports",
        "history_import_job_keys",
      ],
      before = tables.map((name) => rows(sqlite, name));
    await ensureHistoryArchiveSchema(db);
    assert.deepEqual(
      tables.map((name) => rows(sqlite, name)),
      before,
    );
    assert.equal(revision(sqlite), 1);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COALESCE(p.allow_unlinked_clients,0) AS allow_unlinked_clients FROM history_import_jobs j LEFT JOIN history_import_job_policies p ON p.job_id=j.id",
        )
        .get().allow_unlinked_clients,
      0,
    );
    assert.equal(
      sqlite
        .prepare("PRAGMA table_info(history_archive)")
        .all()
        .find((c) => c.name === "client_id").notnull,
      0,
    );
    assert.equal(
      sqlite
        .prepare("PRAGMA table_info(history_import_job_keys)")
        .all()
        .find((c) => c.name === "client_id").notnull,
      0,
    );
    assert.throws(
      () => sqlite.exec("UPDATE history_archive SET evidence_hash='changed'"),
      /history_archive_immutable/,
    );
    assert.throws(
      () => sqlite.exec("DELETE FROM history_archive"),
      /history_archive_immutable/,
    );
    assert.throws(
      () =>
        sqlite.exec(
          "INSERT INTO history_archive_client_links VALUES('archived','other',1,'owner','today')",
        ),
      /history_client_link_target/,
    );
    addUnlinked(sqlite);
    sqlite.exec("INSERT INTO history_import_job_policies VALUES('job',1)");
    assert.equal(revision(sqlite), 3);
    assert.equal(
      sqlite
        .prepare("SELECT client_id FROM history_archive WHERE id='unlinked'")
        .get().client_id,
      null,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT client_id FROM history_archive_effective WHERE id='unlinked'",
        )
        .get().client_id,
      "other",
    );
    assert.throws(
      () =>
        sqlite.exec(
          "UPDATE history_archive_client_links SET client_id='client'",
        ),
      /history_client_link_immutable/,
    );
    assert.throws(
      () => sqlite.exec("DELETE FROM history_archive_client_links"),
      /history_client_link_immutable/,
    );
    await ensureHistoryArchiveSchema(db);
    await ensureHistoryBulkSchema(db);
    await ensureHistoryIdentitySchema(binding(sqlite));
    assert.equal(revision(sqlite), 3);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});
test("stale concurrent rebuild preserves existing overlay foreign keys and immutable revision", async () => {
  const { sqlite, db } = legacyFixture();
  try {
    await Promise.all([
      ensureHistoryIdentitySchema(db),
      ensureHistoryIdentitySchema(binding(sqlite)),
    ]);
    addUnlinked(sqlite);
    sqlite.exec("INSERT INTO history_import_job_policies VALUES('job',1)");
    const before = rows(sqlite, "history_archive"),
      links = rows(sqlite, "history_archive_client_links");
    // A second isolate can have already read the old schema before the first wins.
    // Replaying its rebuild must also be safe after client links exist.
    await db.batch(historyIdentityMigration().map((q) => db.prepare(q)));
    assert.deepEqual(rows(sqlite, "history_archive"), before);
    assert.deepEqual(rows(sqlite, "history_archive_client_links"), links);
    assert.equal(revision(sqlite), 3);
    assert.equal(
      sqlite
        .prepare(
          "SELECT allow_unlinked_clients FROM history_import_job_policies WHERE job_id='job'",
        )
        .get().allow_unlinked_clients,
      1,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT client_id FROM history_archive_effective WHERE id='unlinked'",
        )
        .get().client_id,
      "other",
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(
      () =>
        sqlite.exec(
          "INSERT INTO history_archive_client_links VALUES('missing','other',1,'owner','today')",
        ),
      /history_client_link_target/,
    );
  } finally {
    sqlite.close();
  }
});
test("interrupted schema rebuild rolls back entirely and retries with the original evidence intact", async () => {
  const { sqlite, db } = legacyFixture();
  try {
    const before = rows(sqlite, "history_archive");
    db.failMigrationOnce();
    await assert.rejects(
      ensureHistoryIdentitySchema(db),
      /Injected migration interruption/,
    );
    assert.deepEqual(rows(sqlite, "history_archive"), before);
    assert.equal(
      sqlite
        .prepare("PRAGMA table_info(history_archive)")
        .all()
        .find((c) => c.name === "client_id").notnull,
      1,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%identity_upgrade'",
        )
        .get().n,
      0,
    );
    await ensureHistoryIdentitySchema(db);
    assert.deepEqual(rows(sqlite, "history_archive"), before);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});

test("real D1 atomically upgrades legacy history and can rebuild after reviewed links exist", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-09-22",
      d1Databases: { DB: "identity-schema" },
      log: new Log(LogLevel.ERROR),
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await db.batch(
      [
        "CREATE TABLE users(id TEXT PRIMARY KEY)",
        "INSERT INTO users VALUES('owner')",
        "CREATE TABLE clients(id TEXT PRIMARY KEY)",
        "INSERT INTO clients VALUES('client'),('other')",
        "CREATE TABLE appointments(id TEXT PRIMARY KEY)",
        "CREATE TABLE history_preview_rows(preview_id TEXT,record_json TEXT)",
        ...HISTORY_ARCHIVE_SCHEMA,
        ...HISTORY_BULK_SCHEMA,
        `INSERT INTO history_imports VALUES('import','owner','req','hash','commit','fresha','preview',1,'{}','2026-10-25')`,
        "INSERT INTO history_archive_refs VALUES('fresha','ref','reference','appointment')",
        `INSERT INTO history_archive VALUES('old','import','fresha','ref','','client','evidence','New','unknown','2026-09-01',600,60,'{"raw":"unchanged"}','2026-10-25')`,
      ].map((sql) => db.prepare(sql)),
    );
    await ensureHistoryIdentitySchema(db);
    const old = await db
      .prepare("SELECT * FROM history_archive WHERE id='old'")
      .first();
    await db.batch(
      [
        "INSERT INTO history_archive_refs VALUES('fresha','new','new-reference','appointment')",
        `INSERT INTO history_archive VALUES('new','import','fresha','new','',NULL,'other-evidence','New','unknown','2026-09-02',600,60,'{"raw":"also unchanged"}','2026-10-25')`,
        "INSERT INTO history_archive_client_links VALUES('new','other',1,'owner','2026-10-25')",
      ].map((sql) => db.prepare(sql)),
    );
    await db.batch(historyIdentityMigration().map((sql) => db.prepare(sql)));
    assert.deepEqual(
      await db.prepare("SELECT * FROM history_archive WHERE id='old'").first(),
      old,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT client_id FROM history_archive WHERE id='new'")
          .first()
      ).client_id,
      null,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT client_id FROM history_archive_effective WHERE id='new'",
          )
          .first()
      ).client_id,
      "other",
    );
    assert.equal(
      (
        await db
          .prepare("SELECT revision FROM history_archive_state WHERE id=1")
          .first()
      ).revision,
      3,
    );
    assert.deepEqual(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
      [],
    );
    await assert.rejects(
      db.prepare("DELETE FROM history_archive WHERE id='old'").run(),
      /history_archive_immutable/,
    );
  } finally {
    await mf.dispose();
  }
});
