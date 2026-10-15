# Roadmap

> Task tracking moved to [the standardized backlog](backlog.md) and its
> [canonical JSON](backlog.json). This document retains product direction and
> design context; update task status and completion evidence in the backlog.

## Email and Teams milestone

Independent end-user and optional administrator channel selection; successful registration detection; pilot scope; durable per-route state; scoped sender and personal bot. Complete real registration and observed email/Teams delivery proof before production readiness.

## Azure Communication Services

AUTH-003 is blocked pending a product decision on Microsoft's ACS retirement and
finite lifecycle; the assessment is recorded in [acs-transport-design.md](acs-transport-design.md).
Keep the existing Graph email and Teams routes. Select a replacement provider
separately before changing transport, permissions or state, with explicit
per-audience opt-in and approved destination state. Never derive destinations
from a newly registered method.

## Operational improvements

- Guided review/replay of ambiguous sends using provider evidence.
- Deduplication-safe retention cleanup.
- Additional method coverage from real samples, including synced passkeys and administrator registration.
- Teams onboarding/removal automation with exact ownership and recorded installation IDs.
