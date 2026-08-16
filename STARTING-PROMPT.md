# Starting Prompt: azd-auth-notifications

Build this repository into a private Azure Developer CLI (`azd`) template for Microsoft Entra and Microsoft 365 authentication security notifications.

## Product direction

Create an opinionated, production-oriented notification service rather than a generic SIEM demo. It should detect and alert on:

- New authentication-method registration, including passkeys, FIDO2 security keys, Microsoft Authenticator, phone, email, and other supported methods.
- Authentication from a new device or device context.
- Authentication from a new or unusual location, including unfamiliar city, country, ASN, or named location.
- High-risk sign-ins, impossible travel, unfamiliar sign-in properties, and authentication-method changes that warrant review.
- Optional privileged-user and emergency-access-account exceptions with stricter notification behavior.

Use supported Microsoft Graph, Entra audit/sign-in/risk data, Azure Monitor, and Microsoft Sentinel interfaces wherever possible. Do not depend on browser cookies or undocumented portal APIs. Make unsupported or preview-only APIs explicit in documentation and isolate them behind optional components.

## Reference material

- `nathanmcnulty/nathanmcnulty/Entra/passkeys/notifications/` for the existing passkey registration notification design, KQL, Logic App, and Exchange Online RBAC-for-Applications approach.
- `nathanmcnulty/nathanmcnulty/Entra/passkeys/keyvault/` for passkey-related operational context.
- `nathanmcnulty/nathanmcnulty/Entra/device-registration/notifications/` for device registration notification assets.
- `nathanmcnulty/nathanmcnulty/Entra/conditional-access/` for policy and identity-risk context.
- `nathanmcnulty/azd-entra-health-monitoring` for existing health-monitoring deployment patterns.
- `nathanmcnulty/azd-emergency-access` for tenant-safe deployment hooks, cleanup, and emergency-access guardrails.
- `nathanmcnulty/azd-entra-iga` for Graph authentication, permissions, and Logic App deployment patterns.

## Expected implementation

Use `azure.yaml`, Bicep infrastructure, and azd lifecycle hooks. Prefer a modular deployment mode so users can choose Sentinel, Logic App, Azure Function, or a combination. Include:

- Durable storage for alert state, deduplication, and notification history.
- Managed identity and least-privilege Graph/API permissions.
- Teams delivery as the primary notification path, with email as an optional path.
- Configuration for monitored users/groups, privileged identities, thresholds, suppression windows, and severity routing.
- KQL or equivalent queries with explicit deduplication and correlation logic.
- What-if/validation support and safe cleanup that does not remove unrelated tenant objects.
- Tests for template structure, permissions, query rendering, idempotency, and representative event payloads.

Document licensing, consent, data retention, privacy considerations, operating costs, and how to connect the deployment to an existing Sentinel workspace. Keep the first milestone small enough to deploy and validate one end-to-end passkey-registration and new-sign-in notification before expanding coverage.