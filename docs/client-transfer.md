# Client transfer (0.8.0)

Owner navigation: **Clients → Import clients** or **Clients → Export CSV**. Reception keeps its normal client/profile access; bulk transfer is owner-only at the API boundary. Therapists do not receive client transfer data.

## Import

1. Select a UTF-8 CSV (up to 1 MiB and 1,000 client rows). Comma, semicolon and tab separators are supported, including quoted cells, escaped quotes, a BOM and multiline notes.
2. Select Fresha, Rei Booking or Other. Use the same source on repeated imports. Other is a single source namespace; do not mix external IDs from unrelated systems under it.
3. Review the proposed column mapping. Map Full name, or First name with optional Last name. Phone, email, client note and a stable source client ID are optional. Duplicate headers are distinguished by their column number. Unmapped columns are discarded.
4. Preview normalized records. Nothing is added to the client list during preview. Ready rows start selected; name matches or rows without phone/email need an explicit identity check. Invalid/conflicting/duplicate/existing rows cannot be selected.
5. Review the selection across all preview pages, tick the confirmation and click Import. A receipt reports added and skipped rows. Fix skipped conflicts in the source file and prepare a new preview if needed.

Phone comparison uses the same normalization as normal client entry: a leading 0 uses Serbia (+381), and + or 00 retain an explicit country code. Email comparison is case-insensitive. Names alone never merge profiles. Shared phones/emails with different details are conflicts, including within one file. Identical rows with a shared contact or external ID are deduplicated. Two name-only rows cannot be assumed to represent the same person and require manual review.

Import creates new profiles; it does not edit existing profiles, merge contacts, upload portraits or infer visit history. Matching an existing profile leaves its name, contacts, notes and photos unchanged. Review/correct an existing client through its profile.

Stable source IDs are remembered for newly imported clients. Without IDs, an exact parsed-file/row fingerprint makes repeating that file safe, including contactless clients. Altering/reordering a name-only file does not create a trustworthy identity: its matching names remain unchecked for manual review. Existing skipped profiles are not silently linked to external IDs.

Previews are private to the owner who prepared them, expire after one hour, and store only mapped values. Expired previews and excess old previews are removed when preparing a subsequent preview (up to ten active previews per owner). Applied previews discard their mapped plan, retaining an aggregate receipt and source identity keys linked to that import. A preview is invalidated by any intervening change to the client list. The confirmation claim, new profiles, identity keys and aggregate audit entry commit in one D1 batch; any write failure rolls all of them back. Retrying the same confirmation returns its original receipt. Changing the selection after a successful confirmation requires a new preview.

This release supports up to 10,000 clients in total and 40 columns per input file. It rejects overflow rather than truncating imports. Split larger CSVs into files with a repeated header, retaining stable source IDs. No undo/delete-import feature is included; review before confirming.

## Export

Exports all clients, independent of the current 100-result search page, up to 10,000 records. The CSV includes Rei client ID, Full name, Phone and Email. Notes are excluded unless explicitly selected. Photos and appointments are excluded.

The download uses UTF-8 with BOM and quoted CSV cells. Spreadsheet formula-like cells receive a leading apostrophe. Selecting a recognized **Rei Booking** export on import reverses this escaping, preserving plus-prefixed phone numbers and literal notes. Exports above the 1,000-row import limit must be split before reimport. Export does not change records.

## Deployment and acceptance

The additive schema initializes on the first owner import action. `migrations/0008_client_transfer.sql` is the tracked equivalent; it is safe to apply after initialization. No manual console setup or credentials are needed for this feature.

83 local tests and the deployment dry run pass. The actual Worker/D1 tests cover permissions/CSRF, CSV/mapping validation, normalization, duplicate and conflict handling, stale previews, repeated and concurrent confirmations, rollback, export escaping, a 1,000-row batch, persistence after restart and schema/migration parity. Data is fictional. Local browser execution was unavailable because the runtime has no Chromium executable; hosted visual/touch acceptance remains pending.

A real Fresha client CSV still needs its columns checked before importing salon data. Appointment-history migration is separate: the supplied historical appointment sample does not contain client contact IDs, requested flags or an explicit completed status. Timezone and status mapping must be agreed before that import. Loyalty rules remain undecided; email setup and remaining voucher work are deferred at the owner's request.
