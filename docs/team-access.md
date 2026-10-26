# Team access (0.19.0)

Owners can manage a saved team member's login from **Team → Edit team member → Access & permissions**. Contact email in the team profile is optional and separate from the account's sign-in identifier.

## Sign-in and permissions

- Use a unique username or an email address. Usernames contain 3–64 characters, start with a letter, and allow letters, numbers, dots, hyphens and underscores. Sign-in is case-insensitive. Existing email sign-in continues to work.
- Choose **Therapist**, **Reception** or **Owner**. **No access** disables a linked account without removing the team profile or its bookings. A team profile can exist without any login account.
- Therapist access is read-only across the whole salon calendar, including treatment, room, timing and Requested markers. Client identity, contacts, private notes, client photos, history, prices and bonuses are not sent to therapist accounts.
- Reception can manage appointments, blocked time and clients. Reports, financial values, Team/Treatments administration, account administration and Sales remain owner-only.
- New accounts use an initial password of 12–128 characters and choose their own password at first sign-in. Owners can replace a staff account's password; it is never displayed, emailed or copied from an existing password. An unchanged password field preserves the existing password.
- Account access and profile details have separate save actions. Existing multiple linked accounts are shown explicitly. Permission or credential changes revoke the affected account's sessions. Owners cannot disable or demote their own account.

## View as member

An owner can choose **View as member** for an enabled Reception or Therapist account. The target user does not need to disclose their password. The page shows a persistent preview banner and a **Return to Owner** action; refreshing preserves the preview.

The server applies the target account's actual read permissions. All changes are blocked during preview, including password changes, account changes, bookings and email actions. The preview is attached to the owner's current session and does not sign the staff member in or change their password. It is a permission preview, not proof that a staff member has completed their first sign-in.

Changing the target account's access or deactivating its required therapist profile makes the preview unavailable. It does not silently restore owner data. Return to Owner ends preview explicitly; signing out ends the owner session. Starting and ending a preview is recorded with the owner as actor.

## Persistence and compatibility

The additive schema in `0017_account_access.sql` initializes automatically. It stores access versions and session-bound preview records. Existing users, passwords, profiles, appointments and history remain in place. The legacy `users.email` column remains the unique sign-in identifier storage and may now contain a username; usernames are never fabricated into email addresses or used to prefill notification email fields. Owner recovery by an existing email address remains supported.

Account edits use version checks and atomic database batches. Stale changes require reloading instead of overwriting another owner's edit. Version triggers also cover legacy password recovery and account enable/disable actions. Account audit entries exclude passwords and hashes.
