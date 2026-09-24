# Voucher cancellation and corrections — release 0.5

## Owner workflow

Open **Sales → Gift vouchers**, choose a code, then select:

- **Void erroneous voucher** for an incorrect or duplicate entry with no separate payment to return. Only an unused voucher qualifies. Give a reason and confirm; its code becomes invalid and its net sale is zero.
- **Record refund** after returning the money outside this application. Select how it was returned, optionally record a reference, give a reason and confirm. The entire remaining balance is closed. An amount voucher that was partly used keeps its used value in net sales. This button records a refund; it does not send money or operate a card terminal.
- **Correct details** for recipient/sender names, gift message, design or validity. Only an unused voucher qualifies. Review the preview and confirm. A new code with the same treatment, duration, original price and sale replaces the old code. The original issued copy is retained, and no new payment is recorded. Archived or repriced menu items retain their originally purchased entitlement. Send the corrected voucher separately; correction does not send an email.

To change the treatment or monetary value, void an erroneous sale or record a real refund, then create the correct sale. Fully used vouchers have no remaining balance to refund. If a use was recorded incorrectly, correct that use first. Closed vouchers cannot be reopened by reversing their old use records. Expired but unused value may be refunded or corrected by the owner; the software does not impose a salon refund or expiry policy.

## Register, totals and exports

**Net sales** is the default register and CSV view. It omits codes with zero net sale value: voided, fully refunded and replaced codes. Partially refunded vouchers remain at their used value. **All records** shows the complete issued-code history, including original and replacement links, reasons, actor, time and recorded refund method/reference. Closing a voucher is an adjustment, not a destructive deletion of its sale.

For a complete sale or unfiltered sale-date cohort: original voucher value − voids − refunds = net sales. Replacement chains contribute original value once through their final code. Code/recipient searches intentionally narrow totals to only the matching rows. The original payment is retained in sale details alongside the adjusted net total.

Date filters select the **original sale date in Europe/Belgrade**, with all later adjustments reflected in those sales. They are not a report of cash received/refunded during the selected dates. CSV includes both original sale time and code issuance time, as well as adjustment time. Completed-treatment Reports, hours and bonuses are unchanged; do not add voucher sales to treatment revenue as if they were additional massages.

## Persistence and concurrent actions

One immutable closure per voucher is guarded by the database. Balance, unused-voucher eligibility and remaining refund amount are checked in the same transaction as the closure. Corrected code creation is atomic with invalidating the old code. Simultaneous voucher use and closure cannot both succeed. Identical retried actions return the saved result, while changed payloads cannot reuse that request identifier. The browser offers **Retry same action** after an uncertain response; review the voucher before beginning another action.

Owner session, origin and CSRF checks apply to previews and writes. Reception and therapists cannot call these financial APIs. Audit/history records preserve the original voucher and reason. Additive migration `0005_voucher_changes.sql` can be applied repeatedly; existing records and account access are retained.

Closed codes are rejected by voucher redemption and new email sends. Print previews mark them invalid. Previously accepted emails cannot be recalled, and an email already in flight may still arrive; its closed code remains unusable. The new code has its own independently addressed email preview. No actual email was sent during development.

## Acceptance

With fictional test data, open Sales on laptop/tablet/mobile and check:

1. Void a duplicate: it disappears from Net sales and its CSV; All records shows the reason and zero net value.
2. Record a full unused refund: the voucher is closed and its adjusted sale total is zero. Try a partly used amount voucher: refund closes only its remaining balance.
3. Correct a name/design: preview, issue, then verify the new code, unchanged sale total and linked old code marked Replaced.
4. Repeat a save after an interrupted response; the action must not duplicate. Attempt simultaneous use/cancellation from two sessions; only one can succeed.
5. Reopen closed codes and confirm print invalidation, disabled email/use and preserved history.

Automated Worker/D1 checks cover eligibility, permissions, repeated migrations, concurrent actions, idempotency, CSV/totals, email suppression and immutable history. Hosted visual/device acceptance remains pending.
