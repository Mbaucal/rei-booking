# Test environment and operations

## Current state

The repository is https://github.com/Mbaucal/rei-booking. The owner changed its visibility to public while connecting Cloudflare. A supplied deployment log now confirms successful deployment of Worker **`rei-booking`** at **https://rei-booking.mbaucal.workers.dev**, version `ebc34797-bd4d-464c-b118-6a28b95bf925`. This is evidence of deployment, not yet a hosted sign-in or database acceptance check.

On 22 September 2026, the owner supplied a Cloudflare screenshot confirming the dedicated D1 database `rei-booking-test`, ID `7078aa06-6963-4e34-bdee-90e32e2764ae`. The deployment log also confirms this test `DB` binding. The earlier database screenshot shows zero tables; the assistant has not applied remote migrations or created the first owner. Do not create a second database.

The deployment log showed an outdated `APP_ORIGIN` containing `rei-booking-test`. The repository now uses the actual Worker name `rei-booking` and origin `https://rei-booking.mbaucal.workers.dev`. Redeploy this configuration before signing in: requests from a mismatched origin are rejected. The test environment explicitly enables `workers_dev` and disables `preview_urls`; the database remains the dedicated test database. The result of this corrective redeployment has not yet been independently verified.

## Cloudflare dashboard connection

In Workers & Pages, open the existing `rei-booking` Worker and confirm these build settings. Do not create another Worker:

| Setting | Value |
| --- | --- |
| Repository | `Mbaucal/rei-booking` |
| Worker name | `rei-booking` |
| Branch | `main` |
| Root directory | Repository root (`/`) |
| Build command | `npm run check && npm test && npm run build` |
| Deploy command | `npm run deploy:test` |
| Node.js | Version 24 is selected by `.node-version`; if a `NODE_VERSION` build override exists, set it to `24` |
| Preview builds for other branches | Disabled for this initial setup |
| Preview command | Unused while preview builds are disabled |
| Protect with Cloudflare Access | Leave off during this initial setup; application sign-in remains required for protected data |

Cloudflare may label `main` as the production branch of this Worker; this Worker still uses the isolated **test** environment through the explicit `--env test` in the deploy script. After deployment, verify that the returned URL matches `env.test.vars.APP_ORIGIN`. Build variables are separate from application runtime variables, which remain in `wrangler.json`. If the Git URL import flow creates a copy of the repository, confirm the connected repository before relying on automatic updates.

Apply the migration and provision the first owner using the authorized local Wrangler flow below before application acceptance. `npm run deploy:test` only deploys the Worker; it does not migrate the database or create an owner. Cloudflare's default Builds token does not list D1 edit permission, so do not assume it can execute migrations. Do not paste tokens or passwords into chat. If GitHub asks which repositories Cloudflare can access, select only `rei-booking` where that option is available.

References: [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [Wrangler environments in Builds](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/).

## Initialize the test database and first owner

Use Node.js 24 and a terminal on the owner's machine, in an up-to-date checkout of this repository. The assistant's environment has no authenticated Cloudflare CLI session. Replace the example email with the owner's email; keep real credentials out of the public repository.

```sh
npm ci
npx wrangler login
npm run setup:test -- owner@example.com
npm run deploy:test
```

Sign in to the Cloudflare account that owns the displayed database. The setup command:

1. Checks the configured environment and verifies Cloudflare's database name and ID before changes.
2. Shows the target and asks before applying pending migrations to the test database.
3. Leaves any existing owner account and password unchanged.
4. If no owner exists, asks for a display name and a temporary password of 12–128 characters, twice, with password input hidden.
5. Uses the application's password hash, creates the owner once, and verifies the account. It removes its temporary SQL and associated log on completion.

Never pass a password as a command argument. First sign-in requires replacing the temporary password. Open https://rei-booking.mbaucal.workers.dev after setup and deployment complete.

## Manual alternative

Use the owner's existing Cloudflare account through its normal sign-in flow. Do not send account passwords or API tokens through chat or commit them.

1. Use the existing `Mbaucal/rei-booking` repository. The package contents, lockfile and workflow are committed. Exclude `node_modules`, `.wrangler`, `private`, `dist` and credentials.
2. Authenticate Wrangler locally with `npx wrangler login` and confirm the intended Cloudflare account.
3. Use the existing dedicated database `rei-booking-test` (`7078aa06-6963-4e34-bdee-90e32e2764ae`); its ID is already in `env.test.d1_databases[0]` in `wrangler.json`. Confirm Wrangler is using the same Cloudflare account that owns this database.
4. Confirm `env.test.vars.APP_ORIGIN` matches the test Worker's actual HTTPS address, without a trailing slash: `https://rei-booking.mbaucal.workers.dev`. `npm run dev` overrides this to `http://localhost:8787` for local development without editing the deployment configuration.
5. Run `npm run check`, `npm test` and `npm run build`.
6. Apply the migration with `npx wrangler d1 migrations apply rei-booking-test --env test --remote`.
7. Prepare the first owner as described in the README, apply its protected SQL with `npx wrangler d1 execute rei-booking-test --env test --remote --file private/first-owner.sql`, then delete the credential input and SQL files after verifying provisioning.
8. Run `npm run deploy:test`. This checks the exact test database ID, Worker name and HTTPS origin.
9. Verify sign-in over HTTPS, forced password change and each role using fictional data. Check the actual deployment's CPU budget under concurrent password verification; the password KDF must not be weakened to fit a lower runtime limit.

No salon production environment or automatic deployment to a production database is defined. Remote hosting/usage charges have not been calculated.

## Device acceptance before salon use

- Owner creates a 60-minute appointment by clicking an empty slot; a new client can be added in the same save, or the booking stays a walk-in.
- Move and edit bookings on laptop, touch tablet and mobile; verify 5-minute snapping, scrolling, error recovery and day boundaries.
- Two different therapists can share a couple room on separate tables. A third booking or an overlapping booking for either therapist is rejected.
- Two separate browser sessions try to reserve the same table; one succeeds and the other receives a clear conflict.
- Therapist sees the whole schedule and requested hearts, without client names, initials, photos, contacts, notes or financial fields. Confirm API responses as well as the visible screen.
- Reception can operate bookings and clients, with financial values hidden in this first release. Owner-only configuration remains inaccessible.
- Refresh, sign out/in and restart the deployment: records persist. Disabled accounts immediately lose access.

## Backups and recovery before production

Persistence is not a backup. The integration test proves local D1 survives a Worker restart, not remote disaster recovery.

- Agree who owns backup storage, retention and restore access before importing clients.
- Export the remote test database to a protected path using `npx wrangler d1 export rei-booking-test --env test --remote --output private/rei-booking-test-backup.sql`.
- Create a separate restore database. Import that export there, never over the live database during a restore drill.
- Compare client, appointment, occupancy-slot and audit counts; check sample dates, prices and requested flags.
- Revoke restored sessions before allowing users onto the recovered environment.
- Record the successful restore date, recovery steps and measured recovery time. Remote export/restore and an automated backup schedule are still pending.

## Recovery limitations in 0.1.0

Self-service email password resets, MFA, notification/email providers, file storage and monitoring/alerting are not configured. Lost-owner recovery needs an authorized database administrator. No credentials are embedded in the code or package.
