# Optional Google Sheets report snapshots

Rei Booking remains the source of truth. This integration copies aggregate performance reports into new tabs in a spreadsheet you choose. Your existing spreadsheet, tabs, formulas and old records are never edited or deleted by the sync. No Google connection, access credential or scheduled trigger is created automatically by Rei.

The downloadable template is [`public/rei-reports-sync.gs`](../public/rei-reports-sync.gs), served at `/rei-reports-sync.gs`. It uses the [versioned reporting API](report-api.md) and contains no credential. All application labels and exported headings are in English.

## Set up once

1. As the owner, open **Reports → Google Sheets / API** in Rei. Create a dedicated `reports:read` credential. Save the value shown once; it can read financial report aggregates but cannot change bookings or access client records.
2. Create a private Apps Script project at [script.google.com](https://script.google.com/) using the Google account that owns, or can edit, your destination spreadsheet. Paste the downloaded template into the script editor. Keep the V8 runtime enabled.
3. Open **Project Settings → Script Properties** and add the four properties below. Keep the credential in Script Properties, never in code or sheet cells.
4. Select `reiSyncReports` in the editor and click **Run**. Google will ask you to authorize this script to fetch the Rei API and write to the chosen spreadsheet. Review and approve with the intended Google account. No email sending permission is needed.
5. Check the new `Rei …` snapshot tabs against the same report period in the application. Existing tabs should be unchanged. The execution result reports created and unchanged periods without including the credential.
6. Only after a successful manual run, optionally run `reiInstallDailySync`. Google may ask for permission to manage script triggers. This enables one daily run around **09:00 Europe/Belgrade**. Google time triggers are approximate, including the requested minute's ±15-minute window.

| Script Property      | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| `REI_API_BASE`       | `https://rei-booking.mbaucal.workers.dev/api`                       |
| `REI_API_TOKEN`      | Your private `reports:read` credential from Rei                     |
| `REI_SPREADSHEET_ID` | The ID between `/d/` and `/edit` in the destination spreadsheet URL |
| `REI_START_DATE`     | First report date, for example `2024-01-01`                         |

The initial template accepts only the Rei application address shown above. If the application later moves to your custom domain, first verify that domain serves your Rei application, then explicitly update the script's `REI_SYNC.allowedBases` list and `REI_API_BASE`. HTTPS is required; authenticated redirects are never followed. Do not add arbitrary hosts or paste a URL containing a credential, query string or fragment.

Script Properties are private from sheet cells but available to people who can edit the Apps Script project. Keep this project private to the owner. Using a private standalone project lets you write to an existing workbook without giving every workbook editor access to the credential. The report tabs themselves contain financial totals, so choose the destination workbook's sharing accordingly.

## What each run creates

The sync requests **all sources**, grouped by **therapist**, with all statuses, all requested states, averages per **active day**, and native Rei bonuses included. The period runs from `REI_START_DATE` through **yesterday in Belgrade**; today's unfinished data is excluded.

For a multi-year start date, the script splits the period at calendar-year boundaries. For example, a start of `2024-05-01` produces independent reports for the remainder of 2024, 2025, and 2026 through yesterday. Each API request covers at most 366 days. No repeated monthly edits are needed. The maximum is eleven calendar-year windows per run.

Each new snapshot includes:

- Therapist totals, a separate overall total, and the preceding equal-length comparison period.
- Massage hours, requested hours, cancellations, no-shows, native revenue and bonuses as numeric values. RSD amounts use dinars, not cents.
- Imported visit/treatment counts and imported hours. Missing evidence remains visible through unavailable/unknown counters; unknown amounts remain blank.
- Imported **source net sales**, split by their original currency, in a separate table. They are not added to native Rei revenue or used to infer imported bonuses.
- The report's generation time, source coverage dates, loaded row counts and source revisions. Coverage describes records currently present in Rei; it does not certify that every old Fresha report has been imported.

Snapshot tabs are **alternative views**, not new transactions. Do not add multiple snapshots together, add the `TOTAL` row to therapist rows, or add the previous period to the current period. Imported unique visit counts can overlap between therapists, so use the API's overall total. Separate calendar-year tabs do not calculate a combined average or a combined unique-visit count.

The same validated report values are written only once: an unchanged retry reuses its existing snapshot tab even when its generation timestamp or source revision has changed. Changed values create a new dated tab; old snapshots remain intact. The current year changes as the reporting end date advances, so daily snapshots accumulate. The script never prunes or rewrites them. You may archive unwanted snapshots manually.

## Automatic runs and configuration changes

| Function              | Action                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| `reiSyncReports`      | Manual sync and verification of the current settings                              |
| `reiInstallDailySync` | Install or deduplicate this project's daily Rei sync trigger                      |
| `reiScheduledSync`    | Trigger handler; requires an earlier successful manual run with the same settings |
| `reiRemoveDailySync`  | Remove only triggers whose handler is `reiScheduledSync`                          |

Changing the API address, credential, spreadsheet ID or start date invalidates the saved manual-success proof. Run `reiSyncReports` again before installing or resuming automatic sync. Rotating or revoking a Rei credential immediately affects subsequent API calls; replace a rotated credential in Script Properties and run the manual sync again.

Installable triggers belong to the Google account that creates them. Use one owner account to install and remove this integration's trigger. The script preserves unrelated handler functions and does not manage another Google account's triggers.

## Failures and limits

Every response is validated before the destination workbook is opened for writing: schema version, dates, timezone, filters, completeness, group dimensions, finite bounded numeric values and source coverage must match. Demo, paginated, truncated or mismatched responses are rejected. The script does not write a partial set of fetched calendar years.

Work is bounded to 5,000 therapist groups per response, 4 million response characters per period, 12 million response characters across periods and 500,000 new snapshot cells per run. The API has its own explicit source-row limits. An oversized report fails with guidance to choose a later start date; it is never silently truncated. Ordinary salon therapist summaries are much smaller.

A script lock prevents concurrent manual and scheduled runs. A caught write failure removes only tabs created by that invocation and preserves every pre-existing tab. If Google terminates an execution abruptly, or cleanup cannot complete, inspect any new incomplete `Rei …` tabs before retrying. A completed snapshot has a private report fingerprint in its tab metadata; the fingerprint is not an API credential.

An HTTP 401 usually means the credential expired, was revoked or the issuing owner's access changed. Create or rotate access in Rei, update Script Properties and manually sync. An HTTP 429 requires waiting before retrying. Redirects and other HTTP errors stop the sync. Error messages do not expose API response bodies, credentials or request headers.

## Verification

`node --test tests/reports-apps-script.test.mjs` runs the actual downloaded script in a Node VM with mocked Google services. It covers transport restrictions, config-bound trigger setup, year/leap-day/Belgrade ranges, rejected partial data, numeric and unknown values, formula-safe labels, snapshot retry behavior, size limits and cleanup without modifying old tabs. These tests do not connect a real Google account, write a real workbook or install live triggers. A manual Google-authorized run remains the final connection check.

Google references: [Script Properties](https://developers.google.com/apps-script/guides/properties), [UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app), [LockService](https://developers.google.com/apps-script/reference/lock/lock-service), [Spreadsheet](https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet), [Sheet metadata](https://developers.google.com/apps-script/reference/spreadsheet/sheet), and [clock triggers](https://developers.google.com/apps-script/reference/script/clock-trigger-builder).
