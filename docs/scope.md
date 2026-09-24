# Approved scope and implementation queue

All application UI is English. Conversations and planning can remain Serbian. Preserve the Rei green/ivory/gold identity and supplied logo. The v11 reference is the approved prototype; do not treat demonstration functionality as a finished backend feature.

## Active first slice

| Linear | Scope                                   | Status in code                                                                                                                                   |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| MBA-71 | Private repository and test environment | GitHub repository public; dedicated test Worker/D1 deployed; owner confirms hosted sign-in; device/backup acceptance pending                     |
| MBA-72 | Calendar                                | Persistent day/calendar/API, therapist/room views, optional client, 5-minute edits, pointer drag, conflict protection; device acceptance pending |
| MBA-73 | Clients and treatments                  | Persistent CRUD/search/history and treatment variants; private profile photos; imports pending                                                   |
| MBA-74 | Permissions                             | Owner/reception/therapist server projections and protected actions; hosted acceptance pending                                                    |
| MBA-79 | Team                                    | Profiles, weekly hours, dated time off, bonus configuration and account separation; private profile photos included                              |

## Reports and bonuses: MBA-80

Implemented in v0.2 with persistent Worker/D1-backed report and CSV endpoints, Team rate settings, booking rate snapshots, owner-only access and Dashboard comparisons. Monthly delivery/archive and Sheets credentials remain separate work.

Detailed rows: therapist, massage date/time, duration, full and discounted price, when booked, cancellation/status and requested flag. Filter/group by therapist, date/month and treatment. Summary: treatment count, completed hours, requested hours, earned treatment revenue, average earned revenue per massage, average hours per day and total hours for the chosen period. Implemented both denominators: default distinct dates with completed massages, or all calendar days in the selected/group period; labels and CSV identify the choice.

Bonus is proportional to **completed minutes**, not appointment count. Current rule: normal 100 RSD/hour; requested 500 RSD/hour replacing the normal rate. For example, a completed 90-minute massage earns 150 RSD normal or 750 RSD requested. Cancelled appointments do not earn worked-hour bonuses. Bonus configuration belongs in Team; results belong in reports. Percentage mode is optional and implemented on the full treatment price, without applying it twice or to discounted value. Preserve effective-dated rate snapshots and define rounding. Do not reuse older EUR or per-appointment rules from unrelated projects.

Main Dashboard: Last 7 days / Last 30 days, total earnings and change versus the immediately preceding equal-length period. These are revenue comparisons, not net business profit. Avoid adding a separate bonus tab.

## Scheduled exports and integration: MBA-81 / MBA-82

Owner-selected monthly report with an email notification when the previous month's report is ready, plus CSV export/archive inside the app. Salon timezone and month boundary must be explicit. Optional owner-only scoped API for automatic Google Sheets Apps Script retrieval, with revoked credentials and clear report definitions. This is an application feature, not a ChatGPT reminder automation.

## Sales and gift vouchers: MBA-76

Implemented in v0.3: owner-only persistent sold register/CSV, current-menu and custom-amount vouchers, cart, optional atomic new/existing buyer, separate recipient, immutable codes and snapshots, personalised/default designs, preview and browser print/PDF. Email previews, provider sending and signed delivery events are implemented; live sending remains disabled pending DNS verification and server secrets. Redemption/refunds, package rules and reception financial permissions remain pending. See [Sales implementation](sales.md) and [email setup](email-setup.md).

- Visible Sales navigation, sold voucher list, search, dates/statuses and details.
- Sell a predefined treatment type + duration + fixed price, or a custom monetary amount. Prepare for the new menu; do not hardcode illustrative prices as the final menu.
- Cart and optional existing/new buyer client. Buyer is separate from the recipient; recipient email must not default silently to buyer email.
- Unique immutable code per voucher, sale linkage, status, balance/entitlement and redemption history. Clarify expiry and treatment substitutions before activation.
- Custom Rei voucher appearance, original logo, recipient name/message and preview.
- Send the voucher directly from **info@reithailandmassage.com** after explicit sale/delivery action, with preview, reliable retry/idempotency and delivery status. No messages are sent during development tests.
- Package sales and redemptions alongside vouchers. Do not double-count voucher purchase and treatment redemption as the same earnings metric.

## Profile photos: MBA-73 / MBA-79

Optional upload/change/remove for clients and team, supported file validation, size limits, image processing and persistent private storage. Team photos can appear in calendar headers. Therapist view must not receive client photos, initials, names or other identifying information. Implemented in v0.6 with bounded, processed portraits in private D1 storage, authenticated image delivery and atomic profile/photo saving. See [profile photos](profile-photos.md).

## Import: MBA-75

Import clients and past appointments from exports, with preview, normalization, duplicate resolution and rollback/reconciliation. Retain original booking dates, treatment duration, therapist and request history where present. Work on copies; import real records only after access and recovery checks.

## Loyalty: MBA-77

Planned, but earning/redemption rules are undecided. Do not invent points, discounts, visit thresholds or payouts. Keep it out of active monetary calculations until approved.

## Scope boundaries

CMS and Staff Planner are design/repository references, not automatically integrated services. Financial setup, voucher delivery configuration, hosted backups and device checks remain explicit unfinished work.
