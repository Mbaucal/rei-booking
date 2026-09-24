# Sales and gift vouchers — implementation v0.4

## Included

Owner navigation: **Sales → Gift vouchers → New sale**. The register searches voucher code, buyer name or recipient display name and filters the sale date in Europe/Belgrade. It has pagination, a filtered total and CSV export. A sale can contain 1–20 independently personalised vouchers. Current active treatment variants supply the exact treatment name, duration and price; an explicit custom RSD amount is also available.

The buyer is optional. Choose an existing client or stage a new client in the cart; a new client, the sale, all vouchers and audit records commit together. Duplicate client contacts reject the entire transaction. The buyer never determines the delivery address automatically. After issuance, **Use buyer’s email** is an explicit optional action in the email form; there are no automatic CC/BCC recipients.

Each voucher has a random 96-bit, unique code and an immutable copy of its treatment/amount, price, recipient display name, gift sender, message, validity and design. Treatments are checked again by a database trigger during checkout, preventing issuance using a concurrently changed menu. The owner must choose a validity date or explicitly choose **No expiry date** for each voucher. This does not establish a salon-wide expiry policy.

Design controls: ivory/forest brand palette, centred/personal-letter layout, title, terms/instructions, message and optional treatment price. The original logo is used. Saved defaults affect future vouchers only. A server-rendered preview is required by the cart interface before adding a voucher. Issued vouchers can be printed or saved as PDF through the browser’s print dialog; there is no separate generated PDF attachment in this release.

## Payments, retries and reports

Checkout records a payment already received externally (cash, card, bank transfer or other, with an optional reference). It does not charge a card or connect to a payment terminal. Completing a sale issues the vouchers in the same D1 transaction. A unique request ID and normalized payload hash ensure concurrent or interrupted retries return the original sale. A changed payload cannot reuse a completed request ID. A browser network failure freezes the submitted cart and offers **Retry same checkout**.

The Sales register measures voucher sales. Existing Dashboard/Reports continue to measure completed treatment performance and do not add gift sales to those figures. Payment, issuance and redemption are distinct events; a combined cash/revenue report is not implemented here.

## Voucher use

**Sales → Use voucher** looks up the full code and links a confirmed use to a completed appointment. The same workflow opens from Calendar appointment details. Amount vouchers allow partial use; treatment vouchers cover one exact treatment/duration. The register and CSV show current used/remaining values. Mistaken uses can be reversed with a recorded reason; they are never deleted. Appointment edits are guarded while voucher use is active, except notes. These operations do not change treatment prices or bonuses. See [the full workflow and limits](voucher-redemption.md).

## Email delivery

From is fixed to **Rei Thailand Massage <info@reithailandmassage.com>**. The owner enters the recipient and subject, opens **Review email**, then explicitly clicks **Send email**. Preparing or selling a voucher never sends it. The preview is the exact persisted HTML/text payload, with a unique delivery record. The voucher appears in the body of the email; no public voucher URL or attachment is generated. Printed vouchers are available independently of email setup. Used vouchers cannot prepare or send a new original-entitlement email; historical accepted/delivered records remain available.

Sending requires `EMAIL_ENABLED=true`, the server-only `RESEND_API_KEY` secret and `RESEND_WEBHOOK_SECRET`. See [email setup](email-setup.md). A successful provider API response is **Accepted by email service**, not **Delivered**. Signed Resend callbacks record delivery, delay, failure, bounce, complaint or suppression. Event IDs are deduplicated and late events cannot downgrade a terminal result. Callback-before-API-response races are reconciled after the provider ID is saved. Bounce/complaint/suppression blocks subsequent sends to that recipient.

An atomic database claim prevents concurrent sends. Retries use the exact persisted payload and the same provider idempotency key; a network timeout does not imply failure to send. Retry requests back off and are initiated from the recorded email in the UI. After 23 hours from the first attempt, unresolved deliveries require provider review instead of another send, because Resend retains idempotency keys for 24 hours. There is currently one logical email per voucher/recipient; resending a delivered gift to the same address and editing an already prepared email are not supported. The same original preview remains available in history. Permanent failures require review. No automated queue/cron is enabled.

Email API errors shown to the browser use generic codes; keys, raw provider error bodies and authorization headers are never returned or audited. Webhooks verify raw bytes using the Svix HMAC-SHA256 format, constant-time comparison and a five-minute timestamp tolerance. Only the signed callback route bypasses browser-origin/session/CSRF checks; all owner actions retain them.

## Deliberate remaining scope

- Sales is owner-only in this slice. Reception retains the approved no-financial-access policy; a narrower permission to sell vouchers needs an explicit decision.
- [Voucher use and balances](voucher-redemption.md) are implemented in v0.4, including completed appointment links and audited corrections. Package rules, cash refunds, transfers, reservations and treatment substitution remain pending.
- The final recipient design, expiry/transfer rules and PDF-attachment versus other delivery formats remain reviewable decisions.
- Browser/device visual acceptance, actual DNS verification, sender secrets and a user-authorized end-to-end delivery test are still required. Automated tests use fictional recipients and a mock provider; no real email has been sent.

`0003_sales.sql` is additive and creates only new tables, indexes and triggers. It is installed automatically when an authenticated owner opens Sales, preserving existing clients, accounts, appointments and reports. The same migration can subsequently be applied by Wrangler without changing records.

Official references: [Resend send API](https://resend.com/docs/api-reference/emails/send-email), [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [signed callbacks](https://resend.com/docs/webhooks/verify-webhooks-requests), [Svix manual verification and test vector](https://docs.svix.com/receiving/verifying-payloads/how-manual).
