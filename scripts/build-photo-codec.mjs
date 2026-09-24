import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
await build({
  stdin: {
    contents: "export { decode, encode } from 'jpeg-js';",
    resolveDir: process.cwd(),
  },
  outfile: "src/photo-codec.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  minify: true,
  legalComments: "inline",
  banner: {
    js: "// Generated from jpeg-js 0.4.4 by scripts/build-photo-codec.mjs. See docs/tools/jpeg-js-LICENSE.txt.",
  },
});
await copyFile(
  "node_modules/jpeg-js/LICENSE",
  "docs/tools/jpeg-js-LICENSE.txt",
);
