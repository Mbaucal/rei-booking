# Development validation — 22 September 2026

Validated locally with Node.js 24.19.0, Wrangler 4.136.3 and its Miniflare/Workerd D1 runtime. Only fictional test records were used.

## Sales release 0.3

Added actual Worker/D1 checks for automatic additive schema, template version/audit consistency, explicit validity/payment confirmation, unique voucher codes, optional buyer and no automatic sending, concurrent checkout retries with one atomic new client, rejection of changed retry contents, immutable snapshots across menu edits, issued-record guards, filtered CSV/formula escaping, print content, unchanged treatment-report revenue and owner-only API/CSV/print/email access.

Email checks use an injected mock transport and the real D1 outbox: explicit recipient and no buyer CC/BCC, immutable reviewed payload, disabled unconfigured sending, atomic send claim, identical payload/idempotency key on network retry, 23-hour retry cutoff, accepted-versus-delivered status, signed callback before API response, duplicated/late callbacks and bounce suppression. Signature verification also matches the independent published Svix test vector and rejects modified/old requests. No real messages were sent.

Connected-account inspection found the Resend sender domain present but `not_started`. No domain/DNS/API-key changes were made. Live sending, visual/keyboard/device acceptance and the deployed v0.3 UI remain unverified.

## Reports release 0.2

The user confirmed successful hosted owner sign-in. Local report checks cover completed-only revenue/hours, fulfilled requested vs replacement rates, full-price percentages, exact bonus-cent allocation across every grouping, filter application, partial-month denominators, leap-year/DST/date boundaries, zero-baseline comparison, CSV formula escaping, missing inputs, and duplicate IDs. The additive runtime schema matches the Wrangler migration and can be reapplied without modifying existing records.

Worker/D1 integration verifies Team rates persist, stale edits cannot replace them, existing booking rates/creation timestamps survive profile and appointment edits, newly created appointments use the new rate, report totals reconcile with CSV, and both JSON/CSV routes plus bonus configuration reject reception/therapist access. Actual hosted rendering, CSV download interaction and touch layout are still pending; no browser acceptance is claimed.

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
- Hosted acceptance of the new Reports/Dashboard/Team bonus screens. Initial schema, origin and successful owner sign-in have been confirmed by the user.
- Hosted login performance/CPU budget, backup export/restore drill and operational monitoring.
- Scheduled report archive/email, scoped Sheets integration, voucher redemption/refunds/packages, live email setup, private photo uploads, imports and loyalty calculations.

The first slice is suitable for code review and deployment to a dedicated fictional-data test environment once access is configured. It is not a sign-off for live salon use.
