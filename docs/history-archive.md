# Confirmed appointment history

Release 0.15.0 (MBA-201) added a permanent archive after the CSV preview and explicit client matching. Release 0.16.0 (MBA-202) adds one confirmation for a complete report with durable progress. The archive is separate from live calendar appointments, slots, treatment reports and bonuses. No import occurs merely by uploading a report, preparing a review or matching a client.

## Owner workflow

1. Open **Clients → Import history**, read the report and check the suggested columns and formats. The optional Fresha `Resource` header is recognized. Its `No resource` value is preserved in the original evidence but does not become a named room.
2. Review the source rows and save explicit matches to existing clients. A suggested name is not a permanent identity link. Import does not create or merge clients.
3. Choose **Review full report**. The application checks every source row automatically and shows full-report importable, duplicate and blocked counts, original statuses and paginated issues. Row checkboxes are for client matching, not import size.
4. Resolve unmatched or conflicting rows before confirming. Acknowledge the completed review and confirm once. Exact duplicates are skipped. The application processes the approved report in bounded steps with persistent progress; there are no repeated confirmations per processing step.
5. Open the client's profile to see permanent **Imported history**, original-status counts and paginated source visits. Current Rei bookings remain separately labelled.

The one-file limit remains 50,000 rows / 25 MiB. No manual file splitting is needed. The UI continues to page source rows and client choices for readability, but the import confirmation covers the whole report. Client matches remain explicit; this change does not infer identity from a name alone.

Keep the import screen open while it is processing. Pause, navigation or closing the browser stops further requests after any request already in flight; completed steps are retained. Reopen the saved import and resume without confirming each step again. Progress is stored on the server, not in browser storage. This is resumable foreground processing, not a job that continues after the browser is closed.

Each step commits its archive rows, receipt and progress atomically. The complete report is not one giant transaction: if a later step stops, prior completed steps remain imported and are shown in the counters. Changed underlying clients, source identity links, native bookings or archive state stop stale processing for a fresh review. A new review skips records already imported by the earlier attempt. Confirmed jobs retain their frozen source evidence after temporary preview deletion or expiry.

## Preserved status and unknown fields

Original status text is retained, including `Cancelled`, `No Show`, `New`, `Confirmed` and `Started`. Counts cover the entire client's imported archive, not just the current page. An absent status is labelled unknown. Cancelled and No Show remain non-completed. New, Confirmed and Started remain of unknown completion in this archive release, even when the preview contains a supplied completion mapping; their operational meaning has not been established for this source.

A known local date/time can be archived while the source timezone is unconfirmed; its instant remains unknown. Currency, payment, full price, requested flags and bonus evidence are not invented. Missing optional facts are shown as warnings/unknowns and do not erase the visit. Invalid dates/durations, contradictory source evidence, ambiguous identities and source references are blocked. This release does not backfill financial reports or bonus totals.

## Duplicate protection

Duplicate identity uses the stable source namespace and appointment reference, not the filename, file digest or CSV row position. Keep the same source namespace when importing more reports from the same salon/system.

- An exact reference, evidence and selected client already in the archive is a duplicate, including renamed, reordered and overlapping exports.
- Changed status, content, interpretation or client for an existing reference is a conflict; no silent overwrite or second visit is created. Corrections need a later separately reviewed workflow.
- Default unverified references conservatively reserve one appointment per reference with explicit acknowledgement. This does not establish that every Fresha reference is globally unique. Differing rows sharing a reference elsewhere in the full file are blocked, even outside the selected batch.
- Service-line mode requires an explicit line ID. A reference cannot switch between appointment and service-line scope to bypass deduplication. Missing or ambiguous references cannot be imported.
- Possible overlaps with existing live bookings for the chosen client are blocked. This slice does not merge or overwrite native appointments.

Database uniqueness and atomic confirmation protect concurrent imports. Reviews bind the selected rows, preview version, current client state and archive state. Confirmation checks for native overlaps again in the same transaction. Stale reviews require another review. Exact retries return the stored receipt, including after the original preview expires or is discarded; changing the payload under the same request ID is rejected.

## Full-report API and storage

| Operation | Route |
| --- | --- |
| Start a whole-report review / list saved jobs | `POST /api/history/jobs` / `GET /api/history/jobs` |
| Read progress and a page of reviewed rows | `GET /api/history/jobs/:id?page=0&filter=all` |
| Prepare or import the next bounded step | `POST /api/history/jobs/:id/step` |
| Confirm the completed whole-report review once | `POST /api/history/jobs/:id/confirm` |
| Stop remaining work, retaining completed records | `POST /api/history/jobs/:id/cancel` |

Start accepts `{previewId, version, requestId}`. Mutations accept `{version, requestId}`; confirmation also requires the matching `confirmationToken` and `acknowledgeReview: true`. Jobs move through `reviewing → ready → importing → completed`. A stale snapshot becomes `paused` and requires a new review; explicit stop becomes `cancelled`. UI Pause simply stops issuing step requests and permits continuation of the same job.

Review pages offer a page-number jump and **Needs attention** (`filter=blocked`) to locate unresolved rows anywhere in the report. Summary counts still cover the whole file. The bounded saved-job list prioritizes unfinished, unexpired jobs over old outcomes and expired reviews.

The server chooses the next rows; clients cannot expand the approved report by submitting a new selection. Mutation request IDs bind the operation and payload. An exact retry returns current saved progress without repeating work, while changed payloads under that ID reject. Frozen rows, source keys and counters live in separate tables so a 50,000-row job never becomes a single large JSON database value. The additive job schema is mirrored in `migrations/0014_history_bulk.sql`.

## Original bounded API and storage

| Operation                                  | Route                                 |
| ------------------------------------------ | ------------------------------------- |
| Review selected rows                       | `POST /api/history/imports/review`    |
| Explicit confirmation / exact retry        | `POST /api/history/imports/confirm`   |
| Paginated client archive and status counts | `GET /api/clients/:id/history?page=0` |

The original bounded API remains compatible: review body `{previewId, version, rows, requestId}`, with 1–50 distinct CSV row numbers. Confirmation adds `confirmationToken` and `acknowledgeReview: true`. Its review expires after 15 minutes or at preview expiry, whichever comes first. These request limits no longer define the user-facing full-report confirmation limit. Archive/receipt records have no preview foreign-key cascade and survive the preview's 24-hour access window. The archive schema is additive and mirrored in `migrations/0013_history_archive.sql`.

All routes retain existing authentication, origin, CSRF and required-password-change gates. Review/confirm are owner-only. Client archive pages contain 25 rows. Reception receives an explicit operational projection; original source payload/provenance and financial evidence are owner-only. Therapists cannot read client history. No email or real salon import is performed by automated tests.
