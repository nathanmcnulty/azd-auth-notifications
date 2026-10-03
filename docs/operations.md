# Operations

The timer dispatches pending records, then collects registrations every five minutes. Newly queued events are attempted on the next cycle. Latency also includes Entra audit availability.

First activation establishes a boundary without importing historical registrations. Subsequent reads overlap by 60 minutes (configurable). Failed reads do not advance progress. Events arriving beyond the overlap may be missed. Downtime beyond Entra audit retention cannot be recovered. Pausing preserves the checkpoint, so resuming catches up within available retention.

## Delivery state

AuthNotifications table partitions by tenant. Delivery identity is audit ID, channel, and recipient ID. ETag claiming prevents concurrent dispatch. Canonical passkey selection suppresses the observed generic pair; all passkey variants are not yet verified.

| State      | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| pending    | Waiting for dispatch and current scope validation.            |
| sending    | Claimed; investigate if stale after a host crash.             |
| accepted   | Provider succeeded; recipient observation is not established. |
| review     | Failed/uncertain send; investigate before deliberate replay.  |
| suppressed | Scope or channel no longer includes this queued route.        |

Failed send attempts are not automatically retried. This conservative initial policy avoids duplicates at the cost of manual recovery. Never blindly reset sending/review. Use Azure Storage Explorer with an explicitly scoped operator role for state inspection. No public endpoint exposes message records.

### Review decisions

`npm run review:deliveries --` is an operator-only Table data tool. It is
read-only unless `--action` is supplied, and it never calls Graph, Teams, or the
notification dispatcher. Every invocation requires an explicit subscription,
tenant, and Table endpoint. It verifies a fresh `az account show
--subscription` result, acquires a subscription-bound Storage token through
the existing Azure CLI session, requires its `tid` to match the requested
tenant, and requires a valid `oid` claim that it records as the decision actor.
The tool never initiates authentication. Establish a normal cached Azure CLI
session first.

The default listing returns at most 25 `review` rows and exposes only the tenant,
hashed delivery row, current ETag, audit ID, recipient object ID, audience,
channel, provider code, and update time. It does not output the stored payload,
method, message, mailbox, conversation, or token. Use `--limit` from 1 through
100 to change the bound. When a page has more results, the output includes an
opaque `nextContinuationToken`; pass it unchanged with `--continuation-token`
to read the next bounded page. Continuation tokens are accepted only for
read-only listing.

An action requires the exact listed delivery row and ETag, a caller-stable
decision UUID, and a short bounded reason code. Only `review` rows are
actionable:

- `accept` requires an allowlisted provider-evidence reference confirming that
  delivery occurred and records the row as `accepted`.
- `requeue` requires either an allowlisted provider-evidence reference
  confirming no delivery or `--acknowledge-duplicate-risk`. It returns the same
  row to `pending`; the timer later rechecks the current audience and channel
  policy before any transport call.
- `suppress` records an explicit operator decision without claiming delivery.

Evidence references use one of `ProviderCase:`, `ExchangeTrace:`,
`TeamsActivity:`, or `GraphRequest:` followed by a short identifier. They and
reason codes are identifiers, not URLs or prose. URLs and query strings fail
validation. Operators must never supply SAS values, tokens, or secrets. The
decision UUID makes a retry after an uncertain client response
safe. The delivery transition and a create-only
`reviewDecision` audit row are one same-partition transaction guarded by the
current ETag. A concurrent change fails closed. Decision rows record the
hashed delivery row, action, authenticated actor object ID, token tenant, and
the Table service timestamp. They omit the event, recipient, audience, and
channel identities. The application never updates those rows, although a
Storage Table Data Contributor can still alter data directly; protect storage
RBAC and logs accordingly. Accept and suppress decisions set the delivery
`updatedAt` to the transition time so terminal payload retention begins at the
decision rather than the earlier ambiguous send.

The template does not grant operator access. Listing needs Storage Table Data
Reader and decisions need Storage Table Data Contributor scoped to the
`AuthNotifications` table or, where table scope is unavailable, its storage
account. Grant and remove those roles through the organization's normal access
review process.

## Privacy and retention

State includes event/user IDs, method labels, times, route status, Teams conversation references, and operator review decisions with actor object IDs. Raw audits and registered contact details are not stored. `TERMINAL_PAYLOAD_RETENTION_DAYS` is optional and defaults to `0` (disabled). When set from 1 through 36500, each timer cycle uses the terminal transition time to replace details for at most 25 old `accepted` or `suppressed` deliveries with minimal tombstones. It never compacts `pending`, `sending`, or `review`, and it does not touch the collection checkpoint, Teams conversation records, or `reviewDecision` audit rows.

Tombstones preserve the same tenant partition and hashed delivery row key indefinitely, so overlap, delayed audit availability, or a replay cannot recreate a completed route. Compaction uses the entity ETag and `Replace` semantics: a concurrent state change wins with HTTP 412 and cleanup leaves that row unchanged for a later cycle or operator inspection. The tombstone retains only delivery kind, terminal status, and compaction time; payload, result code, attempt time, and source identifiers are removed. Plan table storage costs and retention separately from workspace log retention. Changing this setting never authorizes deletion of tombstones.

A separate `retention-cursor` control row keeps the fixed cutoff, query version, page size, and opaque Azure Table continuation token for a bounded sweep. Each cycle consumes one page, including empty pages that carry a continuation token, and advances the cursor only after processing that page. Cursor creation, advance, reset, and removal use create-only or ETag-conditional operations. Increasing the retention period resets a newer active cutoff before any query so an earlier policy cannot compact details that the new policy retains. Lowering the per-cycle cap also resets a larger active page before querying; increasing the cap finishes the active sweep at its original smaller size.

## Cleanup

Disable collection first. Record exact managed-identity and Teams catalog/installation IDs and Exchange grant names before azd down. Resource deletion does not remove external Teams catalog or Exchange service-principal/scope/role objects. Remove only this environment's exact objects, never matches by display name alone. Automated tenant cleanup is not included.

## Evidence boundary

Dev-tenant audit inspection confirmed paired device-bound passkey events. Other methods remain fixture-tested until real registrations are observed. See validation.md. Provider acceptance alone is not end-to-end readiness.

Canonical passkey events may omit the affected object ID. For these records only, the reader resolves the target UPN through Graph and requires the returned UPN to match before binding to its object ID. It never uses the initiating actor as a recipient fallback. A deleted or renamed target that no longer resolves is skipped; current directory lookup cannot reconstruct historical UPN ownership. Keep the collection overlap short and review identity lifecycle edge cases before production.
