# Rei Booking

Current implementation release, **0.3.0** — 22 September 2026.

An English-language internal booking application for Rei Thailand Massage. This is a working development slice with a real server and persistent database. The test Worker is deployed, the database tables exist, and the owner confirmed successful hosted sign-in. This is **not the complete approved product**. The approved v11 prototype remains the reference for the remaining screens and workflows.

## Included

- Owner **Sales → Gift vouchers**: sold register, search/date filters, CSV, treatment/custom-amount cart and atomic checkout with an optional buyer.
- Personalised voucher design, unique immutable codes, treatment/price snapshots, separate buyer/recipient, preview and browser Print / Save as PDF.
- Persisted email previews, guarded Resend sending/retries and signed delivery callbacks. **Live sending is disabled pending domain verification and Worker secrets.** No email was sent during development.
- Owner Dashboard with completed treatment revenue, massage count and hours, Last 7/30 days and previous-period comparisons.
- Owner Reports with shared filters, nine groupings, Summary/Appointment list, and CSV export without client identities.
- Team bonus settings: 100 RSD/hour regular, 500 RSD/hour fulfilled requested by default; optional percentages on full price. Persisted booking rate snapshots and reconciled report totals.
- Cookie-based sign-in, password change, first-login password replacement and owner-managed accounts.
- Server-enforced owner, reception and therapist permissions.
- Client records and name/phone/email search, contact deduplication, visit history and optional walk-ins.
- Therapist profiles, weekly hours and dated time off, independent of login accounts.
- Treatment variants with duration, price and calendar colour.
- Daily calendar by therapist, room or both; two-table couple rooms; current Belgrade time.
- Click-to-book, add a new client while booking, appointment editing and a pointer-based drag handle with 5-minute snapping.
- Database-level prevention of simultaneous bookings for the same therapist or table, including concurrent requests.
- Version checks against overwriting another user's edits, appointment creation timestamps, price/name snapshots and owner-only audit data.

The browser interface is responsive in code but **desktop/tablet/mobile visual and touch acceptance checks are still pending**. This release uses 30-second calendar refresh and refresh on window focus; it is not a push-based realtime feed.

## Local setup

Requires Node.js 24 and npm. Do not load this application's `index.html` directly from disk; it requires its API. The standalone prototype under `docs/reference/` is separate.

```sh
npm ci
npm run db:local
```

Create the first owner using a private JSON file containing `email`, `name` and a temporary `password` of 12–128 characters. Use an editor or password manager on your own machine; do not put passwords in shell arguments, commits, issues or chat. Restrict the file to your OS account.

```sh
npm run owner:prepare -- /absolute/path/to/private/owner.json
npx wrangler d1 execute rei-booking-test --env test --local --file private/first-owner.sql
npm run dev
```

Open `http://localhost:8787`. Change the temporary password at first sign-in, then add team profiles, treatment variants, clients and user accounts. There is no public registration or built-in demo password. The preparation script creates an owner only if no owner exists. Delete the input credential file and generated SQL after successful provisioning.

Local data lives in `.wrangler/state/`. Keep that directory to preserve development data. Automated tests use an isolated temporary D1 database with fictional records and remove it afterward.

## Checks

```sh
npm run check
npm test
npm run build
```

`npm test` runs the actual Worker with D1 in Miniflare, including a runtime restart and simultaneous writes. `npm run build` bundles a deployment dry run and does not publish. The GitHub Actions workflow performs these checks with read-only repository access; it has no deployment credentials. The initial implementation passed [GitHub Actions](https://github.com/Mbaucal/rei-booking/actions/runs/35763142350); subsequent results are under Actions.

## Test deployment

For browser-based owner setup or recovery, download [owner-access.html](docs/tools/owner-access.html) and open the downloaded file in Safari, Chrome or Firefox. It is self-contained and works offline. Enter your owner email, name and a new temporary password; use **Show passwords** to check the input. Click **Prepare Cloudflare command**, then paste the entire result into **Cloudflare → D1 Database → rei-booking-test → Console** and click **Execute**. An `OWNER_READY` result confirms the password was saved. Sign in to the application and replace it when prompted. No terminal, deployment or password sharing is needed for this method.

The form does not connect to Cloudflare or the application. Executing its command requires your existing Cloudflare database administrator access. It creates the first owner or resets the matching active owner, revokes only that owner's sessions, clears its email login limit and records an audit event. It cannot promote another role or reactivate an account. Use the command once, then clear the form. Its browser scrypt output is tested against the server verifier and the actual Worker/D1 sign-in and password-change flow. To regenerate the downloadable file from its source, run `npm run owner:form`; the browser dependency license is included alongside it.

The owner's Cloudflare log confirms deployment at **https://rei-booking.mbaucal.workers.dev** with the dedicated D1 database `rei-booking-test`. The configuration matches that actual Worker name and address. A later screenshot confirms the application tables and migration-tracking table; the owner has now confirmed successful sign-in.

With Node.js 24 installed, run these commands from this repository, replacing the example email with the owner's email:

```sh
npm ci
npx wrangler login
npm run setup:test -- owner@example.com
npm run deploy:test
```

The setup command checks the test database ID, asks before applying pending migrations and creates the first owner only if none exists. It asks for the display name and a temporary password through hidden terminal input. Passwords are never shell arguments. The temporary SQL and associated setup log are removed when the command finishes. Existing accounts and passwords are preserved. Change the temporary password at first sign-in.

See [the deployment guide](docs/deployment.md) for details and the manual alternative. `npm run dev` uses the localhost origin separately. Do not repurpose the CMS or Staff Planner database.

If the initial password is lost or was entered incorrectly, run `npm run owner:reset -- owner@example.com` from an up-to-date checkout in the same authenticated terminal. Enter the real owner email instead of the example. This checks the dedicated test database, resets only the matching active owner's password, signs out that owner's existing sessions and requires a password change at the next sign-in. If no owner exists yet, it creates the first owner after prompting for a name. It does not promote another role or reactivate a disabled account. The password is entered privately and never passed as an argument. This command requires Cloudflare database administrator access; it is not a public password-reset endpoint.

## Reporting operations

The report update automatically creates two empty bonus-rule tables after authentication. It is an additive, idempotent migration and preserves all existing records; no terminal or manual SQL is needed. The same SQL is supplied as `migrations/0002_report_bonuses.sql` for tracked Wrangler migrations. Existing appointments retain their original hourly-rate columns until a snapshot is captured. Team rate changes apply to new bookings. Reassigning an unfinished appointment uses the new therapist's rate; completed appointments retain their saved rates. Reports count only Completed appointments as earned treatment revenue, hours and bonuses. Last 7/30 days exclude today; Last month compares calendar months. See [report definitions](docs/reports.md).

## Next implementation stages

1. Confirm Reports/Team/Dashboard and Sales on the test URL and complete role/device acceptance.
2. Finish [voucher email setup](docs/email-setup.md) and agree redemption, refund, package and reception sales permissions. See [the implemented Sales scope](docs/sales.md).
3. Add scheduled monthly reporting, email notifications and an authenticated Google Sheets integration.
4. Add private profile-photo storage for clients and team, import/history migration and approved loyalty rules.

These requirements are preserved in [scope and decisions](docs/scope.md). An item being in the prototype does not mean it is implemented in this release.

Opening Sales as owner installs its empty additive tables and indexes automatically (`0003_sales.sql`); no terminal or manual SQL is required. Existing data and owner access are preserved. Sales records payments already received externally; voucher redemption, refunds and card charging are not implemented. Gift sales are not added to completed-treatment revenue on the Dashboard.

Repository: https://github.com/Mbaucal/rei-booking

Project: https://linear.app/mbaucal/project/rei-booking-42809d54d6b8

Setup: https://linear.app/mbaucal/issue/MBA-71/postaviti-zaseban-github-repozitorijum-i-test-okruzenje
