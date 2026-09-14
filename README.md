# Authentication-method registration notifications

Notify affected users when a new Microsoft Entra authentication method is registered. Deploying administrators select **email, personal Teams messages, or both**, independently for end users and optional administrators.

## Status

Initial implementation under dev-tenant validation; not a production-validated release. Azure Communication Services is on the [roadmap](docs/roadmap.md) for both audiences.

## Behavior

A Node.js Azure Function polls Graph audit logs every five minutes and persists per-recipient delivery records in Azure Tables. Managed identity sends email through Graph or personal messages through Azure Bot Service. No Sentinel or existing log ingestion is required.

- End-user channels: email, teams, or both.
- Optional admin channels: independent selection and recipient object IDs.
- Recipients come from the affected directory user, never the audit actor or newly registered method.
- Email resolves an existing organizational mailbox; guests and missing mailboxes are rejected.
- Teams requires the personal bot installed for every recipient.
- A pilot allowlist is the default. Broad scope requires ALL_USERS=true.
- Collection starts disabled. First activation does not notify historical registrations.
- If the affected user is an administrator, the same channel receives one user notification.

## Development

Requires Node.js 22+, PowerShell 7, Azure CLI, Azure Developer CLI, and Bicep via Azure CLI.

    npm ci
    npm test
    npm run build
    az bicep build --file infra/main.bicep

See [deployment](docs/deployment.md), [operations](docs/operations.md), and [validation](docs/validation.md).

## Detection

Accepts successful Add Passkey (device-bound) and User registered security info records with method details. Generic Passkey events are excluded because the dev tenant emits paired passkey-specific events. Unknown method names use a generic label without copying arbitrary audit content. Starts, failures, updates, deletions, and administrator-created methods are excluded.

Adapted from the author's [MFA design](https://github.com/nathanmcnulty/nathanmcnulty/tree/main/Entra/passkeys/notifications) and [device-notifications](https://github.com/nathanmcnulty/azd-device-notifications) patterns.

Interfaces: [Graph audits](https://learn.microsoft.com/en-us/graph/api/directoryaudit-list), [Teams proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages), [Exchange application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).
