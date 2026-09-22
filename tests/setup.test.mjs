import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { firstOwnerSQL, resetOwnerSQL } from "../scripts/owner-sql.mjs";
import { digest, hashPassword, verifyPassword } from "../src/security.mjs";

test("first-owner SQL grants access once and preserves existing accounts", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      await readFile(
        new URL("../migrations/0001_core.sql", import.meta.url),
        "utf8",
      ),
    );
    const password = "Fictional-owner-setup-password";
    const hash = await hashPassword(password);
    const owner = {
      id: "setup-owner",
      mail: "owner@example.test",
      name: "O'Connor'); DROP TABLE users; --",
      hash,
      createdAt: "2026-09-22T12:00:00Z",
    };
    assert.deepEqual(
      { ...db.prepare(firstOwnerSQL(owner)).get() },
      { id: owner.id },
    );
    const saved = db.prepare("SELECT * FROM users WHERE id=?").get(owner.id);
    assert.equal(saved.name, owner.name);
    assert.equal(saved.role, "owner");
    assert.equal(saved.active, 1);
    assert.equal(saved.must_change_password, 1);
    assert.equal(await verifyPassword(password, saved.password_hash), true);
    assert.equal(
      db
        .prepare(
          firstOwnerSQL({
            ...owner,
            id: "second-owner",
            mail: "second@example.test",
          }),
        )
        .get(),
      undefined,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get().n, 1);
    assert.equal(
      db.prepare("SELECT password_hash FROM users").get().password_hash,
      hash,
    );
  } finally {
    db.close();
  }
});

test("setup cannot promote an existing reception account with the same email", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      await readFile(
        new URL("../migrations/0001_core.sql", import.meta.url),
        "utf8",
      ),
    );
    db.prepare(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      "reception",
      "same@example.test",
      "Reception",
      "existing-hash",
      "reception",
      "2026-09-22",
    );
    assert.throws(
      () =>
        db
          .prepare(
            firstOwnerSQL({
              id: "owner",
              mail: "same@example.test",
              name: "Owner",
              hash: "new-hash",
              createdAt: "2026-09-22",
            }),
          )
          .get(),
      /UNIQUE/,
    );
    assert.equal(db.prepare("SELECT role FROM users").get().role, "reception");
    assert.equal(
      db.prepare("SELECT password_hash FROM users").get().password_hash,
      "existing-hash",
    );
  } finally {
    db.close();
  }
});

test("owner recovery replaces the password, revokes only that owner's sessions and preserves records", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      await readFile(
        new URL("../migrations/0001_core.sql", import.meta.url),
        "utf8",
      ),
    );
    const oldPassword = "Fictional-old-owner-password";
    const newPassword = "Fictional-new-owner-password";
    const previousHash = await hashPassword(oldPassword);
    const hash = await hashPassword(newPassword);
    const mail = "owner@example.test";
    const user = db.prepare(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    );
    user.run("owner", mail, "Owner", previousHash, "owner", "2026-09-22");
    user.run(
      "other",
      "other@example.test",
      "Other",
      "unchanged-hash",
      "owner",
      "2026-09-22",
    );
    const session = db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)");
    session.run(
      "owner-session",
      "owner",
      "csrf-owner",
      9999999999999,
      "2026-09-22",
    );
    session.run(
      "other-session",
      "other",
      "csrf-other",
      9999999999999,
      "2026-09-22",
    );
    const limit = db.prepare("INSERT INTO login_limits VALUES(?,1,12)");
    limit.run("email:" + digest(mail));
    limit.run("email:" + digest("other@example.test"));
    limit.run("ip:existing-ip-limit");
    db.exec(
      "INSERT INTO clients(id,name,created_at,updated_at) VALUES('client','Fictional client','2026-09-22','2026-09-22');",
    );
    db.exec(
      resetOwnerSQL({
        id: "owner",
        mail,
        previousHash,
        hash,
        createdAt: "2026-09-22T20:00:00Z",
      }),
    );
    const saved = db.prepare("SELECT * FROM users WHERE id='owner'").get();
    assert.equal(await verifyPassword(newPassword, saved.password_hash), true);
    assert.equal(await verifyPassword(oldPassword, saved.password_hash), false);
    assert.equal(saved.must_change_password, 1);
    assert.equal(saved.role, "owner");
    assert.equal(saved.created_at, "2026-09-22");
    assert.deepEqual(
      db
        .prepare("SELECT user_id FROM sessions")
        .all()
        .map((r) => r.user_id),
      ["other"],
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM login_limits").get().n,
      2,
    );
    assert.equal(
      db
        .prepare("SELECT key FROM login_limits WHERE key=?")
        .get("email:" + digest(mail)),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT password_hash FROM users WHERE id='other'").get()
        .password_hash,
      "unchanged-hash",
    );
    assert.equal(
      db.prepare("SELECT name FROM clients WHERE id='client'").get().name,
      "Fictional client",
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM rooms").get().n, 3);
    const audit = db.prepare("SELECT * FROM audit_log").get();
    assert.equal(audit.action, "owner_password_reset");
    assert.equal(audit.actor_id, null);
    assert.equal(audit.entity_id, "owner");
    assert.equal(audit.before_json, null);
    assert.deepEqual(JSON.parse(audit.after_json), {
      source: "cloudflare_cli",
      must_change_password: true,
    });
  } finally {
    db.close();
  }
});

test("owner recovery refuses role, status, identity and concurrent-password changes", async () => {
  for (const change of [
    { role: "reception" },
    { active: 0 },
    { email: "different@example.test" },
    { id: "different-id" },
    { password_hash: "concurrently-changed-hash" },
  ]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        await readFile(
          new URL("../migrations/0001_core.sql", import.meta.url),
          "utf8",
        ),
      );
      const row = {
        id: "owner",
        email: "owner@example.test",
        role: "owner",
        active: 1,
        password_hash: "previous-hash",
        ...change,
      };
      db.prepare(
        "INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        row.id,
        row.email,
        "Owner",
        row.password_hash,
        row.role,
        row.active,
        "2026-09-22",
      );
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
        "existing-session",
        row.id,
        "csrf",
        9999999999999,
        "2026-09-22",
      );
      db.prepare("INSERT INTO login_limits VALUES(?,1,12)").run(
        "email:" + digest("owner@example.test"),
      );
      db.exec(
        resetOwnerSQL({
          id: "owner",
          mail: "owner@example.test",
          previousHash: "previous-hash",
          hash: "replacement-hash",
          createdAt: "2026-09-22",
        }),
      );
      assert.equal(
        db.prepare("SELECT password_hash FROM users").get().password_hash,
        row.password_hash,
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM login_limits").get().n,
        1,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM audit_log").get().n,
        0,
      );
    } finally {
      db.close();
    }
  }
});
