# Historical appointment import contract

Task: [MBA-174](https://linear.app/mbaucal/issue/MBA-174/history-migration-confirm-source-mapping-and-client-identity-links), under [MBA-75](https://linear.app/mbaucal/issue/MBA-75/migracija-uvoz-i-izvoz-klijenata-i-dostupne-istorije).

Baseline: main `6b8a52fa7e82617b3de029c8af84b24d16a367b6`, application 0.9.0. Prepared 30 September 2026 (Belgrade). This is an implementation contract, not a shipped importer. No records, schema, reports or current appointment behavior change in this task.

## Evidence and remaining source access

The application already displays native Rei appointments in client profiles. Its CSV workflow imports client profiles only. Fresha appointment history requires a separate workflow.

The earlier file **report_appointment-list_2026-01-27.csv** was located again on 29 September: filename and 86,063-byte size verified from file metadata. It has no readable extracted text; both download attempts failed with HTTP 502. Its current bytes and complete header list have therefore **not** been rechecked. The original client export was not located by the scoped project searches. No unrelated files were opened.

The following facts are **secondary evidence from the previous source inspection in MBA-75**, not a new inspection or a guaranteed format for every Fresha export:

- 337 data rows, 18 columns and 337 distinct `Appt. ref.` values in that sample.
- Scheduled dates cover 2–27 January 2026, not a full month. Created dates span August 2025–January 2026.
- Five team members and seventeen treatment labels.
- Client identity is a name only: no client ID, phone or email in that report.
- `Requested` is absent. Status counts were New 196, Confirmed 68, Started 30, Cancelled 37 and No Show 6. There was no explicit Completed status.
- Timestamps have no timezone offset. `Net sales` remains nonzero on some cancelled/no-show rows.

Recover the bytes before accepting a source adapter: record the exact headers, delimiter, encoding, date/decimal syntax and file digest. Do not extrapolate all 18 headers from the partial inspection. Keep private source files and client values outside the repository and tests.

## Source-to-record mapping

The names in the first column below come from the earlier inspection. They remain provisional until reinspection. Preserve original text alongside parsed values and mapping decisions.

| Source evidence                                    | Historical field                                            | Rule                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Appt. ref.`                                       | `sourceAppointmentRef`                                      | Preserve as text. Unique in one sample does not prove one row per appointment in all exports.                                                             |
| Client name column                                 | `sourceClientLabel`, `clientId`                             | Label is provenance; `clientId` stays unresolved until identity is established.                                                                           |
| `Team member`                                      | `sourceTherapistLabel`, optional `therapistId`              | Map explicitly to an existing therapist; preserve original label. Never infer a request from a name or emoji.                                             |
| Treatment label                                    | `sourceServiceLabel`, optional `serviceId`                  | Exact source header still needs verification. Preserve the historical label and duration even after menu edits.                                           |
| `Scheduled date` / `Appt. slot`                    | `scheduledLocalDate`, `startMinute`, optional `scheduledAt` | Validate that fields agree; retain raw text. Derive an instant only with a confirmed source timezone.                                                     |
| `Duration (mins)`                                  | `durationMinutes`                                           | Earlier values included `1h 0min`, `1h 30min`, `30min`, `45min`, `2h 0min`. Parse to integer minutes; do not treat the header as proof cells are numeric. |
| `Created date`                                     | `sourceCreatedAt`                                           | Original booking creation time, separate from import time and appointment time. Unknown or invalid is not replaced by the import timestamp.               |
| `Cancelled date`                                   | `sourceCancelledAt`                                         | Preserve if present; disagreement with status is a review flag.                                                                                           |
| `Status`                                           | `sourceStatus`, `completionState`                           | Preserve source status verbatim. Completion is `completed`, `not_completed` or `unknown`, with the basis recorded.                                        |
| `Net sales`                                        | `sourceNetSalesMinor`, `currency`                           | Parse decimal money without floating-point rounding. Verify currency/decimal format. This is neither full price nor proof of payment.                     |
| No supplied full price / receipt evidence          | `fullPriceMinor`, `paidAmountMinor`                         | Unknown remains null. Never copy net sales into both fields.                                                                                              |
| No `Requested` evidence                            | `requestState`, `requestedTherapistId`                      | `requestState = unknown`; distinguish it from an explicit no. Requested therapist and fulfillment remain unknown.                                         |
| No historical bonus rule evidence                  | `bonusRule`, `bonusAmountMinor`                             | Null/unavailable. Never apply today's 100/500 RSD rates or current percentage rule retroactively.                                                         |
| Room/table not established by the prior inspection | `sourceRoomLabel`, `roomId`, `bed`                          | Unknown remains null. Do not invent a resource to satisfy live booking constraints.                                                                       |

Missing optional values, conflicting values and invalid values are distinct. Do not convert an unparseable amount to zero, a missing name to a walk-in, or a missing timestamp to today's date. Unknown columns are ignored unless mapped; strings are escaped on display and exports protect spreadsheet formula cells.

## Identity crosswalk, including existing clients

One salon/source namespace plus one verified external client ID identifies at most one Rei client. Preserve external IDs as strings, including leading zeros. The current `client_import_keys` format is `source` plus `id:` and `digest(trimmedExternalId)`; without an ID it uses a file/row key. Reuse the same digest and normalization when reading that crosswalk. A file/row key is repeat protection, not an external person identity.

Resolve each candidate in this order:

1. Look up a verified source client ID where the exports supply one. If other supplied contacts contradict the linked client, return a conflict instead of silently following the ID.
2. Otherwise compare explicit phone/email/Instagram evidence using the existing normalizers. All available matches must identify the same client, with no conflicting nonempty details. A unique compatible contact match may be proposed in the preview.
3. A name-only match is a suggestion requiring explicit owner selection, even if only one profile has that name. Do not fuzzy-match and automatically attach historical visits. Ambiguous or conflicting matches remain unresolved.
4. If the history report contains only names, a separate client export containing IDs/contacts does not by itself prove which same-named person owns a history row. Review that join. Do not turn the name into a global crosswalk key. Allow a reviewed selection to apply to explicitly selected rows, showing their count and dates.
5. Unresolved rows can remain in a private preview. They do not create clients, attach visits, or contribute to client totals. A confirmed source walk-in is different from an unresolved named person.

**Existing-profile gap:** the current client import writes source keys only for selected newly created profiles. Existing contact matches are skipped, leaving no new source-ID mapping. The future history workflow must support an explicit **Link existing client** decision without reimporting or overwriting that profile.

That link operation must show the external identity and target profile, recheck current contacts/profile version, enforce unique source identity atomically, and record owner, source import, method and time. The same link is idempotent; a link to a different client is a conflict, never an upsert that reassigns history. Client notes, photos, appointments and current contact values remain unchanged. If the existing `client_import_keys` table is reused, its required `import_id` must reference a legitimate client-import record; do not fabricate one to bypass the foreign key. Final persistence design belongs to the later implementation issue.

## Status, time and financial eligibility

Default interpretation preserves what is known:

| Source status                                  | Completion default | Behavior                                                                                 |
| ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Cancelled                                      | `not_completed`    | Show cancellation history; exclude from completed visits/hours/earned bonuses.           |
| No Show                                        | `not_completed`    | Show no-show history; exclude from completed visits/hours/earned bonuses.                |
| New / Confirmed / Started                      | `unknown`          | Preserve the source label. A past date or Started is not evidence the massage completed. |
| Explicit Completed in a future verified export | `completed`        | Accept only after that source value is verified and mapped.                              |
| Any other/unmapped status                      | `unknown`          | Keep visible for review; never silently map to completed.                                |

An owner may later approve an evidence-based historical completion rule for a specified source/date range. Record the rule version and affected rows, preserve original statuses, and preview changed totals. No such rule has been approved yet.

The application uses Europe/Belgrade reporting days, but that does not establish the export timezone. Retain local date/time and a nullable source timezone until confirmed. Validate day/month order, midnight/date boundaries, ambiguous/nonexistent daylight-saving times and contradictory date/slot values; never use the machine's timezone as a fallback.

Historical visit display and financial eligibility are separate. Known completed history can contribute to completed-visit counts once identity/time mapping is accepted; missing request/rate data still makes bonuses unavailable. Missing financial fields stay unavailable and are excluded from the corresponding totals with a visible excluded-record count. Do not report unknown amounts or bonuses as zero. Imported net sales must have a distinctly labeled metric, not silently enter received-payment or full-price totals. No historical financial backfill is authorized by this contract.

## Persistence boundary and repeat safety

Use a separate historical archive model in the later implementation, with source provenance and nullable unknowns. Do not feed imported rows through the live appointment-create route or insert them directly into today's `appointments` table:

- Live appointments require a current therapist, service, room, bed, prices and a limited status enum.
- Its triggers enforce current working hours/time off and create `booking_slots` for non-cancelled/non-no-show appointments.
- It has default bonus rates and represents absence of a requested therapist as no request; the report calculator requires complete financial/rate data.

An archive avoids inventing old rooms and avoids historical rows consuming live calendar capacity. Adding archive records to profile history and reports is a separate, explicit integration with privacy projections, missing-data labels and deduplication. Native history remains intact.

Proposed idempotency rules:

- Prefer a verified source namespace + appointment reference + stable service-line ID when the source supplies one. Do not assume `Appt. ref.` is globally unique or service-level from the 337-row sample alone.
- If the export is verified as exactly one service per appointment, namespace + appointment reference may be used. Multi-service rows need a verified line identity or explicit collision review; row position and treatment name alone are insufficient.
- Same logical source key and unchanged canonical payload is a duplicate. Same key with changed source content is a conflict requiring a reviewed correction; do not overwrite or add a second visit silently.
- Without a stable key, a file digest + row index protects exact-file retries only. Overlapping/reordered exports require review, not an assumption of uniqueness.
- A native appointment resembling a historical record is a possible overlap. Do not automatically merge by date/client/treatment. Require an explicit existing-record link before both can enter combined totals.
- Confirmation revalidates preview revision, selection and identity decisions. A stale preview fails cleanly. A repeated confirmation returns the original receipt. Committed records and identity links must be atomic within the chosen bounded batch; a partial import must never be presented as complete.

## Proposed preview contract

This is a proposed interface for the next phase, not an existing endpoint. Each row has a stable preview `rowId`, raw-source provenance, normalized values, candidate links, review reasons and a selected flag. Server-generated decisions are authoritative.

`disposition` is exactly one of `ready`, `unresolved`, `conflict`, `duplicate` or `invalid`. Aggregate counts for those states must sum to input row count. `linked` is a separate identity metric, not another mutually exclusive disposition. Show selected-ready count and separate eligibility counts for visits, source net sales and bonuses. Unknown-value counts prevent an apparently complete total from hiding gaps.

- `ready`: required source fields and accepted mapping are sufficient for the intended archive operation; all review decisions resolved.
- `unresolved`: missing identity, timezone or other required decision; stays unselected.
- `conflict`: contradictory identity/source key/overlap evidence; stays unselected.
- `duplicate`: already represented by the same source key and payload; skipped.
- `invalid`: required source values cannot be parsed or fail validation; skipped with a row-specific reason.

Owner-only preview/import APIs must enforce role, origin and CSRF checks. Reception can eventually see permitted client history; therapists never receive client identity, source contact values or import data. Preview expiry, bounded uploads and safe retry should follow the established client-import conventions. History size/row limits must be explicitly measured and published, not silently inherit an untested unlimited promise. Real source rows must not appear in logs, public fixtures, commits or Linear descriptions.

## Gates and next bounded task

| Gate                                                 | Current state                      | Safe behavior until resolved                                                                              |
| ---------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Current report bytes / exact headers                 | Located; transfer failed twice     | Use prior inspection only as provisional evidence. Retry recovery later; do not claim adapter acceptance. |
| Original client export / identity crosswalk          | Not located in scoped searches     | Preview known Rei candidates; do not attach by name automatically.                                        |
| Export timezone and date syntax                      | Not confirmed                      | Preserve raw local values; block time-dependent confirmation.                                             |
| Meaning of historical New / Confirmed / Started      | Not confirmed                      | Leave completion unknown; do not count worked hours or bonuses.                                           |
| Source reference and service-line uniqueness         | Unique only in the recorded sample | Require full-export verification or collision review.                                                     |
| Historical gross price / payments / requests / rates | Not established                    | Keep unknown; no automatic financial backfill.                                                            |

None of these gates blocks unrelated calendar/client UI work. Do not ask for the same report again while its located copy may be recoverable. Escalate only the small set of facts that cannot be recovered, with the exact affected behavior explained.

**Next backend slice:** a pure, non-writing history normalizer and preview planner using an explicit column mapping and synthetic fixtures. Proposed ownership: `src/history-import-plan.mjs`, `tests/history-import-plan.test.mjs` and this contract. No schema, live appointment writes, routes, reports, email or voucher edits in that slice. It can exercise the safe unresolved states now; final source-adapter acceptance still requires the report bytes. PM must assign implementation ownership before starting it.

Independent tester cases: name twins; shared/contradictory contacts; an existing skipped profile missing a source key; leading-zero IDs; same key/different content; repeated/reordered/overlapping files; multi-service references; explicit versus unknown completion/request; decimal and malformed amounts; textual durations; DST and date/slot conflicts; current-menu edits; missing/deactivated therapist/resource; native-history overlap; role privacy; stale previews; concurrent identity claims; lost confirmation response; atomic rollback. Only synthetic records belong in repository fixtures. This document has no runtime behavior to test; later implementations require the relevant Worker/D1 checks as well as pure planner tests.
