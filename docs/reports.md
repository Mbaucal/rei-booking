# Reports and bonus definitions

Release 0.2 implements the previously approved report prototype with authenticated Worker/D1 data. The interface is English and all period labels use Europe/Belgrade. Owner access is enforced at the JSON/CSV routes; other roles never receive Team bonus settings. Client identities, contacts and appointment notes are excluded from report payloads and exports.

## Periods and totals

- Last 7 days / Last 30 days end yesterday in Belgrade. Their comparison is the immediately preceding equal-length period.
- Last month is the complete previous calendar month and compares with the calendar month before it.
- Custom periods include both endpoints, with a maximum of 366 days. Completed custom periods compare with the immediately preceding equal number of days. Periods including today or future dates have no full-day comparison.
- Treatment date selects rows. Original booking creation time and cancellation time are separate detail fields, displayed/exported in Belgrade time.
- Shared filters select therapist, treatment variant, status and original client-request flag. Both comparison periods receive the same filters.
- All matching statuses appear in appointment counts/detail. Only `done` (Completed) contributes massage minutes, treatment revenue and earned bonus. Cancelled, no-show, booked and confirmed contribute zero to those earned metrics, even when their listed price is nonzero.
- Treatment revenue is the saved value after discount, before bonuses/costs. It is not net profit, proof of payment or voucher cash receipts.
- Average revenue divides completed treatment revenue by completed massage count. Average hours/day uses either distinct dates with matching completed treatments (default), or all calendar days in the row's intersected period. Month/day groups use their actual slice of a custom period. Grand totals are recomputed, not averages of group averages; distinct salon days are not the sum of therapist days.
- Summary supports therapist, month, day, treatment and five combined groupings. Therapist grouping includes existing team members with zero matching activity. Summary and Appointment list share filters; optional bonus columns affect both the screen and CSV export.

## Bonus rules

Default regular rate is **100 RSD/hour**; fulfilled requested rate is **500 RSD/hour**, replacing the regular rate. Multiply by completed minutes/60. A requested 90-minute treatment earns 750 RSD; a regular one earns 150 RSD. A request is fulfilled when the requested therapist is the therapist who performed it. A replacement is still marked Requested in detail but earns regular-rate hours/bonus.

Team supports one calculation mode per therapist: fixed RSD/hour, or percentage of the **full price** (not the discounted value). Regular/requested rates are separate. Integer rates represent para/hour or hundredths of a percent. A zero rate is valid. Percentage mode does not also apply an hourly bonus.

New bookings save their therapist's current rule. Later Team edits do not rewrite booking rules. Reassigning an unfinished booking captures the new therapist's current rule. Editing a currently Completed booking retains its captured rule. Existing v0.1 bookings use their already-saved hourly-rate columns until their first rule snapshot is stored; they are never backfilled using current Team settings.

Amounts are computed exactly with integer fractions. Within the filtered period, each therapist/category total is rounded half up to a para. Individual row floors receive remaining para by largest remainder, with appointment ID as a stable tie-breaker. This allocation occurs before grouping so detail, group and grand totals reconcile. Changing the filtered set can move a rounding para. Invalid/missing monetary, duration or bonus data blocks the report with an explicit error rather than silently treating it as zero.

## Persistence and delivery

The server automatically installs two empty tables after authentication with idempotent CREATE TABLE IF NOT EXISTS statements. The SQL matches migration 0002. Existing users, bookings and other salon records are preserved. Profile/rate updates use one version-guarded transaction and audit event. Booking/rate writes are atomic with the booking and any new client; failed/conflicting changes cannot overwrite rate snapshots.

JSON endpoint: `/api/reports/appointments`. CSV endpoint: `/api/reports/appointments.csv`, using the same query filters plus `view=summary|details` and `bonuses=1|0`. Both require the owner's session. CSV exports use UTF-8 BOM, quoted fields and spreadsheet-formula escaping. More than 20,000 rows across current/comparison periods produces an explicit shorter-period request; results are never silently truncated.

Monthly scheduled snapshots, email notifications and separately scoped credentials for Google Sheets are not delivered in this release. These remain MBA-81 and MBA-82. No real salon records, messages or spreadsheets were used in development tests.
