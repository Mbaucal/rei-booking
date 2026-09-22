import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/security.mjs";
import { email, text } from "../src/domain.mjs";
import { testConfig } from "./check-config.mjs";
import { firstOwnerSQL, resetOwnerSQL, quote } from "./owner-sql.mjs";
import { ask } from "./terminal-input.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const db = testConfig.d1_databases[0];
const resetMode = process.argv[2] === "--reset-password";
const argumentsForMode = process.argv.slice(resetMode ? 3 : 2);
let privateDir;

function run(args, { capture = false, sensitive = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [wrangler, ...args, "--env", "test"],
    {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        // D1 emits its --json result at the normal log level. Setting "error"
        // suppresses the result too, leaving the setup parser with no data.
        WRANGLER_LOG: "log",
        WRANGLER_LOG_SANITIZE: "true",
        ...(sensitive
          ? { WRANGLER_LOG_PATH: join(privateDir, "wrangler.log") }
          : {}),
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      "Cloudflare command failed. Check your Cloudflare login and access to the displayed TEST database, then rerun this command.",
    );
  if (!capture) return;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Cloudflare returned an unexpected result; setup stopped.");
  }
}

function query(sql, options = {}) {
  return run(
    ["d1", "execute", db.database_name, "--remote", "--json", "--command", sql],
    {
      capture: true,
      ...options,
    },
  );
}

function rows(result) {
  if (
    !Array.isArray(result) ||
    result.some((r) => r.success !== true || !Array.isArray(r.results))
  )
    throw new Error("The database operation could not be verified.");
  return result.flatMap((r) => r.results);
}

try {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run npm run setup:test in your own interactive terminal.");
  if (argumentsForMode.length > 1)
    throw new Error(
      "Pass only the owner email. Enter the password when prompted, never as an argument.",
    );
  const mail = email(
    argumentsForMode[0] || (await ask("Owner email: ")),
    false,
  );
  console.log(
    `\nRei Booking TEST ${resetMode ? "owner password recovery" : "setup"}\nWorker: ${testConfig.name}\nDatabase: ${db.database_name}\nDatabase ID: ${db.database_id}\nOwner email: ${mail}\n`,
  );
  const info = run(["d1", "info", db.database_name, "--json"], {
    capture: true,
  });
  if (info.uuid !== db.database_id || info.name !== db.database_name)
    throw new Error(
      "Cloudflare returned a different database. No setup changes were made.",
    );
  if (
    (
      await ask(
        resetMode
          ? "Set a new temporary password for this owner (or create the first owner if none exists)? [y/N] "
          : "Apply pending migrations and create the first owner in this TEST database? [y/N] ",
      )
    )
      .trim()
      .toLowerCase() !== "y"
  ) {
    console.log("Setup cancelled.");
  } else {
    if (!resetMode)
      run(["d1", "migrations", "apply", db.database_name, "--remote"]);
    const existing = rows(
      query("SELECT id FROM users WHERE role='owner' LIMIT 1;"),
    );
    if (existing.length && !resetMode) {
      console.log(
        "An owner already exists. Its account and password were kept. Sign in using the existing account.",
      );
    } else {
      privateDir = await mkdtemp(join(tmpdir(), "rei-owner-"));
      let owner;
      if (existing.length) {
        [owner] = rows(
          query(
            `SELECT id,email,name,role,active,password_hash FROM users WHERE email=${quote(mail)};`,
            { sensitive: true },
          ),
        );
        if (!owner || owner.role !== "owner" || owner.active !== 1)
          throw new Error(
            "This email is not an active owner. No account was changed. Check the owner email and account status.",
          );
        console.log(
          `Resetting the password for ${mail}. Existing sessions for this owner will be signed out.`,
        );
      } else if (resetMode) {
        console.log("No owner exists yet. Creating the first owner account.");
      }
      const name = owner
        ? owner.name
        : text(await ask("Owner display name: "), 100, "owner name");
      let password = await ask(
        "Temporary password (12–128 characters, input hidden): ",
        { secret: true },
      );
      let repeat = await ask("Repeat temporary password: ", { secret: true });
      if (password !== repeat)
        throw new Error("Passwords do not match. Rerun setup to try again.");
      const hash = await hashPassword(password);
      password = repeat = "";
      const id = owner ? owner.id : randomUUID();
      const file = join(privateDir, "first-owner.sql");
      const values = {
        id,
        mail,
        name,
        hash,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        file,
        owner
          ? resetOwnerSQL({ ...values, previousHash: owner.password_hash })
          : firstOwnerSQL(values),
        { mode: 0o600, flag: "wx" },
      );
      run(
        [
          "d1",
          "execute",
          db.database_name,
          "--remote",
          "--json",
          "--yes",
          "--file",
          file,
        ],
        { capture: true, sensitive: true },
      );
      const saved = rows(
        query(
          `SELECT id,role,active,must_change_password,password_hash FROM users WHERE id=${quote(id)};`,
          { sensitive: true },
        ),
      );
      if (
        saved.length !== 1 ||
        saved[0].role !== "owner" ||
        saved[0].active !== 1 ||
        saved[0].must_change_password !== 1 ||
        saved[0].password_hash !== hash
      )
        throw new Error(
          "The owner password could not be verified. The account may have changed concurrently. Rerun this command to check it.",
        );
      console.log(
        owner
          ? "Owner password reset and verified. Sign in with the new temporary password and replace it at first sign-in."
          : "Owner account created and verified. Sign in with the temporary password and replace it at first sign-in.",
      );
    }
    console.log(
      `Application: ${testConfig.vars.APP_ORIGIN}\nThe Worker must have the matching APP_ORIGIN configuration deployed.`,
    );
  }
} catch (error) {
  console.error(
    error.name === "AbortError" ? "Setup cancelled." : error.message,
  );
  process.exitCode = 1;
} finally {
  if (privateDir) await rm(privateDir, { recursive: true, force: true });
}
