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
console.log("Test deployment configuration is ready.");
export { test as testConfig };
