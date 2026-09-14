# Operations

The timer dispatches pending records, then collects registrations every five minutes. Newly queued events are attempted on the next cycle. Latency also includes Entra audit availability.

First activation establishes a boundary without importing historical registrations. Subsequent reads overlap by 60 minutes (configurable). Failed reads do not advance progress. Events arriving beyond the overlap may be missed. Downtime beyond Entra audit retention cannot be recovered. Pausing preserves the checkpoint, so resuming catches up within available retention.

## Delivery state

AuthNotifications table partitions by tenant. Delivery identity is audit ID, channel, and recipient ID. ETag claiming prevents concurrent dispatch. Canonical passkey selection suppresses the observed generic pair; all passkey variants are not yet verified.

| State | Meaning |
|---|---|
| pending | Waiting for dispatch and current scope validation. |
| sending | Claimed; investigate if stale after a host crash. |
| accepted | Provider succeeded; recipient observation is not established. |
| review | Failed/uncertain send; investigate before deliberate replay. |
| suppressed | Scope or channel no longer includes this queued route. |

Failed send attempts are not automatically retried. This conservative initial policy avoids duplicates at the cost of manual recovery. Never blindly reset sending/review. Use Azure Storage Explorer with an explicitly scoped operator role for state inspection. No public endpoint exposes message records.

## Privacy and retention

State includes event/user IDs, method labels, times, route status, and Teams conversation references. Raw audits and registered contact details are not stored. Table records have no automatic expiry yet; retain deduplication keys through the maximum replay horizon. Plan table storage costs and operational retention separately from workspace log retention.

## Cleanup

Disable collection first. Record exact managed-identity and Teams catalog/installation IDs and Exchange grant names before azd down. Resource deletion does not remove external Teams catalog or Exchange service-principal/scope/role objects. Remove only this environment's exact objects, never matches by display name alone. Automated tenant cleanup is not included.

## Evidence boundary

Dev-tenant audit inspection confirmed paired device-bound passkey events. Other methods remain fixture-tested until real registrations are observed. See validation.md. Provider acceptance alone is not end-to-end readiness.

Canonical passkey events may omit the affected object ID. For these records only, the reader resolves the target UPN through Graph and requires the returned UPN to match before binding to its object ID. It never uses the initiating actor as a recipient fallback. A deleted or renamed target that no longer resolves is skipped; current directory lookup cannot reconstruct historical UPN ownership. Keep the collection overlap short and review identity lifecycle edge cases before production.
