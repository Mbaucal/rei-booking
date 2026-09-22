import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { firstOwnerSQL } from "../scripts/owner-sql.mjs";
import { hashPassword, verifyPassword } from "../src/security.mjs";

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
