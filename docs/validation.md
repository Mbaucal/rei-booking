# Development validation — 26 September 2026

## Client transfer release 0.8 — 26 September 2026

Local `npm run check`, `npm test` and `npm run build` passed: **83 tests, 0 failures**. Local application of all eight tracked migrations also succeeded.

The new real Worker/D1 integration covers owner-only import/export, reception/therapist/anonymous denial, origin and CSRF enforcement, explicit column mapping, normalization, conflicting/shared contacts, no merging by name, preview without client writes, selected-row validation, owner isolation, retry receipts, competing previews, stale normal edits, forced transactional rollback, spreadsheet-safe export and Rei round-trip decoding, expiry, disabled accounts, Worker restart and a 1,000-client import. It checks additive schema/migration parity and that applied previews discard mapped personal data. Existing application suites remain enabled.

Only fictional local clients/accounts were used. No real salon records or messages were created. Browser validation was attempted using a local Worker/D1 harness, but Playwright has no installed Chromium executable. Desktop/mobile visual and touch acceptance are still pending; code review is not claimed as browser acceptance. Real Fresha client column acceptance and historical appointment migration remain separate work under MBA-75. Email setup and remaining vouchers are deferred.

## Monthly reporting release 0.7 — 24 September 2026

Local `npm run check`, `npm test` and `npm run build` passed: **71 tests, 0 failures** (including parent integration tests).

New tests run the actual Worker and persistent D1 with fictional accounts and appointments. They cover owner isolation/CSRF, automatic schema and tracked migration parity, stale schedule writes, concurrent snapshot generation, immutable source/CSV reconciliation, previous-period comparisons and bonus inputs, correction retries, retained originals and template versions, Belgrade DST/leap-year/year boundaries, pause/resume, catch-up and empty months, incomplete data without fabricated totals, recipient verification/rate limits/expiry, atomic email claims, exact retry payload/key, signed callbacks and suppression. The Worker's actual scheduled entry point is invoked and data survives a Worker restart.

Email transport is mocked. No actual email, account credentials or salon records were changed. Local browser navigation was blocked by the browser environment; no visual, touch or hosted email acceptance is claimed. Hosted Cron timing and delivery after sender setup remain operational checks. GitHub/Cloudflare results are recorded in MBA-81 after publishing.

## Profile photo release 0.6 — 24 September 2026

Local `npm run check`, `npm test` and `npm run build` passed: **61 tests, 0 failures** (including parent integration tests). Actual Worker/D1 checks cover private client/team image delivery, role and CSRF enforcement, validated JPEG decoding and metadata removal, invalid/oversized input preserving the current portrait, atomic profile/bonus/photo updates, concurrent replacements, revision-preserving removal, schema/migration parity and persistence across a Worker restart. A full 100-client page and larger catalogue are hydrated within D1 statement binding limits. Draft tests cover stale processing after replacement, removal, undo and profile/session changes. Canvas and orientation calls use mocks, not real browser rendering.

The existing appointment, reporting, voucher, email and account suites also pass. No real photo, credential, payment or email was changed. GitHub/Cloudflare results are recorded in MBA-73 and MBA-79 after publishing. Real camera/device, visual and touch acceptance and photo processing responsiveness on the actual Worker plan remain pending; see `docs/profile-photos.md`.

## Voucher changes release 0.5 — 24 September 2026

Local `npm run check`, `npm test` and `npm run build` passed: **51 tests, 0 failures** (including parent integration tests). New Worker/D1 scenarios verify owner/CSRF enforcement, explicit confirmations, stale balance rejection, repeatable schema initialization and tracked migration parity, concurrent identical retries, changed retry rejection, simultaneous use versus closure, void/refund totals, Net sales versus All records CSV, formula escaping, invalid-code print/email/use, immutable audit/history, remaining-balance refunds, blocked post-refund reversals, original treatment report preservation and corrected-code chains retaining archived menu snapshots without a duplicate sale.

No real voucher, payment, password or email was changed by these tests. GitHub and Cloudflare results are recorded in MBA-76 after publishing. Hosted visual and device acceptance remain pending.

Validated locally with Node.js 24.19.0, Wrangler 4.136.3 and its Miniflare/Workerd D1 runtime. Only fictional test records were used.

## Build regression fix — 23 September 2026

Cloudflare build `972ae38d-e381-44ae-8dc4-89c0d0df1110` failed on the successful appointment move assertion (`409 !== 200`). The preceding parallel-booking test let either therapist reserve 13:00 on the same date as a later 12:05–13:05 move. The result therefore depended on which concurrent request succeeded. The server correctly rejected a real five-minute therapist overlap.

The parallel requests now use a separate date. The test still sends both requests concurrently, requires one 201 and one 409, and additionally checks that exactly the winning appointment and its twelve five-minute slots persist. No application code, conflict constraints, credentials, database contents, deployment commands or test gates were changed.

Verification used fictional local data only:

- Reproduced the original Cloudflare assertion in the actual Worker/D1 suite by deterministically executing the second contender first.
- Ran the corrected Worker/D1 suite with each contender deliberately winning in turn; both passed. These temporary order-control copies were removed; the committed test retains `Promise.all`.
- All 38 tests passed with the original concurrent requests after the fix.
- JavaScript syntax and the configured Worker deployment dry run passed.

A successful hosted deployment is a separate check; see `docs/deployment.md`. Existing device, email and production acceptance limitations below still apply.

## Voucher redemption release 0.4

Seven new Worker/D1 scenarios cover schema/migration parity and repeated initialization; lookup/role/CSRF checks; partial amount use and concurrent idempotent retries; concurrent spending and appointment coverage; exact treatment/duration entitlements and discounted prices; invalid/stale/future/expired uses; auditable corrections, immutable history and protected appointment edits; and suppression of an old email preview after voucher use. The parent scenario is also counted by Node. Reports and original sale values are compared before and after use. All records and email transports are fictional/local.

Local validation: all 46 tests, JavaScript syntax checks and the configured deployment dry run passed. The cloud browser could not reach the disposable local fixture (`ERR_BLOCKED_BY_CLIENT`), so no visual, keyboard or mobile acceptance is claimed. The new workflow still needs a test in the hosted application. See `docs/voucher-redemption.md` for steps and limits.

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
- Hosted scheduled report timing and live email setup/delivery; scoped Sheets integration, voucher payment processing/packages, imports and loyalty calculations. Monthly archive/email implementation and private photos are included; the owner confirmed photo upload works, while broader device acceptance remains pending.

The first slice is suitable for code review and deployment to a dedicated fictional-data test environment once access is configured. It is not a sign-off for live salon use.
