# Monthly reports

Release 0.7 adds owner-only schedules and a permanent CSV archive under **Reports → Monthly reports**. Live reports and Dashboard comparisons remain available. A saved monthly report contains appointment performance and bonuses; voucher sales remain a separate sales metric.

## Create a schedule

Choose **New monthly schedule**, or **Save filters as monthly schedule** from a live report. Select the therapist, treatment, appointment status, requested flag, grouping, daily-average denominator and whether to include bonus columns. Name the report and choose a time on the first day of the month. The default is **09:00 Europe/Belgrade**, adjustable in 15-minute steps.

The first automatic report covers the current calendar month and is due on the first of the next month. **Save a month now** can save the previous completed month immediately. For example, a schedule created in September can save August now; its first automatic report covers September and is due on 1 October. Future and unfinished months cannot be archived.

Cloudflare runs the scheduler every 15 minutes, independently of whether the application is open. It converts the salon's local schedule to UTC, including daylight saving changes. Execution and email arrival can be later than the selected time. A run handles at most six missing report periods and six queued email jobs; later runs continue any backlog.

**Pause** stops automatic generation and unclaimed report notifications. **Resume** catches up on missed months using the templates that applied to those months. Filter changes create a new template version effective from the current month. Earlier report definitions and previously saved results remain intact. At most 20 schedules per owner are supported; edit or pause an existing schedule when appropriate.

## Saved results and corrections

The archive includes the period, report/template version, generation time, source-data cutoff, audit watermark, definition version and delivery state. Each saved report retains its calculation inputs, comparison with the previous complete calendar month, and exact **Summary**, **Appointment list** and **Comparison CSV** files. CSV exports contain no client identity and escape spreadsheet formula cells.

Revenue, hours and bonuses use completed massages. Pending appointments produce a visible review warning. Missing required calculation inputs produce an incomplete report with no invented financial totals. An empty month is a valid zero-activity report. Grouping and rounding use the same definitions as [live reporting](reports.md).

After correcting source bookings, open the latest report and choose **Create corrected version**, with a reason. This recalculates using the same saved filters and current source records. Both versions remain available. An interrupted request can be retried without creating another version. Saving the same original month again opens the original result; use the archive to choose a corrected version.

Saved reports deliberately exclude client names, IDs, contacts, notes and portraits. Only the owning active owner account can access the schedule, saved report or CSV; a link does not grant access. Reception and therapist roles cannot access these routes.

This release limits a saved report to 5,000 source appointments across its report and comparison months, and a combined serialized archive payload of 1.7 MB. An oversized report fails visibly without saving partial results; narrow its filters. Failed scheduled generation retains the pending month and retries later.

## Email notifications

Archive generation works while email is disabled. Complete [sender and webhook setup](email-setup.md) before enabling delivery. No real email was sent during development and `EMAIL_ENABLED` remains `false` in source.

In **Monthly reports → Email notifications**, request a verification code at the desired address and enter it in the app. The code expires after 20 minutes; at most five attempts and three verification emails per owner per hour are allowed, with at least one minute between requests. An address must be verified before it can be selected in a schedule. Verification does not create an application login or grant report access.

Then edit a schedule, select the verified destination and check **Email me when ready**. Messages come from **info@reithailandmassage.com** and contain the report name, month and sign-in link. They contain no report amounts, client information or CSV attachments. Enabling notifications does not retroactively email older archived versions.

Each saved version has one persistent notification job. Concurrent or interrupted attempts reuse the same payload and provider idempotency key. **Accepted by email provider** does not mean **Delivered**; only a verified delivery callback establishes delivery. Signed callbacks also record delay, failure, bounce and complaint. Bounced/complaining addresses are suppressed across report and voucher email.

Transient failures retry with backoff. **Retry notification** retries the existing eligible job, never silently creates another. An uncertain send stops retrying after 23 hours from its first attempt, before provider deduplication expires. Check Resend before arranging a fresh delivery; this release does not offer a blind resend for uncertain/permanent failures. Pausing, disabling notifications, changing the recipient or disabling the owning account cancels unclaimed jobs. A message already accepted externally cannot be recalled. Cancelled notifications are not requeued by resuming a schedule.

## Acceptance

Create an archive-only schedule, save last month, inspect all three CSV exports, change a source booking and save a corrected version. Check that the original values remain intact and that another role cannot open the saved link. Confirm the UI on laptop, tablet and phone. After sender setup, use an explicitly approved recipient for the first real verification and report notification and confirm signed delivery status. Hosted scheduled execution and actual delivery still require this operational acceptance.
