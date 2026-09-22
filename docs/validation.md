# Development validation — 22 September 2026

Validated locally with Node.js 24.19.0, Wrangler 4.136.3 and its Miniflare/Workerd D1 runtime. Only fictional test records were used.

## Passed

- JavaScript syntax checks for the server, browser code, scripts and tests.
- The actual D1 migration via `npm run db:local` (21 SQL commands).
- Worker deployment dry-run compilation with the assets and D1 bindings.
- First-owner SQL generation, apostrophe escaping, mandatory first password change flag and prevention of a second bootstrap owner.
- Deployment guard rejects the placeholder database configuration before publishing.
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
- GitHub Actions result, remote D1 instance or hosted test URL. The private repository has now been created at https://github.com/Mbaucal/rei-booking.
- Hosted login performance/CPU budget, backup export/restore drill and operational monitoring.
- Complete reporting/bonuses, voucher sales/redemption/email delivery, private photo uploads, imports or loyalty calculations.

The first slice is suitable for code review and deployment to a dedicated fictional-data test environment once access is configured. It is not a sign-off for live salon use.
