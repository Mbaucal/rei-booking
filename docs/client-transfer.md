# Client transfer (0.9.0)

Owner navigation: **Clients → Import clients** or **Clients → Export CSV**. Reception keeps normal client/profile access; bulk transfer is owner-only at the API boundary. Therapists do not receive client transfer data.

## Import one file

1. Select one UTF-8 CSV up to **25 MiB and 50,000 client rows**. No manual splitting. Comma, semicolon and tab separators are supported, including quoted cells, escaped quotes, a BOM and multiline notes. Up to 40 columns are accepted.
2. Select Fresha, Rei Booking or Other. Use the same source on repeated imports. Other is one source namespace; do not mix IDs from unrelated systems under it.
3. Review column mapping. Map Full name, or First name with optional Last name. Phone, email, **Instagram**, client note and a stable source client ID are optional. Unmapped columns are discarded before upload.
4. Choose **Preview import**. The browser automatically uploads bounded parts, with progress. Keep the page open. If a connection fails, retry Preview import to continue the same upload. No clients are created at this stage.
5. Review the paginated preview. Ready rows start selected across all pages. Rows with only a name, or a name matching an existing client, require an explicit identity check. Invalid, conflicting, duplicate and existing rows cannot be selected. Existing contact matches include the client's name and an **Open** profile action.
6. Tick the confirmation and choose Import. All selected profiles commit together; the receipt reports added and skipped rows. Retrying a lost confirmation response returns the original receipt without duplicate clients.

Phone comparison uses the same normalization as normal entry: a leading 0 uses Serbia (+381); + or 00 retain an explicit country code. Email and Instagram comparison are case-insensitive. Instagram accepts a username, @username or an Instagram profile URL, and stores a normalized username.

Names alone never merge profiles. Shared contacts or source IDs with different details are conflicts, including across separate upload parts of the same file. Identical rows with a shared contact or external ID are deduplicated. Two contactless rows cannot be assumed to be one person and need manual review.

Import creates new profiles. Existing details, notes, photos and appointment history are not overwritten. Correct an existing client through its profile. Stable source IDs are remembered for newly imported clients. Without IDs, a parsed-file/row fingerprint makes repeating that exact file safe, including contactless clients. Reordering or changing a name-only file is not a reliable identity; matching names remain unchecked for review.

Previews are private to their owner and expire after 24 hours. Expired and excess old previews are removed on a subsequent import (up to ten active previews per owner). A client-list change after upload starts invalidates confirmation: read the file again for an up-to-date duplicate check. Applied imports discard staged rows, contact indexes, upload chunks and column configuration, retaining the aggregate receipt and source identity keys. A D1 batch commits the confirmation claim, profiles, Instagram contacts, identity keys and audit entry atomically. Any failure rolls everything back.

The previous small-file API remains for already-open 0.8 pages. Refresh the application to use the new large-file workflow. It requires no manual schema setup.

## Client notes and duplicate warnings

Clients → New client / Edit client includes **Client note** and **Instagram**. Both also appear when adding a new client from Calendar or a new buyer in Sales. Notes remain distinct from appointment notes. Profiles show notes with line breaks and an Instagram profile link. Client search accepts names, phones, email and Instagram.

While entering a phone, email or Instagram, the form checks for matches and displays the existing client's name and contact details. **Open profile** is available in Clients and Sales. **Use this client** selects the existing record in Calendar and Sales. Saving performs the same checks on the server; unique database constraints protect concurrent entries. There is no automatic merge or reassignment of booking history. Clearing an Instagram field releases that handle; saving an older client form without that field preserves it.

## Export

Exports all clients independently of the 100-result search page, up to 50,000 records. The CSV includes Rei client ID, Full name, Phone, Email and Instagram. Notes are excluded unless selected. Photos and appointments are excluded.

Downloads use UTF-8 with BOM and quoted CSV cells. Formula-like cells receive a leading apostrophe. Importing a recognized Rei Booking export reverses this escaping, preserving plus-prefixed phones and literal notes. Export does not change records. The 25 MiB file-size limit still applies on reimport.

## Deployment and validation

The additive schemas initialize automatically. `0009_client_contacts.sql` and `0010_large_client_import.sql` are the tracked equivalents and can be applied safely after initialization. Existing client IDs and appointment links are preserved.

Tests run the real Worker and D1 with fictional data. Coverage includes a **12,001-row CSV larger than 1 MiB through the actual browser upload helper**, a lost upload response and resume, concurrent confirmation, cross-part duplicates, named contact conflicts, stale previews, atomic rollback, export roundtrip, profile edits, Calendar/Sales entry, role restrictions, persistence after restart and migration parity. The parser is shared with the browser and tested at the 50,000-row boundary. Hosted visual/touch acceptance and a real salon CSV import remain pending.

Appointment-history migration is separate; source identity, timezone and status mapping still need agreement. Loyalty rules are undecided. Email setup and remaining voucher work stay deferred at the owner's request.
