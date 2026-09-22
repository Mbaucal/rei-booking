import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { prepareOwnerConsole } from "../scripts/owner-console.mjs";
import { verifyPassword, digest } from "../src/security.mjs";

const fixture = {
  email: " Owner@Example.test ",
  name: "O'Connor'); DROP TABLE clients; --",
  password: "Fictional-browser-password-č🌼",
  repeat: "Fictional-browser-password-č🌼",
};
const schema = await readFile(
  new URL("../migrations/0001_core.sql", import.meta.url),
  "utf8",
);

test("offline form creates and resets an owner with a server-compatible password", async () => {
  const prepared = await prepareOwnerConsole(fixture);
  assert.equal(prepared.email, "owner@example.test");
  assert.equal(prepared.sql.includes(fixture.password), false);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    db.exec(prepared.sql);
    let saved = db.prepare("SELECT * FROM users").get();
    const firstId = saved.id;
    assert.equal(saved.name, fixture.name);
    assert.equal(saved.role, "owner");
    assert.equal(saved.active, 1);
    assert.equal(saved.must_change_password, 1);
    assert.equal(
      await verifyPassword(fixture.password, saved.password_hash),
      true,
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "old-session",
      saved.id,
      "csrf",
      9999999999999,
      "2026-09-22",
    );
    db.prepare("INSERT INTO login_limits VALUES(?,1,12)").run(
      "email:" + digest(saved.email),
    );
    db.exec(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('other','other@example.test','Other','keep-hash','owner','2026-09-22');",
    );
    db.exec(
      "INSERT INTO sessions VALUES('other-session','other','other-csrf',9999999999999,'2026-09-22');",
    );
    db.exec("INSERT INTO login_limits VALUES('ip:keep-limit',1,12);");
    db.exec(
      "INSERT INTO clients(id,name,created_at,updated_at) VALUES('client','Keep client','2026-09-22','2026-09-22');",
    );
    const nextPassword = "Fictional-replacement-password";
    const reset = await prepareOwnerConsole({
      ...fixture,
      password: nextPassword,
      repeat: nextPassword,
    });
    db.exec(reset.sql);
    saved = db.prepare("SELECT * FROM users WHERE id=?").get(firstId);
    assert.equal(await verifyPassword(nextPassword, saved.password_hash), true);
    assert.equal(
      await verifyPassword(fixture.password, saved.password_hash),
      false,
    );
    assert.equal(saved.must_change_password, 1);
    assert.deepEqual(
      db
        .prepare("SELECT token_hash FROM sessions")
        .all()
        .map((x) => x.token_hash),
      ["other-session"],
    );
    assert.deepEqual(
      db
        .prepare("SELECT key FROM login_limits")
        .all()
        .map((x) => x.key),
      ["ip:keep-limit"],
    );
    assert.equal(
      db.prepare("SELECT password_hash FROM users WHERE id='other'").get()
        .password_hash,
      "keep-hash",
    );
    assert.equal(
      db.prepare("SELECT name FROM clients").get().name,
      "Keep client",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM rooms").get().n, 3);
    for (const row of db.prepare("SELECT * FROM audit_log").all()) {
      assert.equal(row.entity_id, firstId);
      assert.equal(row.action, "owner_access_recovery");
      assert.equal(row.actor_id, null);
      assert.deepEqual(JSON.parse(row.after_json), {
        source: "cloudflare_console",
        must_change_password: true,
      });
    }
    // The dashboard verification row reports success without exposing a hash.
    const verification = reset.sql.slice(reset.sql.lastIndexOf("SELECT CASE"));
    assert.equal(db.prepare(verification).get().result, "OWNER_READY");
  } finally {
    db.close();
  }
});

test("console recovery cannot promote, reactivate or add a second owner", async () => {
  const prepared = await prepareOwnerConsole(fixture);
  for (const scenario of [
    { email: prepared.email, role: "reception", active: 1 },
    { email: prepared.email, role: "owner", active: 0 },
    { email: "different@example.test", role: "owner", active: 1 },
  ]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(schema);
      db.prepare(
        "INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES('existing',?,'Keep','keep-hash',?,?,'2026-09-22')",
      ).run(scenario.email, scenario.role, scenario.active);
      db.exec(
        "INSERT INTO sessions VALUES('keep-session','existing','csrf',9999999999999,'2026-09-22');",
      );
      db.exec(prepared.sql);
      const saved = db.prepare("SELECT * FROM users").all();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].password_hash, "keep-hash");
      assert.equal(saved[0].role, scenario.role);
      assert.equal(saved[0].active, scenario.active);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM audit_log").get().n,
        0,
      );
      assert.match(
        db
          .prepare(prepared.sql.slice(prepared.sql.lastIndexOf("SELECT CASE")))
          .get().result,
        /^NOT_CHANGED/,
      );
    } finally {
      db.close();
    }
  }
});

test("form rejects mismatched, short, oversized passwords and malformed identity", async () => {
  for (const patch of [
    { repeat: "different" },
    { password: "short", repeat: "short" },
    { password: "x".repeat(129), repeat: "x".repeat(129) },
    { email: "no-email" },
    { name: " " },
  ])
    await assert.rejects(prepareOwnerConsole({ ...fixture, ...patch }));
});

test("downloadable HTML executes its bundled form offline with a matching CSP", async () => {
  const html = await readFile(
    new URL("../docs/tools/owner-access.html", import.meta.url),
    "utf8",
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const cspHash = createHash("sha256").update(script).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${cspHash}'`));
  assert.ok(html.includes("connect-src 'none'; form-action 'none'"));
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=/);
  const elements = new Map();
  const get = (name) => {
    if (!elements.has(name))
      elements.set(name, {
        value: "",
        type: "password",
        hidden: true,
        checked: false,
        listeners: {},
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        scrollIntoView() {},
        focus() {},
        select() {
          this.selected = true;
        },
      });
    return elements.get(name);
  };
  get("form").elements = {
    email: { value: fixture.email },
    name: { value: fixture.name },
  };
  get("#password").value = fixture.password;
  get("#repeat").value = fixture.repeat;
  runInNewContext(script, {
    document: { querySelector: get },
    crypto,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
    ArrayBuffer,
    setTimeout,
    navigator: {},
  });
  get("#show").checked = true;
  get("#show").listeners.change();
  assert.equal(get("#password").type, "text");
  await get("form").listeners.submit({ preventDefault() {} });
  assert.equal(get("fieldset").disabled, false);
  assert.equal(get("#output").hidden, false, get("#status").textContent);
  assert.equal(get("#password").value, "");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    db.exec(get("#sql").value);
    assert.equal(
      await verifyPassword(
        fixture.password,
        db.prepare("SELECT password_hash FROM users").get().password_hash,
      ),
      true,
    );
  } finally {
    db.close();
  }
  // Offline file browsers may deny the clipboard API; manual copy still works.
  await get("#copy").listeners.click();
  assert.equal(get("#sql").selected, true);
  assert.match(get("#status").textContent, /Command\+C/);
});
