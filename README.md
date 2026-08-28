# Authentication security notifications for Microsoft Entra

`azd-auth-notifications` is a private work-in-progress repository for an administrator-focused notification service covering authentication-method changes and security-relevant sign-ins.

## Status

This repository is a design placeholder. It does not yet contain an `azure.yaml`, Azure infrastructure, deployment hooks, or a supported notification service. **Do not run `azd init` or treat this repository as deployable.**

The first deployable milestone is intended to:

- detect a passkey or other authentication-method registration;
- detect a new or security-relevant sign-in;
- send a deduplicated Microsoft Teams notification, with email optional;
- use managed identity and supported Microsoft Graph, Azure Monitor, or Microsoft Sentinel interfaces;
- default to observation only, with no automatic identity remediation.

## Administrator safety goals

The future template must document required licensing, permissions, consent, data retention, operating cost, and cleanup before deployment. Preview interfaces must be optional and clearly identified. Remediation, privileged-user handling, and tenant cleanup must require explicit approval and must not be inferred from matching display names.

## Development plan

The current product direction and initial implementation requirements are in [STARTING-PROMPT.md](STARTING-PROMPT.md). The repository will receive an administrator quickstart only after a complete template can be initialized and validated end to end.
