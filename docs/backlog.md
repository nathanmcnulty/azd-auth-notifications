# Backlog: nathanmcnulty/azd-auth-notifications

> Generated from `docs/backlog.json`. Edit the JSON source and regenerate this file.
> Standard: [azd agent backlog standard](https://github.com/nathanmcnulty/azd-reference/blob/main/standards/agent-backlogs.md). This link is review guidance, not a runtime dependency.

- **Schema version:** 1.0.0
- **Repository:** nathanmcnulty/azd-auth-notifications
- **Source revision:** `c60ef82114cebd7885bed02a726140b21904f5a6`
- **Captured:** 2026-10-04
- **Items:** 10

## AUTH-001: Reconcile this backlog with current source and active work

- **Kind:** discovery
- **Priority:** P1
- **Status:** done
- **Wave:** 0
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

Plans and implementation evidence are spread across files; the captured source can change while other tasks work.

**Scope:**

- docs/backlog.json
- docs/backlog.md
- Existing roadmap, execution status, open issues and pull requests &lpar;read-only&rpar;

**Acceptance:**

- Classify each candidate as implemented, still open, superseded or awaiting evidence; retain source links and reasons.
- Inspect dirty state, remotes, worktrees and local environment presence without reading secrets; avoid duplicate work with active owners.
- Resolve the actual offline validation commands and record exact current default-branch/working-tree provenance; do not copy historical live passes to newer code.

**Validation:**

- git status --short
- git remote -v
- git worktree list --porcelain
- Read the applicable instructions and validation workflow; read gh issue list and gh pr list for the named repository using nathanmcnulty. Do not create or modify issues/PRs.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- README.md
- docs/roadmap.md

**Evidence:**

- Reconciled the reviewed preservation tip 8254348637b7ca8b952ce49dfa98a071503fb934 against freshly fetched origin/main c60ef82114cebd7885bed02a726140b21904f5a6. The fresh main is the preservation merge&#39;s exact second parent, so its reviewed Graph retry changes were retained while the local-only retention, component-upgrade and operator-review packets were restored without copying the dirty canonical checkout.
- Current source, six worktrees, active issue &num;9 and pull requests were inspected read-only on 2026-10-04&colon; no pull request is open, and issue &num;9 still tracks recipient-visible notification acceptance plus remaining roadmap work. AUTH-002, AUTH-003, AUTH-006, AUTH-007 and AUTH-008 therefore remain proposed; AUTH-004, AUTH-005, AUTH-009 and AUTH-010 retain their reviewed completion evidence.
- Exact offline repository validation on the reconciled staged tree passed 55/55 tests, npm audit with zero findings, typecheck/build, Bicep compilation, managed-component drift, permission/backlog schemas, generated-backlog check and Git diff checks. The retained nine-assertion Azure Table proof applies only because its five proof-bound product files are byte-identical; no new cloud operation, notification delivery or human-receipt validation was performed.

**Review and authorization note:**

Review AUTH-001 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-010: Add bounded retry for Graph throttling and transient server errors

- **Kind:** discovery
- **Priority:** P1
- **Status:** done
- **Wave:** 0
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

Open report captured 2026-10-03 during execution reconciliation. Another code-quality task may own an active fix; inspect its PR and current source before dispatch.

**Scope:**

- Linked issue and current source &lpar;read-only&rpar;
- Repository-local backlog evidence

**Acceptance:**

- Read the linked issue and current default branch; classify the exact defect, current owner and evidence gap.
- Record a current PR or verified resolution before selecting any implementation; preserve broader feature and live acceptance gates.

**Validation:**

- Read current issue and PR state using nathanmcnulty; do not modify or close issues during reconciliation.
- Inspect dirty state and worktrees; resolve the exact current revision and relevant offline commands before implementation.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- https&colon;//github.com/nathanmcnulty/azd-auth-notifications/issues/7

**Evidence:**

- Verified issue &num;7 closed and PR &num;8 merged 2026-10-03 at c60ef82114cebd7885bed02a726140b21904f5a6&colon; https&colon;//github.com/nathanmcnulty/azd-auth-notifications/pull/8. Separate quality task owns the fix and required validation-check repair. This is remote-main resolution; the canonical permission-tracking checkout has not been reset or pulled over local work.

**Review and authorization note:**

Review AUTH-010 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-009: Adopt deployment-validation 1.1.1 with compatible existing reports

- **Kind:** maintenance
- **Priority:** P1
- **Status:** done
- **Wave:** 1
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

The captured consumer lock used stable1.0.0; the selected update adopts the reviewed immutable1.1.1 release without activating new evidence-binding behavior.

**Scope:**

- azd-components.lock.json
- scripts/vendor/Azd.DeploymentValidation/
- tests/
- docs/

**Acceptance:**

- Review the exact 1.0.0-to-1.1.1 diff and current consumer hashes before deciding to adopt.
- Prepare only the compatible managed files and lock in one owned worktree; retain domain validation extensions.
- Offline validation and commit-only rollback are required; live deployment and publication are separately authorized.

**Validation:**

- pwsh -File ./scripts/Test-Repository.ps1
- Verify the three managed deployment-validation files against the exact immutable lock hashes; preserve all unrelated components.
- Run the repository-specific plan/schema compatibility check with provider commands mocked or forbidden; no live deployment or delivery is implied by this vendoring update.

**Dependencies:**

- _none_

**Components:**

- deployment-validation

**Sources:**

- azd-components.lock.json

**Evidence:**

- Selected for separate compatible managed-files/lock upgrade under coordinated maintainer instruction. Existing vendor files match their 1.0.0 lock; reviewed immutable 1.1.1 source resolves to 0c96cc89c554ffc3b3ca82ceda12da6591e816c1. Fresh auth main base c60ef82114cebd7885bed02a726140b21904f5a6 already includes independently owned Graph retry fix; it is not reimplemented here.
- Independent five-file review passed diff778305e0ffba1854a4bd3397bdcb156a2b1d737211eb5a224dd2c88578af5682 at consumer basec60ef82114cebd7885bed02a726140b21904f5a6. Three managed files byte-match reviewed signed release1.1.1 at0c96cc89c554ffc3b3ca82ceda12da6591e816c1; notification-contracts remains1.0.0. Existing adapter and unbound schema1.0 output are preserved.
- Fresh-main author and independent checks passed32/32 Node tests, audit0, typecheck/build, Bicep, PSSA and zero-az/azd plan smoke3/3. Integrated retention-plus-upgrade canonical checks passed37/37 and plan smoke3/3; retention prose was preserved while correcting one version token. Reviewed central desiredVersion/assertion/documentation update passed47/47 focused tests. No new lab deployment was needed.
- Integrated locally after target/base checks; the template remains independently deployable. Release and evidence-binding feature adoption remain separate tasks.

**Review and authorization note:**

Review AUTH-009 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-008: Evaluate the optional shared Flex poller host

- **Kind:** discovery
- **Priority:** P2
- **Status:** proposed
- **Wave:** 1
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

The solution already owns recipient routing and durable table state; only hosting duplication is a candidate for reuse.

**Scope:**

- infra/
- azd-components.lock.json
- docs/

**Acceptance:**

- Compare current host with the pilot manifest; retain Table state, recipient policies and explicit collection activation.
- Do not replace identity-only storage with shared keys or introduce Log Analytics solely for reuse.
- Record adopt/defer decision and exact proposed immutable pin; no host migration until compatibility is established.

**Validation:**

- Use the offline commands in the registered validation workflow; record the exact commands, revision and results before implementation is complete.
- Run focused tests for changed behavior from tests/; fixtures do not prove live-service or endpoint behavior.

**Dependencies:**

- _none_

**Components:**

- flex-scheduled-poller-host

**Sources:**

- README.md
- infra/main.bicep

**Evidence:**

- _none_

**Review and authorization note:**

Review AUTH-008 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-002: Prove successful registration and recipient-visible email/Teams routes

- **Kind:** verification
- **Priority:** P1
- **Status:** proposed
- **Wave:** 2
- **Authorization:** external-delivery
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

The implemented pilot still needs real registration and observed delivery evidence for each audience/channel.

**Scope:**

- docs/validation.md
- docs/operations.md

**Acceptance:**

- Record one affected-user receipt for every enabled route and independent optional administrator routing.
- Verify pilot allowlist, no historical notifications on activation, missing mailbox/guest rejection and paired passkey deduplication.
- Record provider acceptance separately from human receipt, and clean only recorded owned app/installation objects.

**Validation:**

- Use the offline commands in the registered validation workflow; record the exact commands, revision and results before implementation is complete.
- Run focused tests for changed behavior from tests/; fixtures do not prove live-service or endpoint behavior.
- After separate authorization, retain redacted exact-target live evidence and cleanup results outside public Git. Do not execute live operations from this backlog alone.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- docs/roadmap.md
- docs/validation.md

**Evidence:**

- _none_

**Review and authorization note:**

Review AUTH-002 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-004: Add provider-evidence-based ambiguous-send review and replay

- **Kind:** maintenance
- **Priority:** P2
- **Status:** done
- **Wave:** 2
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

Ambiguous provider results must not become duplicate notifications.

**Scope:**

- src/ delivery-state review APIs
- tests/
- scripts/ operator review CLI and validation fixtures
- package.json operator CLI entry point
- docs/operations.md
- azd-permissions.json if the new operator workflow requires an additional recorded actor or gap

**Acceptance:**

- Review queue records tenant/audit/recipient/channel identity without secrets.
- Replay requires provider evidence or explicit operator decision and preserves idempotency.

**Validation:**

- Use the offline commands in the registered validation workflow; record the exact commands, revision and results before implementation is complete.
- Run focused tests for changed behavior from tests/; fixtures do not prove live-service or endpoint behavior.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- docs/roadmap.md

**Evidence:**

- Independently reviewed operator-only CLI and review engine from base 2cfa9ed73332111d945cdba1adbbbd07205e32ea, including exact main Graph retry merge c60ef82114cebd7885bed02a726140b21904f5a6. Lists bounded paginated review metadata; accept, suppress and evidence/acknowledgement-based requeue use conditional atomic delivery-plus-decision transactions. No direct dispatch or authentication initiation.
- Source packet SHA-256 930aa55682b82c9114edc0ca55d4ce8cd4a29a5996a89d1b7aa30177bcc7e4a6; frozen runtime and documentation independently reviewed. Provider evidence remains an operator assertion, not automatic provider verification. Decision audit omits event/recipient/channel identities; terminal timestamps reset at the decision.
- Offline validation&colon; scripts/Test-Repository.ps1 passed 55/55 tests, audit 0, typecheck/build, Bicep and diff checks; focused review/retention 23/23, independent review suite 14/14, permission schema and five managed component hashes exact. Canonical integration passed 55/55 plus build and permission schema after baseline parity checks.
- Real Azure Table test in the selected lab passed nine assertions&colon; exact account/pinned actor, table setup, bounded paginated redacted list, requeue/stable replay, accepted/suppressed payload and creation-time preservation with new terminal timestamps, stale-ETag atomic rejection with no decision audit, retention exclusions, and the actual Windows read-only CLI. Synthetic records only; no notification transport or recipient-visible delivery claim.
- Independently reviewed provisioning, private harness and cleanup were used for a new receipt-bound disposable account. Cleanup state deleted-and-verified&colon; account-scoped test role and resource group removed, with group/resource/direct-role absence verified. The first preflight stopped before mutation because the directory CLI command rejected --subscription; reviewed replacement used cached subscription-bound Storage-token identity without exposing tokens.
- Permission metadata records operator Table Data Reader/Contributor requirements without automatic grants. Existing deployment-validation 1.1.1 and notification-contracts 1.0.0 pins preserved. Reviewed preservation branch codex/auth-review-backlog-20261003; hosted CI, template release and human delivery acceptance remain separate.
- Frozen live evidence binding&colon; result SHA-256 59d44e7b39e8631fb445a861f030d653ee862a676125ff7d4a823cd2d4b82d4a; harness ce3bbddad4ce4be651a15cddf02d5af831eda3e5d88a34908254a884dcbc76bf; source manifest 1cc83c6e1628cd5e03d875867369ce81a11bbe64028286d1c4af4bb5f78eb5be; provision 1e08666d60c66e2360387c4fcf876c0e38197ada4a24b669912b46d10fd79c8d; cleanup 5eaf306c1b8a5bdbd6e54755d63559cd49bc4d6e1b223dfc10236661944b803d.
- Final cleanup provenance independently reviewed&colon; receipt SHA-256 9b1909988295239b4f565aa8e1bb6916446fafaf7eeede399b3929c0fece8370; cleanup log 4e1213b194a28047d5d35597cd680ff267b14c6b2ad2e52407b291fe3ccb55b8. Coordinator verified group absent, zero target resources, zero matching role-assignment GUIDs, and zero direct assignments at the deleted account scope.

**Review and authorization note:**

Review AUTH-004 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-005: Add deduplication-safe retention cleanup

- **Kind:** maintenance
- **Priority:** P2
- **Status:** done
- **Wave:** 2
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

Retention must not erase the state that prevents historical redispatch.

**Scope:**

- src/core.ts
- src/index.ts
- src/state.ts
- src/retention.ts
- tests/core.test.ts
- tests/state.test.ts
- scripts/Test-RetentionState.ts
- infra/main.bicep
- infra/main.parameters.json
- infra/resources.bicep
- package.json
- docs/deployment.md
- docs/operations.md
- docs/privacy.md

**Acceptance:**

- Separate short-lived operational detail from durable deduplication markers.
- Fixtures prove delayed retry and overlapping windows cannot resurrect a notification after cleanup.

**Validation:**

- pwsh -File ./scripts/Test-Repository.ps1
- Check changed-file Prettier formatting and exact reviewed file hashes.
- After explicit lab-test authorization&colon; run npm run test&colon;retention-live with a disposable identity-only Storage account, explicit subscription and private receipt; verify tenant through az account show before token selection.
- Remove only the receipt-bound disposable test account/group and scoped role; verify resource and assignment absence.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- docs/roadmap.md

**Evidence:**

- Selected for local implementation by maintainer instruction 2026-10-03&colon; coordinate backlog local-first with independent review and lab validation as needed; publication, enforcement and external delivery remain outside this code packet.
- Independent review passed final 14-file manifest 0101020349dde964f8f8c5dfde63ba32ab8ca173069683c964914133af1c65fb at base 346d9698f0b59a990d097518bc2726eba2ec8d64. Pagination and lower-cap/policy reset findings were corrected before live approval. Exact bytes integrated locally after clean target/base checks.
- Integrated validation wrapper passed npm ci &lpar;audit 0 vulnerabilities&rpar;, 37/37 tests, TypeScript/package build, Bicep compilation and git diff --check. Retention defaults disabled; no additional application permission is needed beyond existing Table data access.
- Live synthetic Azure Table test passed on the verified lab subscription&colon; bounded 2+1 compaction, three permanent same-row tombstones and replay suppression, strict cutoff, nonterminal/checkpoint/conversation preservation and actual ETag 412 race safety. First credential-harness attempt failed before table creation because CLI rejects tenant plus subscription; reviewed subscription-only retry passed.
- Disposable lab resource group, Storage resources and scoped test role were removed and their absence verified. Exact private receipts and logs are retained outside Git in the coordinator execution artifacts. No external notification transport was exercised.

**Review and authorization note:**

Review AUTH-005 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-006: Expand method coverage using sanitized real samples

- **Kind:** maintenance
- **Priority:** P2
- **Status:** proposed
- **Wave:** 2
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

Synced passkeys and administrator registration are not established by current samples.

**Scope:**

- src/
- tests/
- docs/operations.md

**Acceptance:**

- Capture sanitized paired/unpaired events and declare supported/unsupported variants.
- Fixtures reject failed, started, deleted and unrelated registrations without guessing recipient identity.

**Validation:**

- Use the offline commands in the registered validation workflow; record the exact commands, revision and results before implementation is complete.
- Run focused tests for changed behavior from tests/; fixtures do not prove live-service or endpoint behavior.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- docs/roadmap.md

**Evidence:**

- _none_

**Review and authorization note:**

Review AUTH-006 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-007: Prepare ownership-bound Teams onboarding and removal

- **Kind:** maintenance
- **Priority:** P2
- **Status:** proposed
- **Wave:** 2
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

Teams lifecycle improvements are requested while central extraction is still deferred.

**Scope:**

- src/
- tests/
- docs/operations.md

**Acceptance:**

- Catalog propagation retries reuse exact recorded app/installation IDs.
- Tenant mismatch and foreign installations fail closed; extraction waits for two consumer delivery proofs.

**Validation:**

- Use the offline commands in the registered validation workflow; record the exact commands, revision and results before implementation is complete.
- Run focused tests for changed behavior from tests/; fixtures do not prove live-service or endpoint behavior.

**Dependencies:**

- _none_

**Components:**

- notification-contracts

**Sources:**

- docs/roadmap.md

**Evidence:**

- _none_

**Review and authorization note:**

Review AUTH-007 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.

## AUTH-003: Design Azure Communication Services transport for both audiences

- **Kind:** discovery
- **Priority:** P2
- **Status:** proposed
- **Wave:** 3
- **Authorization:** local-only
- **Blocker:** _none_
- **Claim:** _none_

**Problem:**

ACS is requested in the legacy roadmap but transport, destinations and operational boundaries are not yet chosen.

**Scope:**

- docs/roadmap.md
- docs/
- azd-permissions.json

**Acceptance:**

- Choose email, SMS or separate milestones with verified regional/sender requirements, costs and delivery evidence.
- Resolve destinations only from approved recipient sources; never from a newly registered authentication method.
- Keep end-user and administrator choices independent; document opt-in, secret/identity boundary and exact permission additions before coding.

**Validation:**

- Use the offline commands in the registered validation workflow; record the exact commands, revision and results before implementation is complete.
- Run focused tests for changed behavior from tests/; fixtures do not prove live-service or endpoint behavior.

**Dependencies:**

- _none_

**Components:**

- _none_

**Sources:**

- docs/roadmap.md

**Evidence:**

- _none_

**Review and authorization note:**

Review AUTH-003 against the current repository state. Its status or authorization class is not eligible for an actionable generated handoff. Do not claim or execute it without explicit selection, satisfied dependencies, and every required authorization. Never interpret this generated view as approval.
