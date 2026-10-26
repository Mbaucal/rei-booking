# Read-only reporting integration (0.20.0)

Owners open **Reports → Google Sheets / API** to create a named access key, choose 30/90/365 days or no expiry, rotate a key, or revoke it. The full secret appears only in the creation/rotation response and the current page. Copy it to private Apps Script Properties or a password manager before dismissing it. Leaving the page, refreshing, signing out or entering a member preview clears the displayed secret. The key list never returns secrets or hashes.

Keys grant `reports:read`, including financial report amounts and optional bonus amounts. They do not grant access to clients, appointments, photos, Sales, account management or any business-data write. Only the issuing owner can manage a key. Up to 20 active keys per owner are supported. Rotation invalidates the old key immediately and returns a new secret; if that response is lost, reload the list, revoke the unrecoverable key and create another.

## Authentication and lifecycle

`GET /api/v1/reports/performance` accepts `Authorization: Bearer <private key>`. It requires that dedicated credential even if a browser is signed in. Cookie-bearing requests, unsupported methods and foreign browser origins are rejected. No credential belongs in the URL, workbook cells, public source, logs or screenshots.

The server stores only a SHA-256 hash of a random 256-bit secret. Additive migration `0018_report_access.sql` stores credential metadata and rate-limit counters. Credentials are bound to the issuing owner's access version. Disabling/demoting the owner, password/account changes, expiry, rotation or revocation invalidate access; re-enabling the account does not reactivate an old credential. Authentication is checked again after report loading. Creating, rotating and revoking keys is audited without the secret/hash. Successful reads update last-use metadata.

The endpoint limits requests to 30 per credential and 120 per source IP per minute. Other API routes continue to require their existing cookie session, role, password and CSRF checks. Member preview cannot create or manage credentials.

## Request

Dates are inclusive treatment dates in Europe/Belgrade. Required `from` and `to` use `YYYY-MM-DD`, span at most 366 days, and must be in order. Unknown, repeated or empty parameters are rejected. Optional parameters:

| Parameter                | Values / meaning                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group_by`               | `therapist` (default), `month`, `day`, `treatment`, `therapist_month`, `therapist_day`, `therapist_treatment`, `therapist_month_treatment`, `therapist_day_treatment` |
| `source`                 | `all` (default), `native`, `history`                                                                                                                                  |
| `therapist`, `treatment` | Stable IDs from the application's report groups/catalogue; omit for all                                                                                               |
| `status`                 | `all` (default), `booked`, `confirmed`, `done`, `cancelled`, `no_show`                                                                                                |
| `requested`              | `all` (default), `yes`, `no`                                                                                                                                          |
| `average_day_basis`      | `active` (default) or `calendar`                                                                                                                                      |
| `include_bonuses`        | `true` or `false` (default)                                                                                                                                           |

For example, the path `/api/v1/reports/performance?from=2026-09-01&to=2026-09-30&group_by=therapist&source=all&include_bonuses=true` selects September's report. The secret is sent separately in the header.

## Response and reconciliation

The response identifies `schema_version: "1"`, `demo: false`, `currency: "RSD"`, `timezone: "Europe/Belgrade"`, the period, effective `filters`, `generated_at`, `metric_basis`, `coverage`, `rows`, `totals`, `previous` and `comparison`. A successful response is complete and has `complete: true` and `next_cursor: null`. There is no silent pagination or truncation.

Each grouped row has a stable `key`, typed `dimensions`, a display `label`, its intersected date range and numeric metrics. Group labels are display text, never unique identifiers. The shared loader and existing calculator also power live Reports and CSV; the integration does not invent a separate calculation engine.

| Metrics                                                                               | Meaning                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `completed_massages`, `native_minutes`                                                | Completed Rei bookings and their minutes                                                            |
| `revenue_cents`, `average_revenue_cents`                                              | Rei treatment revenue after discount, and its average per completed Rei booking                     |
| `regular_minutes`, `requested_minutes`                                                | Completed Rei minutes classified by fulfilled therapist request                                     |
| `massage_minutes`, `included_treatments`                                              | Included native and imported treatment activity combined                                            |
| `historical_rows`, `historical_treatments`, `historical_visits`, `historical_minutes` | Imported source rows, eligible treatment lines, distinct source visits in this group, and minutes   |
| `source_net_sales`                                                                    | Imported source amounts, kept separate by currency and minor-unit scale; never added to Rei revenue |
| `cancelled`, `no_show`, `pending`, `requested_bookings`                               | Status/request counters using existing report definitions                                           |
| `average_minutes_per_day`, `day_count`                                                | Shared weighted report average and chosen denominator                                               |
| `bonus_cents`, `regular_bonus_cents`, `requested_bonus_cents`                         | Optional known earned Rei bonuses only; omitted when bonuses are not requested                      |
| `missing`, `excluded_native_overlap`                                                  | Unknown source evidence and exclusions, preserved explicitly                                        |

Imported attendance excludes only No Show and Canceled/Cancelled when a source status is supplied. Missing status stays unknown. Counting a source visit does not assert verified completion, full price, request fulfillment or bonus. Unknown historical bonuses are represented by the missing counters and are never treated as known zero; `bonus_cents` describes native bonuses only. An empty `source_net_sales` array with missing source-money rows means unavailable imported money, not zero source revenue.

Totals are independently recomputed from matching records. Do not add averages, distinct visit/day counts or alternative snapshots. Prior comparisons use the immediately preceding equal-length period for these explicit custom dates. If the selected period includes today or the future, complete-day comparison is unavailable and `previous`/`comparison` are null.

No client identities, appointment IDs, contacts, notes, portraits or raw imported records are included. Coverage records the actual loaded range, row limits and source revision watermark. `historical_import_completeness: "not_verified"` means the application cannot prove that every Fresha record was supplied. `complete: true` only asserts that this response has not truncated its selected stored data.

More than 20,000 native appointments or 50,000 imported rows in the loaded current/comparison range fails visibly. Historical label limits and source-revision changes also reject the response. Errors must be resolved or retried before writing a snapshot; do not interpret a failed report as zero activity.

## Google Sheets

Use the [downloadable script and setup instructions](google-sheets.md). Deployment does not issue a real key, authorize Google, write a workbook or install a trigger. The first connection and comparison with the user's workbook remain an explicit setup step.
