# Shared Flex host compatibility assessment

AUTH-008 decision, 10 October 2026: **defer adoption** of the current
`flex-scheduled-poller-host` 0.1.0 pilot. Its storage and identity contracts do not
preserve this solution's identity-only host and durable Table state. Keep the
existing independently deployable host; no migration is approved by this record.

## Exact evaluated sources

- Auth Notifications base:
  [`016a9ded4b9777c95a975b271fb678a8d84ef615`](https://github.com/nathanmcnulty/azd-auth-notifications/tree/016a9ded4b9777c95a975b271fb678a8d84ef615).
- Proposed reuse candidate, evaluated only:
  Reference revision `a79ed9ab9ae2ec10ff3d3c50a011d878c9524592`,
  [pilot manifest](https://github.com/nathanmcnulty/azd-reference/blob/a79ed9ab9ae2ec10ff3d3c50a011d878c9524592/components/bicep/flex-scheduled-poller-host/component.json)
  and [Bicep source](https://github.com/nathanmcnulty/azd-reference/blob/a79ed9ab9ae2ec10ff3d3c50a011d878c9524592/components/bicep/flex-scheduled-poller-host/flex-scheduled-poller-host.bicep).
  The complete component directory is unchanged through Reference main
  `77b5f83468b0d60d534efd4a52ca389a77e37637` inspected for this assessment.
  This candidate pin is not added to the consumer lock.

## Compatibility findings

| Boundary | Current Auth implementation | Evaluated shared pilot | Outcome |
| --- | --- | --- | --- |
| Storage authentication | Shared-key access is disabled; Function host Blob/Queue/Table settings use managed identity | Enables shared keys and constructs `AzureWebJobsStorage` from an account key | Incompatible with the required identity-only boundary |
| Package deployment | Flex storage authentication uses the existing user-assigned identity | Uses `StorageAccountConnectionString` for deployment | Reuse would regress deployment authentication |
| Runtime identity | Stable user-assigned identity also supplies bot and runtime client IDs | Creates a system-assigned Function identity | Existing bot/Graph/host identity bindings cannot simply be carried over |
| Durable state | Table client uses managed identity and Table Data Contributor; Blob/Queue roles also support the host | Creates Blob state/dead-letter containers and grants Blob Data Contributor only | Does not provision or authorize the required Table contract |
| Host shape | Node 22 Flex, 2048 MB, maximum 10 instances | Node 22 Flex, defaults 512 MB and one instance, with configurable memory/scale | Runtime family is compatible; sizing defaults are not a migration decision |
| Monitoring | Existing solution-owned Application Insights and identity-authenticated telemetry | No forced Log Analytics workspace or Application Insights resource | Reuse does not itself require adding Log Analytics; current telemetry still must be preserved |
| Domain behavior | Recipient policies, per-route state, retention and explicit collection activation are solution-owned | Generic host accepts application settings, with host settings taking precedence | No event engine or recipient policy extraction is justified |

Auth infrastructure findings are bound to
[`infra/resources.bicep`](https://github.com/nathanmcnulty/azd-auth-notifications/blob/016a9ded4b9777c95a975b271fb678a8d84ef615/infra/resources.bicep).
Table client authentication is implemented in
[`src/state.ts`](https://github.com/nathanmcnulty/azd-auth-notifications/blob/016a9ded4b9777c95a975b271fb678a8d84ef615/src/state.ts).
Collection activation and pilot-recipient gates remain in
[`src/core.ts`](https://github.com/nathanmcnulty/azd-auth-notifications/blob/016a9ded4b9777c95a975b271fb678a8d84ef615/src/core.ts);
state review and retention remain in
[`src/review.ts`](https://github.com/nathanmcnulty/azd-auth-notifications/blob/016a9ded4b9777c95a975b271fb678a8d84ef615/src/review.ts)
and [`src/retention.ts`](https://github.com/nathanmcnulty/azd-auth-notifications/blob/016a9ded4b9777c95a975b271fb678a8d84ef615/src/retention.ts).

## Reconsideration gates

Re-evaluate a reviewed immutable component only when it can preserve
shared-key-disabled host and package storage, the existing user-assigned identity,
required Blob/Queue/Table authority and the existing Table schemas and records.
Compare generated resources, identity bindings, application-setting precedence,
resource ownership, package behavior and rollback before selecting a migration.
Keep collection disabled by default and retain existing recipient/pilot rules.
Do not introduce Log Analytics merely to obtain component reuse.

Compatibility work must not silently copy bootstrap grants into runtime identity,
replace Table state with Blob state or broaden recipient scope. Any actual
identity/resource migration, permission assignment, collection activation or
delivery requires its separately authorized exact targets and cleanup evidence.
No hosting migration, resource change, permission change or runtime change is
made by this assessment.

## Offline validation

Run `pwsh -File ./scripts/Test-Repository.ps1` with PowerShell 7.6 or later.
The registered validator runs dependency installation, runtime tests, TypeScript
build, Bicep compilation and whitespace checks. Backlog schema and generated-view
checks verify AUTH-008's recorded decision. These checks qualify this assessment
and existing source locally; they do not qualify a shared-host deployment or
prove live registration, email or Teams delivery.
