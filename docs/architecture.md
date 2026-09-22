# Architecture and invariants

## Runtime

Static English UI and a same-origin Cloudflare Worker API; D1 stores records. Node compatibility provides scrypt password hashing. Dependency versions are locked; Wrangler's bundled Miniflare currently uses its v5 prerelease runtime, explicitly pinned for reproducible tests. Test options use the public v4-to-v5 converter plus an explicit `resourcePersistencePath`; the old `d1Persist` option is not preserved by that converter.

The authoritative approved visual reference is `docs/reference/Rei-Booking-v11-Profile-Photos.html`. It is a standalone prototype, not the production data layer. The new UI retains the Rei logo and palette but only exposes implemented first-release workflows.

## Access

| Capability                                        | Owner | Reception | Therapist |
| ------------------------------------------------- | ----- | --------- | --------- |
| Full salon calendar                               | Yes   | Yes       | Yes       |
| Client identities/contacts/notes                  | Yes   | Yes       | No        |
| Create/edit appointments and clients              | Yes   | Yes       | No        |
| Treatment prices and appointment financial fields | Yes   | No        | No        |
| Team/private HR and treatment configuration       | Yes   | No        | No        |
| Account management and audit API                  | Yes   | No        | No        |
| Voucher sales, values, previews and delivery      | Yes   | No        | No        |

Profile creation does not grant access. A therapist account requires a linked active therapist profile. The reception price/payment permission remains a product decision for the Sales stage; this first version conservatively excludes all financial fields for that role.

Sessions use 32 random bytes, a database-stored SHA-256 token digest, a 12-hour expiry, and HttpOnly/SameSite=Strict cookies with the `__Host-` prefix over HTTPS. Each write checks origin and a session-bound CSRF token. Password changes revoke all sessions. Temporary credentials require replacement before accessing operational endpoints. There is no public signup. Sign-in is rate-limited in D1 by hashed IP and email keys. The API whitelists returned fields; it does not merely hide client data in HTML. The frontend discards responses from a previous session after sign-out/account changes.

Password hashes use scrypt N=32768, r=8, p=3, a per-password random salt and 32-byte output. Hosted CPU/memory limits must be verified during test deployment; no claim is made that a free hosting tier supports the selected KDF budget.

## Booking consistency

- Dates and wall-clock minutes belong to Europe/Belgrade. Audit timestamps are UTC ISO instants.
- The first version supports 10:00–22:00 in 5-minute steps. Working hours and dated time off restrict each therapist.
- Room capacities are 2, 2 and 1. Every appointment explicitly occupies a numbered table.
- An appointment expands into half-open five-minute occupancy slots. Database uniqueness on therapist/date/minute and room/table/date/minute is the final authority, even with concurrent requests.
- Insert/update triggers validate capacity and availability, rebuild slots and append audit history in the same transaction. A failed move rolls back both the appointment and its prior slot deletion.
- Cancelled and no-show appointments occupy no slots. Completed appointments retain their historical slots.
- Updates require the version observed by the editor. Stale changes return 409 and do not silently overwrite another user.
- Creating a client from a new appointment is a D1 batch transaction. If booking fails, the new client is not left behind.
- New service selection snapshots its name and price. Editing the menu does not rewrite an existing appointment. All amounts are integer minor units: 100 minor units = 1 RSD.
- Requested therapist ID records the original request separately from the assigned therapist. A move does not silently relabel who was requested; its confirmation and reporting treatment need user acceptance.
- Weekly availability changes are rejected if they strand booked/confirmed appointments from UTC yesterday onward. This conservative one-day buffer avoids missing local-date bookings around midnight; a dedicated effective-dated availability model is future work.

## Reports and Sales

Version 0.2 implements the Dashboard, report API/CSV, Team bonus editor and saved booking rules. See [report definitions](reports.md) for completed-only treatment revenue, requested hours, percentage bonuses and rounding. Payout/adjustment history is not yet implemented.

Version 0.3 adds immutable Sales/voucher snapshots, transactional issuance with request idempotency and catalogue-change guards, and a separate persisted email delivery lifecycle. Sale totals do not alter treatment-performance reports. See [Sales invariants](sales.md). All financial routes remain owner-only; the signed email webhook is the sole sessionless write route and verifies raw-body HMAC before storing events.

There is no delete endpoint for appointments or client history. Audit access is owner-only. Before production, define retention, corrections and export rules alongside reporting requirements.

## Primary implementation references

- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- https://github.com/actions/checkout
- https://github.com/actions/setup-node
