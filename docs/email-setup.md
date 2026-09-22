# Voucher email setup

The delivery implementation is prepared, but **sending is disabled**. The connected Resend account was inspected on 22 September 2026: `reithailandmassage.com` exists in region `eu-west-1`, with domain status `not_started`. No DNS records or provider account settings were changed during implementation, and no messages were sent.

## Sender domain

Open [the Resend domain](https://resend.com/domains/6175dff6-a511-4057-bc18-a4c1f958d0f2). In the DNS zone for `reithailandmassage.com`, add the exact records from that page. At inspection these were:

| Type | Name                | Value                                          | Priority |
| ---- | ------------------- | ---------------------------------------------- | -------- |
| TXT  | `resend._domainkey` | Copy the complete DKIM `p=…` value from Resend | —        |
| MX   | `send`              | `feedback-smtp.eu-west-1.amazonses.com`        | 10       |
| TXT  | `send`              | `v=spf1 include:amazonses.com ~all`            | —        |

Use automatic TTL. These are sending-authentication records; leave the existing main-domain email/MX configuration for the salon inbox intact. Review the domain's existing DMARC policy before adding or changing it. In Resend, start verification and wait for the domain and sending records to show verified. Keep open/click tracking off for voucher messages.

## Dedicated Worker secrets and callbacks

1. Create a **sending-only** Resend API key scoped to this verified domain. In **Cloudflare → rei-booking → Settings → Runtime variables and secrets**, save it as a **Secret** named `RESEND_API_KEY`. Do not put it in GitHub, build logs, chat or a frontend file.
2. In Resend, create a dedicated webhook endpoint at `https://rei-booking.mbaucal.workers.dev/api/email/webhook`. Select `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, `email.complained` and `email.suppressed` where available. Save that endpoint’s signing secret in the same Worker as the **Secret** `RESEND_WEBHOOK_SECRET`.
3. Once verified, change `EMAIL_ENABLED` from `"false"` to `"true"` in both root and `env.test` vars in `wrangler.json` and deploy the tested change. Keep this setting in source so the next GitHub build does not overwrite a dashboard-only flag. The API key and webhook secret remain Cloudflare secrets.
4. Open **Sales → an issued voucher → Review email**. The exact destination and content are shown before **Send email** becomes available. Perform the first real send only to an explicitly approved test recipient, then check **Accepted by email service → Delivered** in delivery history. Do not infer delivery from a 200 API response.

The app uses no SMTP inbox password. No credentials need to be shared with the assistant. Existing owner sign-in and D1 database setup are unchanged; no terminal or owner-password setup is required for this release.

For an interrupted send, reopen the existing delivery and retry. Do not create another external send while its outcome is uncertain. After the safe retry window, check the message in Resend first. A permanent failure, wrong prepared destination or a resend request requires review; the current release does not silently replace an existing delivery payload.
