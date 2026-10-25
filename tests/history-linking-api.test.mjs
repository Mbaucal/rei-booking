import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { token, digest } from "../src/security.mjs";
import { defaultWeek } from "../src/domain.mjs";

function statements(sql) {
  const result = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
    if (
      current.trim().startsWith("CREATE TRIGGER")
        ? !/^END;\s*$/.test(line)
        : !line.trimEnd().endsWith(";")
    )
      continue;
    result.push(current.trim());
    current = "";
  }
  assert.equal(current.trim(), "");
  return result;
}

test("Unlinked archive Worker + D1: reviewed client identity, atomic links and durable receipts", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "rei-history-links-")),
    origin = "https://history-links.example";
  const options = convertV4MiniflareOptions({
    modules: [
      "worker.mjs",
      ...(await readdir("src")).filter(
        (name) => name.endsWith(".mjs") && name !== "worker.mjs",
      ),
    ].map((name) => ({ type: "ESModule", path: resolve("src", name) })),
    modulesRoot: resolve("src"),
    compatibilityDate: "2026-09-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { APP_ORIGIN: origin, APP_ENV: "test", EMAIL_ENABLED: "false" },
    d1Databases: { DB: "history-link-tests" },
    log: new Log(LogLevel.ERROR),
  });
  options.resourcePersistencePath = persist;
  let mf = new Miniflare(options),
    db = await mf.getD1Database("DB");
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  const sql = (query, ...args) => db.prepare(query).bind(...args),
    ts = new Date().toISOString();
  for (const query of statements(
    await readFile("migrations/0001_core.sql", "utf8"),
  ))
    await db.prepare(query).run();
  await sql(
    "INSERT INTO therapists(id,name,weekly_json,created_at,updated_at) VALUES(?,?,?,?,?)",
    "team",
    "Synthetic therapist",
    JSON.stringify(defaultWeek()),
    ts,
    ts,
  ).run();
  await sql(
    "INSERT INTO services(id,name,duration,price_cents,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    "service",
    "Synthetic treatment",
    60,
    500000,
    ts,
    ts,
  ).run();
  const sessions = {};
  for (const id of [
    "owner",
    "other-owner",
    "reception",
    "therapist",
    "password-owner",
  ]) {
    const raw = token(),
      csrf = token();
    sessions[id] = { raw, csrf };
    await sql(
      "INSERT INTO users(id,email,name,password_hash,role,therapist_id,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      id + "@example.test",
      id,
      "unused",
      id.includes("owner") ? "owner" : id,
      id === "therapist" ? "team" : null,
      id === "password-owner" ? 1 : 0,
      ts,
    ).run();
    await sql(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
      digest(raw),
      id,
      csrf,
      Date.now() + 3600000,
      ts,
    ).run();
  }
  for (const [id, name, phone, key] of [
    ["one", "Synthetic Same", "0611111111", "381611111111"],
    ["two", "Synthetic Same", "0622222222", "381622222222"],
    ["three", "Different Synthetic", "", null],
  ])
    await sql(
      "INSERT INTO clients(id,name,phone,phone_key,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      id,
      name,
      phone,
      key,
      ts,
      ts,
    ).run();
  async function request(
    path,
    method = "GET",
    body,
    role = "owner",
    extra = {},
  ) {
    const session = sessions[role];
    const response = await mf.dispatchFetch(origin + "/api" + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(session
          ? {
              cookie: "__Host-rei_session=" + session.raw,
              "x-csrf-token": session.csrf,
            }
          : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function expect(
    path,
    method = "GET",
    body,
    status = 200,
    role = "owner",
    extra = {},
  ) {
    const response = await request(path, method, body, role, extra);
    assert.equal(response.status, status, JSON.stringify(response.data));
    return response.data;
  }
  async function archive(label = "Synthetic Same", additions = {}) {
    const id = randomUUID(),
      importId = randomUUID(),
      reference = randomUUID(),
      refHash = digest(reference);
    const record = {
      sourceClientLabel: label,
      sourceClientId: null,
      sourceAppointmentRef: reference,
      sourceServiceLabel: "Archived treatment",
      sourceTherapistLabel: "Archived therapist",
      phone: null,
      email: null,
      instagram: null,
      ...additions,
    };
    await db.batch([
      sql(
        "INSERT INTO history_imports(id,owner_id,request_id,confirm_hash,commit_token,source,preview_id,preview_version,receipt_json,created_at) VALUES(?,?,?,?,?,'fresha','expired-source-preview',1,'{}',?)",
        importId,
        "owner",
        randomUUID(),
        "hash",
        "commit",
        ts,
      ),
      sql(
        "INSERT INTO history_archive_refs(source,ref_hash,reference,mode) VALUES('fresha',?,?,'appointment')",
        refHash,
        reference,
      ),
      sql(
        "INSERT INTO history_archive(id,import_id,source,ref_hash,line_key,client_id,evidence_hash,source_status,completion_state,date,start_minute,duration,record_json,imported_at) VALUES(?,?,'fresha',?,'',NULL,?,'Confirmed','unknown','2026-01-27',600,60,?,?)",
        id,
        importId,
        refHash,
        digest(JSON.stringify(record)),
        JSON.stringify(record),
        ts,
      ),
    ]);
    return id;
  }
  async function review(label, role = "owner", offset = 0) {
    const groups = await expect(
        "/history/links/groups",
        "GET",
        undefined,
        200,
        role,
      ),
      group = groups.groups.find((entry) => entry.label === label);
    assert.ok(group, `Missing unresolved group ${label}`);
    return expect(
      "/history/links/review?groupKey=" + group.key + "&offset=" + offset,
      "GET",
      undefined,
      200,
      role,
    );
  }
  function confirmation(r, archiveIds, clientId = "one", extra = {}) {
    return {
      reviewId: r.reviewId,
      token: r.token,
      fingerprint: r.fingerprint,
      requestId: randomUUID(),
      clientId,
      clientVersion: 1,
      archiveIds,
      acknowledgeReview: true,
      ...extra,
    };
  }
  const apply = (body, status = 200, role = "owner", extra = {}) =>
    expect("/history/links/apply", "POST", body, status, role, extra);
  await expect("/history/links/groups");
  let replayBody;

  await t.test(
    "owner-only bounded review preserves same-name ambiguity and source evidence",
    async () => {
      for (const role of ["reception", "therapist", "password-owner"])
        await expect("/history/links/groups", "GET", undefined, 403, role);
      await expect("/history/links/groups", "GET", undefined, 401, "anonymous");
      const a = await archive(),
        b = await archive("  synthetic   same ");
      const groups = await expect("/history/links/groups?limit=1");
      assert.equal(groups.total, 1);
      assert.equal(groups.unlinkedRows, 2);
      assert.equal(groups.groups[0].count, 2);
      const r = await expect(
        "/history/links/review?groupKey=" + groups.groups[0].key,
      );
      assert.equal(r.rows.length, 2);
      assert.equal(r.candidateCount, 2);
      assert.equal(r.ambiguous, true);
      assert.deepEqual(
        new Set(r.candidates.map((c) => c.id)),
        new Set(["one", "two"]),
      );
      assert.equal(r.rows[0].startMinute, 600);
      assert.equal(r.rows[0].duration, 60);
      assert.equal((await expect("/clients/one/history")).total, 0);
      const original = await sql(
        "SELECT * FROM history_archive WHERE id=?",
        a,
      ).first();
      replayBody = confirmation(r, [a]);
      await apply({ ...replayBody, acknowledgeReview: false }, 400);
      await apply(replayBody, 403, "owner", { "x-csrf-token": "wrong" });
      await apply(replayBody, 404, "other-owner");
      await apply({ ...replayBody, token: "x".repeat(43) }, 409);
      const linked = await apply(replayBody);
      assert.equal(linked.linked, 1);
      assert.equal(linked.remaining, 1);
      assert.equal(linked.repeated, false);
      assert.deepEqual(
        await sql("SELECT * FROM history_archive WHERE id=?", a).first(),
        original,
      );
      assert.equal(
        (
          await sql(
            "SELECT client_id FROM history_archive_effective WHERE id=?",
            a,
          ).first()
        ).client_id,
        "one",
      );
      assert.equal(
        (
          await sql(
            "SELECT client_id FROM history_archive_effective WHERE id=?",
            b,
          ).first()
        ).client_id,
        null,
      );
      const history = await expect("/clients/one/history");
      assert.equal(history.total, 1);
      assert.equal(history.visitCount, 1);
      assert.equal(history.rows[0].serviceName, "Archived treatment");
      assert.equal((await apply(replayBody)).repeated, true);
      await apply({ ...replayBody, clientId: "two" }, 409);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM history_client_link_receipts",
          ).first()
        ).n,
        1,
      );
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action='history_client_link'",
          ).first()
        ).n,
        1,
      );
    },
  );

  await t.test(
    "explicit search selection works without matching name; pages contain only reviewable IDs",
    async () => {
      const ids = [];
      for (let n = 0; n < 101; n++)
        ids.push(await archive("Pagination source"));
      const page = await review("Pagination source");
      assert.equal(page.rows.length, 100);
      assert.equal(page.hasMore, true);
      assert.equal(page.candidates.length, 0);
      const last = await review("Pagination source", "owner", 100);
      assert.equal(last.rows.length, 1);
      assert.equal(last.hasMore, false);
      await apply(confirmation(page, [last.rows[0].id], "three"), 400);
      const linked = await apply(
        confirmation(last, [last.rows[0].id], "three"),
      );
      assert.equal(linked.client.id, "three");
      assert.equal(linked.remaining, 100);
      const unknownId = await archive(null),
        unknown = await review("Unknown client");
      assert.equal(unknown.candidates.length, 0);
      assert.equal(
        (await apply(confirmation(unknown, [unknownId], "three"))).linked,
        1,
      );
    },
  );

  await t.test(
    "expiry, selected client version and every state revision require a fresh review",
    async () => {
      const id = await archive("Clock source");
      let r = await review("Clock source");
      await apply(confirmation(r, [id], "one", { clientVersion: 99 }), 409);
      await sql(
        "UPDATE history_client_link_reviews SET expires_at=0 WHERE id=?",
        r.reviewId,
      ).run();
      await apply(confirmation(r, [id]), 410);
      for (const clock of [
        "history_archive_state",
        "client_transfer_state",
        "history_native_state",
      ]) {
        r = await review("Clock source");
        await sql(`UPDATE ${clock} SET revision=revision+1 WHERE id=1`).run();
        await apply(confirmation(r, [id]), 409);
      }
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM history_archive_client_links WHERE archive_id=?",
            id,
          ).first()
        ).n,
        0,
      );
    },
  );

  await t.test(
    "strong contacts and source client IDs cannot contradict the selected client",
    async () => {
      const contactId = await archive("Contact source", {
        phone: "0622222222",
      });
      const contactReview = await review("Contact source");
      await apply(confirmation(contactReview, [contactId], "one"), 409);
      await apply(confirmation(contactReview, [contactId], "three"), 409);
      await apply(confirmation(contactReview, [contactId], "two"));
      const sourceA = await archive("Source ID A", {
        sourceClientId: "verified-id",
      });
      await apply(confirmation(await review("Source ID A"), [sourceA], "one"));
      const sourceB = await archive("Source ID B", {
        sourceClientId: "verified-id",
      });
      await apply(
        confirmation(await review("Source ID B"), [sourceB], "two"),
        409,
      );
      const importId = randomUUID();
      await sql(
        "INSERT INTO client_imports(id,owner_id,source,revision,plan_json,created_at,expires_at) VALUES(?,'owner','fresha',0,'{}',?,?)",
        importId,
        Date.now(),
        Date.now() + 60000,
      ).run();
      await sql(
        "INSERT INTO client_import_keys(source,source_key,client_id,import_id) VALUES('fresha',?,'two',?)",
        "id:" + digest("client-file-id"),
        importId,
      ).run();
      const imported = await archive("Imported source ID", {
        sourceClientId: "client-file-id",
      });
      await apply(
        confirmation(await review("Imported source ID"), [imported], "one"),
        409,
      );
    },
  );

  await t.test(
    "native appointment overlaps reject linking instead of silently double counting",
    async () => {
      await sql(
        "INSERT INTO appointments(id,client_id,therapist_id,service_id,service_name,date,start_minute,duration,room_id,bed,status,gross_cents,net_cents,created_at,updated_at,updated_by,mutation_id) VALUES('overlap','three','team','service','Synthetic treatment','2026-01-27',600,60,'r1',0,'done',500000,500000,?,?,'owner','fixture')",
        ts,
        ts,
      ).run();
      const id = await archive("Overlap source");
      await apply(
        confirmation(await review("Overlap source"), [id], "three"),
        409,
      );
      assert.equal(
        (
          await sql(
            "SELECT client_id FROM history_archive_effective WHERE id=?",
            id,
          ).first()
        ).client_id,
        null,
      );
    },
  );

  await t.test(
    "a failed batch rolls back links, receipt and audit; competing confirmations have one winner",
    async () => {
      const a = await archive("Atomic source"),
        b = await archive("Atomic source"),
        r = await review("Atomic source"),
        body = confirmation(r, [a, b]);
      await db
        .prepare(
          `CREATE TRIGGER reject_test_link BEFORE INSERT ON history_archive_client_links WHEN NEW.archive_id='${b}' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END`,
        )
        .run();
      await apply(body, 500);
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM history_archive_client_links WHERE archive_id IN (?,?)",
            a,
            b,
          ).first()
        ).n,
        0,
      );
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM history_client_link_receipts WHERE request_id=?",
            body.requestId,
          ).first()
        ).n,
        0,
      );
      await db.prepare("DROP TRIGGER reject_test_link").run();
      const results = await Promise.all([
        request("/history/links/apply", "POST", body),
        request("/history/links/apply", "POST", confirmation(r, [a, b], "two")),
      ]);
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 409],
      );
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM history_archive_client_links WHERE archive_id IN (?,?)",
            a,
            b,
          ).first()
        ).n,
        2,
      );
      assert.equal(
        (
          await sql(
            "SELECT COUNT(DISTINCT client_id) AS n FROM history_archive_client_links WHERE archive_id IN (?,?)",
            a,
            b,
          ).first()
        ).n,
        1,
      );
    },
  );

  await t.test(
    "unresolved groups, profile links and identical receipts survive Worker restart and review expiry",
    async () => {
      await sql("UPDATE history_client_link_reviews SET expires_at=0").run();
      await mf.dispose();
      mf = new Miniflare(options);
      db = await mf.getD1Database("DB");
      assert.equal((await apply(replayBody)).repeated, true);
      assert.ok((await expect("/history/links/groups")).unlinkedRows > 0);
      assert.ok((await expect("/clients/one/history")).total > 0);
    },
  );
});
