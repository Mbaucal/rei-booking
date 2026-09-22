# Test environment and operations

## Current state

The local Worker, migration and integration tests are ready. The test deployment is not online. The repository is https://github.com/Mbaucal/rei-booking; GitHub sign-in and repository creation are complete. The owner changed its visibility to public while connecting Cloudflare.

On 22 September 2026, the owner supplied a Cloudflare screenshot confirming the dedicated D1 database `rei-booking-test`, ID `7078aa06-6963-4e34-bdee-90e32e2764ae`. This ID is configured as the test `DB` binding. The database screenshot shows zero tables: the remote schema and first owner have not yet been provisioned. Do not create a second database.

The owner has reached Cloudflare's Create and deploy screen with `Mbaucal/rei-booking` selected. The screenshot still shows the default project name `rei-booking`, deploy command and enabled preview builds; use the values below before submitting. The configured target origin is `https://rei-booking-test.mbaucal.workers.dev`, based on the intended Worker name and the account's existing `mbaucal.workers.dev` namespace. This is an expected address, not a verified live deployment. Compare it with the actual URL Cloudflare returns; if the namespace differs, update `APP_ORIGIN` and redeploy before signing in. Requests to a different origin are rejected by the server.

## Cloudflare dashboard connection

Open Workers & Pages, create an application and choose the existing GitHub repository. Prepare these settings for the dedicated test Worker:

| Setting | Value |
| --- | --- |
| Repository | `Mbaucal/rei-booking` |
| Worker name | `rei-booking-test` |
| Branch | `main` |
| Root directory | Repository root (`/`) |
| Build command | `npm run check && npm test && npm run build` |
| Deploy command | `npm run deploy:test` |
| Node.js | Version 24 is selected by `.node-version`; if a `NODE_VERSION` build override exists, set it to `24` |
| Preview builds for other branches | Disabled for this initial setup |
| Preview command | Unused while preview builds are disabled |
| Protect with Cloudflare Access | Leave off during this initial setup; application sign-in remains required for protected data |

Cloudflare may label `main` as the production branch of this Worker; this Worker still uses the isolated **test** environment through the explicit `--env test` in the deploy script. The current repository is ready for this first Worker deployment. After deployment, verify that the returned URL matches `env.test.vars.APP_ORIGIN`. Build variables are separate from application runtime variables, which remain in `wrangler.json`. If the Git URL import flow creates a copy of the repository, confirm the connected repository before relying on automatic updates.

Apply the migration and provision the first owner using the authorized local Wrangler flow below before application acceptance. `npm run deploy:test` only deploys the Worker; it does not migrate the database or create an owner. Cloudflare's default Builds token does not list D1 edit permission, so do not assume it can execute migrations. Do not paste tokens or passwords into chat. If GitHub asks which repositories Cloudflare can access, select only `rei-booking` where that option is available.

References: [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [Wrangler environments in Builds](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/).

## Configure the dedicated test environment

Use the owner's existing Cloudflare account through its normal sign-in flow. Do not send account passwords or API tokens through chat or commit them.

1. Use the existing `Mbaucal/rei-booking` repository. The package contents, lockfile and workflow are committed. Exclude `node_modules`, `.wrangler`, `private`, `dist` and credentials.
2. Authenticate Wrangler locally with `npx wrangler login` and confirm the intended Cloudflare account.
3. Use the existing dedicated database `rei-booking-test` (`7078aa06-6963-4e34-bdee-90e32e2764ae`); its ID is already in `env.test.d1_databases[0]` in `wrangler.json`. Confirm Wrangler is using the same Cloudflare account that owns this database.
4. Confirm `env.test.vars.APP_ORIGIN` matches the test Worker's actual HTTPS address, without a trailing slash. Its configured target is `https://rei-booking-test.mbaucal.workers.dev`. `npm run dev` overrides this to `http://localhost:8787` for local development without editing the deployment configuration.
5. Run `npm run check`, `npm test` and `npm run build`.
6. Apply the migration with `npx wrangler d1 migrations apply rei-booking-test --env test --remote`.
7. Prepare the first owner as described in the README, apply its protected SQL with `npx wrangler d1 execute rei-booking-test --env test --remote --file private/first-owner.sql`, then delete the credential input and SQL files after verifying provisioning.
8. Run `npm run deploy:test`. This refuses the placeholder database ID and a non-HTTPS origin.
9. Verify sign-in over HTTPS, forced password change and each role using fictional data. Check the actual deployment's CPU budget under concurrent password verification; the password KDF must not be weakened to fit a lower runtime limit.

No production environment or automatic production deployment is defined. Remote hosting/usage charges have not been calculated or incurred by this implementation work.

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
