# Test environment and operations

## Current state

**Checkpoint — 24 September 2026:** main commit `c2bae48535bb89cd31dd410a311e5dbcbedca9fa` (release `0.4.0`) passed GitHub Actions and Cloudflare build `008e1a33-71e2-489f-9059-c0cc321bccba`, deployed version `11e96e93-b3d1-4dd5-989f-1b6bc29749a2`. The former move-test fixture collision was fixed without weakening booking conflict protection. The owner confirmed hosted sign-in. Visual/device acceptance remains open.

Release `0.5.0` adds voucher voids, recorded refunds and corrected reissues. Health identifies version `0.5.0`. Opening Sales initializes `0005_voucher_changes.sql` after the existing Sales and redemption schema. The migration adds history, a register view and guards; it also replaces the treatment catalogue guard transactionally to allow exact-value corrected copies of previously sold treatments. Existing users/passwords and original sale/voucher rows are preserved. No console SQL or password reset is required. See [voucher changes](voucher-changes.md) for acceptance steps. Deployment check results for the release are recorded in MBA-76 after publishing.

Release `0.6.0` adds private client/team portraits. `0006_profile_photos.sql` initializes after authentication and can also be applied through tracked migrations. Only processed JPEGs (maximum 512 px per side and 150 KiB) are stored in the existing dedicated D1 database. No R2 bucket, new secrets, public image hosting, console setup or account reset is needed. Image bytes are delivered through authenticated routes with no-store and same-origin resource headers. The pinned pure-JavaScript JPEG codec is generated with `npm run photos:codec`; its license is committed. Confirm upload responsiveness on the deployed Worker's actual CPU plan during device acceptance. Original files are never sent to the server.

## Cloudflare dashboard connection

In Workers & Pages, open the existing `rei-booking` Worker and confirm these build settings. Do not create another Worker:

| Setting                           | Value                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Repository                        | `Mbaucal/rei-booking`                                                                                |
| Worker name                       | `rei-booking`                                                                                        |
| Branch                            | `main`                                                                                               |
| Root directory                    | Repository root (`/`)                                                                                |
| Build command                     | `npm run check && npm test && npm run build`                                                         |
| Deploy command                    | `npm run deploy:test`                                                                                |
| Node.js                           | Version 24 is selected by `.node-version`; if a `NODE_VERSION` build override exists, set it to `24` |
| Preview builds for other branches | Disabled for this initial setup                                                                      |
| Preview command                   | Unused while preview builds are disabled                                                             |
| Protect with Cloudflare Access    | Leave off during this initial setup; application sign-in remains required for protected data         |

Cloudflare may label `main` as the production branch of this Worker; this Worker still uses the isolated **test** environment through the explicit `--env test` in the deploy script. After deployment, verify that the returned URL matches `env.test.vars.APP_ORIGIN`. Build variables are separate from application runtime variables, which remain in `wrangler.json`. If the Git URL import flow creates a copy of the repository, confirm the connected repository before relying on automatic updates.

Apply the migration and provision the first owner using the authorized local Wrangler flow below before application acceptance. `npm run deploy:test` only deploys the Worker; it does not migrate the database or create an owner. Cloudflare's default Builds token does not list D1 edit permission, so do not assume it can execute migrations. Do not paste tokens or passwords into chat. If GitHub asks which repositories Cloudflare can access, select only `rei-booking` where that option is available.

References: [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [Wrangler environments in Builds](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/).

## Initialize the test database and first owner

An earlier D1 Console table-list query returned only `_cf_KV`. The owner's latest screenshot now shows the application tables and `d1_migrations`. Login has progressed to `Email or password is incorrect.` This does not distinguish an absent owner from a password mismatch or disabled account. The setup flow below is for initial provisioning; use the recovery flow if provisioning was interrupted or the initial password is unavailable.

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

## Recover the owner password

### Browser and D1 console (no terminal)

Download [owner-access.html](tools/owner-access.html), then open the downloaded file in Safari, Chrome or Firefox. GitHub's source preview does not run the form. This standalone tool has no external scripts, storage or network requests; its CSP blocks connections and form submissions. Fill in the owner email, name and a temporary password twice. **Show passwords** makes typing visible. Click **Prepare Cloudflare command**.

In the authenticated Cloudflare dashboard, open **D1 Database → rei-booking-test → Console**. Check database ID `7078aa06-6963-4e34-bdee-90e32e2764ae`. Paste the entire generated SQL and click **Execute**. The last result must say `OWNER_READY`. Then sign in at https://rei-booking.mbaucal.workers.dev and replace the temporary password. Clear the form after use; do not put the generated SQL into GitHub, Linear or chat.

The command handles either an absent first owner or an already-existing active owner at the supplied email. It preserves the existing owner's ID, profile and related records. It revokes only that owner's sessions, clears only that email's login limit and records an audit event without credentials. It does not promote another role, reactivate a disabled account or create an additional owner when a different owner exists. If the result is `NOT_CHANGED`, check the owner email/account status. The form prepares a command; it does not itself save or verify remote data. Each command is for one explicit administrator recovery: do not replay it after replacing the temporary password.

On 22 September the owner's CLI screenshot showed no owner before password entry, followed by `Cloudflare returned an unexpected result; setup stopped.` This message comes from parsing Wrangler stdout, after a command exits successfully. It can occur after a database write; it does not prove the write failed. The owner subsequently recovered access using the browser/console route. The browser/console route avoids that parser and covers both possible account states. Database tables and runtime origin have already been confirmed in the owner's screenshots; do not recreate the database or rerun migrations for this error.

Browser scrypt is pinned to `@noble/hashes` and matches the server's existing parameters and hex-string salt. The generated file is reproducible with `npm run owner:form`. Tests cover the distributed bundle/CSP, password mismatch handling, SQL injection escaping, first-owner creation, recovery, preservation of other accounts/data, and Worker/D1 sign-in plus mandatory password replacement. The owner subsequently confirmed successful hosted sign-in.

### Authenticated CLI alternative

In the existing local checkout, with the Cloudflare login still active:

```sh
git pull --ff-only
npm run owner:reset -- owner@example.com
```

Replace the example email with the owner's email. The command verifies the exact test database and asks for confirmation, then takes the new temporary password twice through hidden input. It applies no migrations. If no owner exists, it prompts for a display name and creates the first owner. If an owner already exists, the supplied email must identify an active owner; reception accounts and disabled accounts are never promoted or reactivated.

For an existing owner, the guarded update requires the previously read password hash to still match, avoiding overwrite of a concurrent password change. It clears that owner's existing sessions and email-specific login attempt limit, leaves IP limits and other accounts intact, and writes an `owner_password_reset` audit entry attributed to the Cloudflare CLI with no password/hash in the audit record. The command verifies the stored hash privately after saving. Temporary SQL and private logs are removed on completion. Open the application and use the new temporary password; replace it when prompted at first sign-in.

This is an authenticated Cloudflare administrator recovery operation. The assistant has not executed a remote reset or received the owner's password. A hosted login rejection alone is not evidence that a reset has succeeded.

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

## Voucher redemption release 0.4

Health now identifies version `0.4.0`. Existing Workers build/check/test/deploy settings remain unchanged. Opening an owner Sales route initializes the additive redemption ledger, views and guards; `0004_voucher_redemptions.sql` provides the equivalent tracked migration. Existing vouchers begin with their full original value, and existing accounts, passwords, appointments and sales are preserved. No manual console setup or reset is required for this feature.

See [Voucher redemption](voucher-redemption.md) for owner acceptance steps. Browser acceptance and actual email sending remain separate from the automated Worker/D1 checks.
