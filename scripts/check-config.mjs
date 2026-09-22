import { readFile } from "node:fs/promises";
const config = JSON.parse(
  await readFile(new URL("../wrangler.json", import.meta.url), "utf8"),
);
const test = config.env.test;
if (
  !test.d1_databases[0].database_id ||
  test.d1_databases[0].database_id === "00000000-0000-0000-0000-000000000000"
)
  throw new Error(
    "Create the TEST D1 database and set its real database_id first.",
  );
const origin = new URL(test.vars.APP_ORIGIN);
if (origin.protocol !== "https:" || origin.origin !== test.vars.APP_ORIGIN)
  throw new Error(
    "Set APP_ORIGIN to the exact HTTPS test deployment origin (no trailing slash).",
  );
if (
  test.vars.APP_ENV !== "test" ||
  test.name !== "rei-booking" ||
  test.vars.APP_ORIGIN !== "https://rei-booking.mbaucal.workers.dev" ||
  test.d1_databases.length !== 1 ||
  test.d1_databases[0].binding !== "DB" ||
  test.d1_databases[0].database_name !== "rei-booking-test" ||
  test.d1_databases[0].database_id !== "7078aa06-6963-4e34-bdee-90e32e2764ae"
)
  throw new Error(
    "Only the named TEST environment is configured for this release.",
  );
// Cloudflare's default deploy command omits --env. Both commands target the
// same test Worker and must include its runtime variables and database binding.
for (const target of [config, test]) {
  if (
    target.name !== test.name ||
    target.workers_dev !== true ||
    target.preview_urls !== false ||
    JSON.stringify(target.vars) !== JSON.stringify(test.vars) ||
    JSON.stringify(target.d1_databases) !== JSON.stringify(test.d1_databases)
  )
    throw new Error(
      "Default and named TEST deployments must use the same test Worker, origin and database.",
    );
}
console.log("Default and named TEST deployment configurations are ready.");
export { test as testConfig };
