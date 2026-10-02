# Confirmed appointment history

Release 0.15.0 (MBA-201) adds a permanent archive after the existing CSV preview and explicit client matching. The archive is separate from live calendar appointments, slots, treatment reports and bonuses. No import occurs merely by uploading a report or matching a client.

## Owner workflow

1. Open **Clients → Import history**, read the report and check the suggested columns and formats. The optional Fresha `Resource` header is recognized. Its `No resource` value is preserved in the original evidence but does not become a named room.
2. Review the source rows and save explicit matches to existing clients. A suggested name is not a permanent identity link. Import does not create or merge clients.
3. Select up to 50 rows and choose **Review import**. Inspect importable, duplicate and blocked counts, source statuses, selected clients and warnings.
4. Acknowledge the review and choose **Confirm import**. Any blocked selected row prevents the entire batch; deselect or correct it and review again. Exact duplicates are skipped, with the counts shown in the receipt.
5. Open the client's profile to see permanent **Imported history**, original-status counts and paginated source visits. Current Rei bookings remain separately labelled.

The one-file limit remains 50,000 rows / 25 MiB. Uploading does not require splitting the file. Confirmation is deliberately bounded to 50 reviewed rows per batch; a larger bulk-matching/confirmation workflow is not part of this release.

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

## API and storage

| Operation                                  | Route                                 |
| ------------------------------------------ | ------------------------------------- |
| Review selected rows                       | `POST /api/history/imports/review`    |
| Explicit confirmation / exact retry        | `POST /api/history/imports/confirm`   |
| Paginated client archive and status counts | `GET /api/clients/:id/history?page=0` |

Review body: `{previewId, version, rows, requestId}`, with 1–50 distinct CSV row numbers. Confirmation adds `confirmationToken` and `acknowledgeReview: true`. A review expires after 15 minutes or at preview expiry, whichever comes first. Archive/receipt records have no preview foreign-key cascade and survive the preview's 24-hour access window. The archive schema is additive and mirrored in `migrations/0013_history_archive.sql`.

All routes retain existing authentication, origin, CSRF and required-password-change gates. Review/confirm are owner-only. Client archive pages contain 25 rows. Reception receives an explicit operational projection; original source payload/provenance and financial evidence are owner-only. Therapists cannot read client history. No email or real salon import is performed by automated tests.
