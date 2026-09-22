import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const result = await build({
  entryPoints: [
    fileURLToPath(new URL("owner-console-ui.mjs", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "inline",
});
const code = result.outputFiles[0].text.trim();
if (/<\/script/i.test(code)) throw new Error("Unsafe inline script boundary.");
const cspHash = createHash("sha256").update(code).digest("base64");
const license = await readFile(
  new URL("node_modules/@noble/hashes/LICENSE", root),
  "utf8",
);
const template = await readFile(
  new URL("owner-console-template.html", import.meta.url),
  "utf8",
);
const html = template
  .replace("REPLACE_SCRIPT_HASH", cspHash)
  .replace(/<script>[\s\S]*?<\/script>/, () => `<script>${code}</script>`);
const out = new URL("docs/tools/", root);
await mkdir(out, { recursive: true });
await writeFile(new URL("owner-access.html", out), html);
await writeFile(new URL("noble-hashes-LICENSE.txt", out), license);
console.log(
  "Prepared docs/tools/owner-access.html (standalone, offline, no deployment needed).",
);
