# Gift voucher use — release 0.4

## Owner workflow

1. Open **Sales → Use voucher**, enter the complete code and select the date and completed appointment. You can also open an issued voucher and choose **Use voucher**, or open a saved Calendar appointment and choose **Voucher payment & history**.
2. Review the treatment, client, therapist, date, voucher entitlement and remaining value. Save any appointment edits before opening voucher payment. Only completed appointments dated today or earlier can use a voucher; dates and expiry use Europe/Belgrade.
3. A treatment voucher covers one matching treatment ID and duration in full, including the appointment's recorded discount. Its original face value is consumed once. There is no substitution, upgrade charge or price adjustment. Amount vouchers can be partly used, up to the lesser of their balance and the appointment value not covered by other vouchers.
4. Tick the confirmation and choose **Confirm voucher use**. An interrupted response offers **Retry same voucher use**, which retrieves the same operation without creating duplicates.
5. The Sales register and CSV show used/remaining value and status. Voucher and appointment details show linked use history. Codes, issued designs, original sale amounts and recipients remain unchanged.

**Not covered by vouchers** is not an unpaid-balance claim: this release does not record other appointment payment methods.

## Correcting a mistake

Open the voucher or appointment history, choose **Correct this use**, give a reason and confirm. This restores the voucher value and records who corrected it and when. It does not refund money, change the sale or cancel the appointment; an expired voucher remains expired. The original use record is retained. A use can be reversed once, and retrying the original use after reversal does not reapply it.

While voucher use is active, changing the appointment's client, time, therapist, treatment, price, request, room/table or status is rejected. Notes can still be edited. Reverse the use first if the linked appointment was wrong, then edit and apply the appropriate voucher again.

## Reports and access

Recorded voucher sales and performed treatments remain separate. Redemption creates no new sale and does not change completed treatment earnings, full-price percentage bonuses, requested bonuses, hours or appointment prices. Voucher sales must not be added to performed treatment revenue as though they were an extra treatment. Financial accounting/refund policies are not introduced here.

The existing owner-only Sales boundary also applies to lookup, balances, history, redemption and corrections. Reception and therapist APIs receive no voucher financial data. Broader reception sales permissions still require an explicit product decision.

## Delivery and limits

A used voucher cannot prepare or send a new email showing its original full entitlement. Previously accepted/delivered email records remain available. Printed issued documents retain the original entitlement; check the code in Sales for its current status. Actual email sender verification is still pending; this feature sends no automatic messages.

This release does not add voucher reservations for future bookings, refunds, transfers, service substitutions, package sessions or loyalty rewards. Those policies remain to be defined.

## Hosted acceptance with fictional data

- Issue a custom-value voucher, mark a fictional appointment Completed, use part of the amount and confirm the remaining value after reload.
- Attempt to spend that balance from two owner sessions: only available value can be used.
- Issue a treatment voucher and check that a different treatment or duration is rejected.
- Correct a use, confirm its reason/actor/time and restored balance, then edit the appointment.
- Verify the owner workflow on laptop, tablet and mobile. Check that reception/therapist views have no voucher actions or values.

Worker/D1 API behavior is tested locally; visual/device acceptance is still pending.
