# Appointment history preview

Release 0.14.0 (MBA-197 / MBA-198 / MBA-199 / MBA-200) connects the pure MBA-194 / MBA-195 / MBA-196 foundation to an owner-only **Clients → Preview history** screen and temporary D1 review storage. It implements the preview step of the [history import contract](history-import-contract.md). It does not create archived visits, permanent client/source links, live appointments, profile history, financial totals or bonuses. All automated fixtures are fictional.

## Owner workflow and runtime boundary

Read an appointment CSV, confirm column mappings and the source formats that are actually known, then choose **Prepare preview**. Familiar Fresha headers suggest mappings but do not confirm currency, timezone, completed status or reference uniqueness. Review 50 rows per page, inspect original and parsed values, search named client profiles and explicitly save draft choices for selected rows. A name alone is never an automatic identity link. Clearing a draft match does not edit a client.

The screen hashes the original file in the browser. The server records that digest as claimed original-file provenance and independently verifies canonical upload chunks; it does not claim to have received the original bytes. Ready previews reopen without the file. Interrupted uploads require the same original file/configuration. Versioned choices use stable request IDs so a lost acknowledgement can be retried. Client changes require rebuilding the candidate index and reviewing stale choices.

All `/api/history/previews` routes are owner-only, with the existing authentication, required-password-change, origin and CSRF gates. Every job lookup is scoped to its owner. Responses use no-store headers. Additive schema initialization and `migrations/0012_history_previews.sql` create temporary preview, row, chunk, source-key, client-index and decision tables. Contact/source-link mutations advance the existing client revision so previews cannot silently keep stale identity evidence.

| Operation                            | Route / behavior                                                     |
| ------------------------------------ | -------------------------------------------------------------------- |
| Recent drafts                        | `GET /api/history/previews`                                          |
| Start / exact retry                  | `POST /api/history/previews/start`                                   |
| Upload ordered parts                 | `POST /api/history/previews/:id/upload`                              |
| Build full candidate index           | `POST /api/history/previews/:id/finalize`, repeat until ready        |
| Metadata / review page               | `GET /api/history/previews/:id` / `:id/page?page=0`                  |
| Search candidate profiles            | `GET /api/history/previews/:id/clients?q=…&page=0`                   |
| Save or clear explicit draft matches | `POST /api/history/previews/:id/choices` with version and request ID |
| Discard                              | `DELETE /api/history/previews/:id` with version                      |

Limits: 50,000 rows, 25 MiB raw file and decoded aggregate, 128 columns, 16 KiB per UTF-8 cell, 100 rows and 2 MiB JSON per upload. A packed normalized D1 value is additionally bounded below 2 MB; the UI reduces an oversized part and retries. Indexing advances in steps of 1,000 clients, up to 100,000 clients. Each 50-row review page permits at most 1,000 candidate profiles, 2,000 native appointment candidates and 4 MiB of evidence; excessive ambiguity fails explicitly without dropping candidates. Global structural counts are separate from page-only matching/eligibility counts.

Up to three recent previews are retained per owner. Access expires after 24 hours. Expired rows are physically cleaned up on the next preview start, not by a timed purge. Explicit discard removes the preview. Draft choices and possible native appointment overlaps are review evidence, not authority to import or merge.

## Normalize mapped rows

`normalizeHistoryRows` in `src/history-normalize.mjs` accepts an object with `headers`, `rows`, `mapping`, `source`, `fileDigest` and `format`. Headers and cells are strings; rows have the same width as the headers. The caller supplies a SHA-256 digest of the original file and a stable salon/source namespace. CSV decoding itself belongs to the caller.

`mapping` uses distinct zero-based column indexes, or null for unmapped fields. Supported keys are `appointmentRef`, `serviceLineRef`, `clientSourceId`, `clientName`, `phone`, `email`, `instagram`, `therapistName`, `serviceName`, `scheduledDate`, `slot`, `duration`, `createdAt`, `cancelledAt`, `status`, `netSales`, `requested` and `roomName`.

| Format option    | Accepted interpretation                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dateTimeFormat` | `fresha-en` (English abbreviated month and 12-hour clock), `iso-local` (date and minute), `iso-date`, `dmy-date` or `mdy-date` (slash dates) |
| `slotFormat`     | `HH:mm:ss-HH:mm:ss` (seconds must be zero), `HH:mm-HH:mm` or `HH:mm`                                                                         |
| `durationFormat` | `hours-minutes` or integer `minutes`                                                                                                         |
| `money`          | Explicit `currency`, `minorUnitDigits` (0–4), `decimalSeparator` (`.` or `,`) and `groupSeparator` (null, `.`, `,` or space)                 |
| `sourceTimeZone` | Confirmed IANA zone, or null when unconfirmed                                                                                                |
| `completionMap`  | Exact source labels mapped to `completed`, `not_completed` or `unknown`                                                                      |
| `requestMap`     | Exact source labels mapped to `yes`, `no` or `unknown`                                                                                       |

Do not infer an export timezone or currency from current application settings. Without confirmed currency/precision, the amount remains null. Without a timezone, a local date/time may be known but its instant remains null. Ambiguous or nonexistent DST times require review. Decimal money is parsed into safe integer minor units without rounding.

The result is `{ rows, summary }`. Each row retains mapped `raw` cells, source labels/IDs, source row number, file digest, parsed local schedule, nullable timestamps, source net sales and issue diagnostics. Historical full price, paid amount, bonus rule and bonus amount remain null. `completionBasis`, `requestBasis` and `interpretation` preserve the supplied interpretation decisions; they do not claim owner approval. Unknown completion and request values remain distinct from an explicit negative answer.

`Cancelled` and `No Show` default to `not_completed`. Other statuses, including `New`, `Confirmed` and `Started`, remain unknown unless explicitly mapped. Unknown completion/request and missing or currency-unconfirmed net sales are informational diagnostics: they suppress only the corresponding metric, not an otherwise verified historical visit. Contradictory cancellation/completion evidence still requires review. Invalid input shape/configuration throws a generic error; malformed cell values become row-level issues. Issue severities are `info`, `review` and `error`; the planner also adds `conflict`.

Limits: 50,000 data rows, 128 columns, 16 KiB per UTF-8 cell and 25 MiB of decoded cell content including separators. The upload boundary separately enforces raw-file and chunk limits and parses CSV safely. Same-day schedules may end at 24:00; cross-midnight schedules need later explicit support. No current treatment menu, prices or five-minute booking grid is imposed on historical values.

## Plan identities and repeat protection

`planHistoryImport` in `src/history-import-plan.mjs` accepts normalized `rows` and supplied JSON snapshots:

| Input                | Shape                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| `clients`            | `{ id, name, phone?, email?, instagram?, version? }`                               |
| `sourceLinks`        | `{ source, source_key, client_id }` or `{ source, sourceKey, clientId }`           |
| `existingHistory`    | `{ id, source, sourceKey, payloadDigest }` for previously accepted archive records |
| `nativeAppointments` | `{ id, clientId?, clientName?, date, start, duration }`, with minute values        |
| `referenceMode`      | `unverified` (default), `verified-appointment` or `service-line`                   |

Source-ID links use the existing `id:` plus SHA-256 of the trimmed external ID convention. Leading zeros and source namespaces remain significant. File-row import keys are not person identities. Contradictory contacts, missing linked profiles or multiple links are conflicts. Compatible contact matches are only proposals; name matches always require a person to choose. No clients are created or merged.

Verified appointment references use stable reference keys. Service-line mode additionally requires a line reference. Unverified or missing references use file digest plus row position and protect only exact-file retries. The caller must not select verified mode solely because references happen to be unique in one sample. Same key plus unchanged payload is a duplicate; changed content conflicts every matching input row. Payload fingerprints retain interpretation evidence but exclude file position and diagnostic text, so reordered verified references remain detectable. Potential native appointment overlaps require explicit review.

The result is `{ rows, summary }`. Each preview row includes `record`, `sourceKey`, `keyScope`, `payloadDigest`, `identity`, `disposition`, `issues`, `duplicateOf`, `nativeOverlapIds` and `eligibility`. Dispositions are `ready`, `unresolved`, `conflict`, `duplicate` and `invalid`. Every row starts with `selected: false`; `ready` means validation readiness only and never authorizes a write. Eligibility fields and summary values are counts, not financial totals. Bonus eligibility is always false in this slice.

Bounds: 50,000 normalized rows, 100,000 entries per reference snapshot and 1,000,000 combined identity/native candidate visits. Excessive ambiguity fails explicitly instead of truncating results. Both modules preserve caller inputs and perform no database, network, clock or filesystem operations.

## Next integration boundary

The next slice is a separately reviewed archive confirmation path. It must revalidate current client versions/links, enforce atomic repeat protection, and record approvals. Unknown values need visible labels. The pure planner is not a security or persistence boundary. Confirmed archive history and its profile display remain separate from live appointments and reports.

Run focused checks with `node --test tests/history-*.test.mjs`. The existing full `npm run check`, `npm test` and build/browser CI gates still apply when merging.
