# Development validation — 22 September 2026

Validated locally with Node.js 24.19.0, Wrangler 4.136.3 and its Miniflare/Workerd D1 runtime. Only fictional test records were used.

## Passed

GitHub Actions also passed for implementation commit `d2ba4e8c1d9a2d9f9e73483b91445990a21dc2a3`: https://github.com/Mbaucal/rei-booking/actions/runs/35763142350 (completed 22 Sep 2026, 17:50 UTC).

- JavaScript syntax checks for the server, browser code, scripts and tests.
- The actual D1 migration via `npm run db:local` (21 SQL commands).
- Worker deployment dry-run compilation with the assets and D1 bindings.
- First-owner SQL generation, apostrophe escaping, mandatory first password change flag and prevention of a second bootstrap owner.
- Two additional SQLite tests verify first-owner provisioning with the real migration and password hash, preservation of an existing owner, and rejection of an attempt to promote an existing reception email through setup.
- Owner recovery tests verify new-password acceptance and old-password rejection, scoped session and email-limit cleanup, preservation of other accounts and salon records, an audit entry without credentials, and refusal to overwrite changed identity, role, status or password.
- Interactive hidden-password input checked with a fictional value in a terminal; the entered value was not echoed.
- Actual Wrangler D1 JSON output checked against an isolated temporary local database. Reproduced that `WRANGLER_LOG=error` suppresses the JSON result required by setup; verified that `WRANGLER_LOG=log` returns valid results. Setup now retains that normal log level, while sensitive output remains captured and its log stays in the private temporary directory. No remote database was used for this check.
- Deployment guard checks the exact test database, Worker name and HTTPS origin before publishing. The dry run bundles `rei-booking` with origin `https://rei-booking.mbaucal.workers.dev` and database `rei-booking-test`.
- 11 Worker/D1 integration scenarios (Node reports 12 passing tests including the parent test):

  1. Sign-in, origin and CSRF checks.
  2. Entity persistence, normalized phone/email deduplication/search and stale-version rejection.
  3. Two-table capacity, therapist/table overlap and five-minute time validation.
  4. Two simultaneous booking attempts: exactly one succeeds.
  5. Failed-move rollback; successful move preserves booking creation time and original therapist request.
  6. Atomic new-client/appointment creation; cancellation releases occupancy.
  7. Weekly working hours, time off and prevention of conflicting availability changes.
  8. Menu edits preserve existing appointment name/price snapshots.
  9. Therapist receives the full calendar without client PII; reception receives no financial fields; protected routes reject unauthorized access.
  10. New accounts, forced password replacement, revocation, audit access and hashed session storage.
  11. Data survives a Worker restart with persisted D1; logout invalidates the session.

## Not yet verified or delivered

- Browser visual checks, keyboard/screen-reader review and touch interaction on real devices. Automated browser review of local files was unavailable in this session; no substitute browser route was used.
- Remote migrations, owner provisioning and hosted sign-in. The owner's screenshots confirm creation of the dedicated D1 database and successful Worker deployment at https://rei-booking.mbaucal.workers.dev. The repository is now public. The deployment log exposed an origin mismatch, which is corrected in source; corrective redeployment and runtime acceptance remain pending.
- Hosted login performance/CPU budget, backup export/restore drill and operational monitoring.
- Complete reporting/bonuses, voucher sales/redemption/email delivery, private photo uploads, imports or loyalty calculations.

The first slice is suitable for code review and deployment to a dedicated fictional-data test environment once access is configured. It is not a sign-off for live salon use.
