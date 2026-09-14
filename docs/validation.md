# Validation status

Initial milestone, 2026-09-13 (Pacific time).

## Passed

- TypeScript checks, runtime bundle, and 20 behavioral tests.
- Runtime dependency audit: no known vulnerabilities at validation time.
- Bicep compilation and PowerShell parsing.
- GitHub Validate and Security hygiene workflows for the initial main milestone.
- Isolated Azure provisioning and Function deployment in rg-auth-notify-dev.
- Health endpoint reports ready with collection disabled.
- Exact managed-identity AuditLog.Read.All and User.Read.All grants.
- Exchange RBAC: Application Mail.Send allowed for Access-Notifications shared mailbox; a different mailbox was out of scope. No unscoped Entra Mail.Send grant was added.
- Deployed managed-identity test email: provider accepted the message to the development administrator.
- Seven-day read-only audit replay: 260 audit records, selecting 26 device-bound passkey registrations and one other registration. Raw payloads were not committed.

The real replay uncovered null target object IDs on canonical passkey records. Resolving their exact target UPN through Graph corrected the detector; fixtures now cover this shape and reject mismatched lookups without using the actor as recipient.

## Open validation

- Actual email receipt awaits the recipient's confirmation.
- Teams test returned TeamsConversationUnavailable. The generated package has not been installed: Graph PowerShell WAM failed with a missing-window-handle error, and the cached CLI token lacks Teams catalog permission (403).
- A new end-to-end registration after collection activation has not been tested. Collection remains disabled, with only the development administrator in the pilot list.
- Separate administrator recipient delivery is fixture-tested; the live pilot used the same person for both audiences and deduplicated that route.
- Additional authentication-method variants remain unverified with real events.

Provider acceptance and a historical read-only replay are not proof of a new registration reaching the user. This is not a production-ready release.
