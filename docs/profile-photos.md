# Private profile photos — release 0.6

## Where to use it

- **Clients → Profile → Upload / change photo**: select an image, review the preview, then **Save photo**. **Remove** stages removal and **Undo** restores the previous selection. Closing without saving discards the draft.
- **Clients → New/Edit client** also accepts a staged photo, saved with the validated client fields.
- **Team → Add/Edit team member → Upload photo** stages the image alongside the team form. **Save team member** commits profile, bonus changes and photo together. Failed validation or a conflicting photo/profile version leaves all those fields unchanged.
- Client portraits appear in the client list, profile and authorized booking editor. Team portraits appear in team cards and calendar column headers. Initials are the fallback when no image is available.

JPG, PNG and WebP originals up to 10 MB / 40 megapixels are accepted by the browser. It checks signature and declared type, decodes with image orientation, flattens transparency onto white, preserves proportions and converts to a JPEG at most 512 pixels per side. Circular avatars crop only their display. Broken/unsupported images do not overwrite the saved photo. HEIC, SVG and animated-image workflows are not supported; export a JPG/PNG/WebP first.

## Access and storage

Client images are readable and editable by owner/reception only. Therapists cannot access client image bytes, metadata, profile or list endpoints, including through a copied image URL. Authenticated team members may view team portraits; only the owner edits them. Existing calendar/report/voucher projections do not gain client photographs or identifying photo URLs. Account/session revocation applies to image routes as it does to the application.

The server accepts only the browser's bounded JPEG output, independently decodes it under pixel/memory limits, checks dimensions and re-encodes decoded pixels. Original filenames, EXIF/GPS data, comments and original full-size files are not stored. JPEG processing uses pinned `jpeg-js` 0.4.4 bundled as an ESM module for the Worker; see `scripts/build-photo-codec.mjs` and its committed license.

The processed portrait is a private D1 BLOB, capped at 150 KiB per profile, in the existing dedicated booking database. There is one current image per profile. Replacement overwrites its bytes; removal clears them and retains only a revision marker plus an audit event. Audit records contain actor, time, action, dimensions and revision, never image bytes. Normal database backups/time-travel may still retain older database versions according to the operator's retention policy.

Each request authenticates and checks role before returning image bytes. Responses are JPEG, nosniff, no-store and same-origin; there are no public object URLs, base64 images in client/catalogue JSON or image bytes in report/CSV exports. Image revisions prevent concurrent edits from silently overwriting one another, including removal/re-upload races. Form writes and photo writes are atomic. Clients must reopen a profile after a version conflict.

This bounded storage choice needs no additional Cloudflare resources for the current small salon. Image storage consumes D1 capacity; review database growth and move to private object storage if volume grows materially. No original photo archive or bulk-photo import is provided.

## Verification and acceptance

Worker/D1 tests use generated fictional image pixels. They cover actual image encoding/decoding and metadata removal, preserved dimensions, invalid/oversized input, role/origin/CSRF guards, unchanged therapist calendar privacy, atomic form rollback, concurrent updates, revision-preserving removal and persistence across a Worker restart. Frontend draft tests cover late processing after profile/session change, undo/removal and overlapping selections. Canvas/orientation calls are tested with a mock; they do not replace real device acceptance.

After deployment, use fictional profiles to verify camera/file selection on desktop, tablet and phone; orientation and crop display; Save/Cancel/Undo/Remove; reload and sign-in; and visibility from owner/reception/therapist accounts. Check processing responsiveness on the actual Worker CPU plan. Hosted visual, real-camera and touch acceptance remain pending. No real client/team photograph was uploaded during development.
