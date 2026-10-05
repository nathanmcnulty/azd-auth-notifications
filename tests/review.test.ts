import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { TableClient, TransactionAction } from "@azure/data-tables";

import type { Job } from "../src/engine.js";
import { parseReviewArguments } from "../scripts/Review-Deliveries.js";
import {
  applyReviewDecision,
  listReviewDeliveries,
  reviewActorFromAccessToken,
  validateAzureAccountContext,
  type ReviewDecisionRequest,
} from "../src/review.js";
import { deliveryRowKey } from "../src/state.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const RECIPIENT_ID = "44444444-4444-4444-8444-444444444444";
const DECISION_ID = "55555555-5555-4555-8555-555555555555";

function storageError(statusCode: number) {
  return Object.assign(new Error(`Storage${statusCode}`), { statusCode });
}

const job: Job = {
  key: `audit-1:email:${RECIPIENT_ID}`,
  audience: "user",
  channel: "email",
  recipientId: RECIPIENT_ID,
  registration: {
    id: "audit-1",
    userId: RECIPIENT_ID,
    occurredAt: "2026-10-03T00:00:00.000Z",
    method: "Passkey (device-bound)",
  },
  status: "review",
};
const ROW_KEY = deliveryRowKey(job.key);

function delivery(status = "review", overrides: Record<string, unknown> = {}) {
  return {
    partitionKey: TENANT_ID,
    rowKey: ROW_KEY,
    kind: "delivery",
    status,
    payload: JSON.stringify({
      ...job,
      internalContact: "secret@example.invalid",
    }),
    code: "Timeout",
    updatedAt: "2026-10-03T01:02:03.000Z",
    etag: 'W/"review-etag"',
    ...overrides,
  };
}

class FakeTable {
  entities = new Map<string, Record<string, unknown>>();
  listOptions: Record<string, unknown> | undefined;
  pageOptions: Record<string, unknown> | undefined;
  transactions: TransactionAction[][] = [];
  failBeforeStatus: number | undefined;
  failAfterApply = false;
  nextContinuationToken: string | undefined;

  constructor(entity = delivery()) {
    this.entities.set(String(entity.rowKey), { ...entity });
  }

  asClient() {
    return this as unknown as TableClient;
  }

  async getEntity(partitionKey: string, rowKey: string) {
    const entity = this.entities.get(rowKey);
    if (!entity || entity.partitionKey !== partitionKey)
      throw storageError(404);
    return { ...entity };
  }

  listEntities(options: Record<string, unknown>) {
    this.listOptions = options;
    return {
      byPage: (pageOptions: Record<string, unknown>) => {
        this.pageOptions = pageOptions;
        const rows = [...this.entities.values()]
          .filter((entity) => entity.status === "review")
          .map((entity) => ({ ...entity }));
        Object.assign(rows, {
          continuationToken: this.nextContinuationToken,
        });
        return {
          async next() {
            return { done: false, value: rows };
          },
        };
      },
    };
  }

  async submitTransaction(actions: TransactionAction[]) {
    this.transactions.push(actions);
    if (this.failBeforeStatus) throw storageError(this.failBeforeStatus);
    const copy = new Map(
      [...this.entities.entries()].map(([key, value]) => [key, { ...value }]),
    );
    for (const action of actions) {
      const [kind, entity] = action;
      const rowKey = String(entity.rowKey);
      if (kind === "create") {
        if (copy.has(rowKey)) throw storageError(409);
        copy.set(rowKey, {
          ...entity,
          etag: 'W/"audit-etag"',
          timestamp: "2026-10-03T01:03:00.000Z",
        });
        continue;
      }
      if (kind !== "update") throw new Error("UnexpectedTransactionAction");
      const current = copy.get(rowKey);
      if (!current) throw storageError(404);
      const options = action[3];
      if (options?.etag !== current.etag) throw storageError(412);
      copy.set(rowKey, { ...current, ...entity, etag: 'W/"next-etag"' });
    }
    this.entities = copy;
    if (this.failAfterApply) {
      this.failAfterApply = false;
      throw new Error("LostTransactionResponse");
    }
    return { subResponses: [] };
  }
}

function request(
  overrides: Partial<ReviewDecisionRequest> = {},
): ReviewDecisionRequest {
  return {
    tenantId: TENANT_ID,
    deliveryRowKey: ROW_KEY,
    etag: 'W/"review-etag"',
    decisionId: DECISION_ID,
    action: "requeue",
    reasonCode: "ProviderConfirmedNotDelivered",
    evidenceReference: "ProviderCase:Graph-1234",
    actor: { tenantId: TENANT_ID, objectId: ACTOR_ID },
    ...overrides,
  };
}

test("listing is bounded and returns only the named review identity fields", async () => {
  const fake = new FakeTable();
  fake.nextContinuationToken = "opaque-next-token";
  const page = await listReviewDeliveries(
    fake.asClient(),
    TENANT_ID,
    7,
    "opaque-current-token",
  );

  assert.equal(page.items.length, 1);
  assert.equal(page.nextContinuationToken, "opaque-next-token");
  assert.deepEqual(page.items[0], {
    tenantId: TENANT_ID,
    deliveryRowKey: ROW_KEY,
    status: "review",
    etag: 'W/"review-etag"',
    auditId: "audit-1",
    recipientId: RECIPIENT_ID,
    audience: "user",
    channel: "email",
    providerCode: "Timeout",
    updatedAt: "2026-10-03T01:02:03.000Z",
  });
  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /payload|Passkey|secret@example|method/i);
  assert.deepEqual(fake.pageOptions, {
    maxPageSize: 7,
    continuationToken: "opaque-current-token",
  });
  const query = fake.listOptions?.queryOptions as {
    filter: string;
    select: string[];
  };
  assert.match(query.filter, /status eq 'review'/);
  assert.deepEqual(query.select, [
    "PartitionKey",
    "RowKey",
    "kind",
    "status",
    "payload",
    "code",
    "updatedAt",
  ]);
});

test("listing rejects unsafe continuation tokens", async () => {
  await assert.rejects(
    listReviewDeliveries(
      new FakeTable().asClient(),
      TENANT_ID,
      25,
      "bad\ntoken",
    ),
    /ReviewContinuationTokenInvalid/,
  );
});

test("listing rejects a delivery whose payload does not hash to its row", async () => {
  const fake = new FakeTable(delivery("review", { rowKey: "0".repeat(64) }));
  await assert.rejects(
    listReviewDeliveries(fake.asClient(), TENANT_ID),
    /ReviewPayloadInvalid/,
  );
});

test("listing rejects a self-hashing key whose displayed identity disagrees", async () => {
  const mismatchedKey = `another-audit:email:${RECIPIENT_ID}`;
  const mismatched = delivery("review", {
    rowKey: deliveryRowKey(mismatchedKey),
    payload: JSON.stringify({ ...job, key: mismatchedKey }),
  });
  await assert.rejects(
    listReviewDeliveries(new FakeTable(mismatched).asClient(), TENANT_ID),
    /ReviewPayloadInvalid/,
  );
});

test("provider-confirmed delivery becomes accepted with an immutable audit row", async () => {
  const fake = new FakeTable();
  const decisionTime = new Date("2026-10-03T02:00:00.000Z");
  const result = await applyReviewDecision(
    fake.asClient(),
    request({
      action: "accept",
      reasonCode: "ProviderConfirmedDelivered",
      evidenceReference: "ExchangeTrace:1234",
    }),
    decisionTime,
  );

  assert.equal(result.targetStatus, "accepted");
  assert.equal(result.alreadyApplied, false);
  assert.equal(fake.transactions.length, 1);
  const [update, create] = fake.transactions[0];
  assert.deepEqual(update, [
    "update",
    {
      partitionKey: TENANT_ID,
      rowKey: ROW_KEY,
      status: "accepted",
      code: "ProviderConfirmedDelivered",
      reviewDecisionId: DECISION_ID,
      reviewDecisionSource: "provider-confirmed-delivered",
      updatedAt: decisionTime.toISOString(),
    },
    "Merge",
    { etag: 'W/"review-etag"' },
  ]);
  assert.equal(create[0], "create");
  assert.deepEqual(create[1], {
    partitionKey: TENANT_ID,
    rowKey: `review-${ROW_KEY}-${DECISION_ID}`,
    kind: "reviewDecision",
    decisionId: DECISION_ID,
    deliveryRowKey: ROW_KEY,
    priorStatus: "review",
    priorEtag: 'W/"review-etag"',
    targetStatus: "accepted",
    action: "accept",
    decisionSource: "provider-confirmed-delivered",
    reasonCode: "ProviderConfirmedDelivered",
    evidenceReference: "ExchangeTrace:1234",
    actorObjectId: ACTOR_ID,
    tokenTenantId: TENANT_ID,
  });
  assert.equal(fake.entities.get(ROW_KEY)?.payload, delivery().payload);
  assert.equal(
    fake.entities.get(ROW_KEY)?.updatedAt,
    decisionTime.toISOString(),
  );
});

test("operator suppression is distinct from delivered evidence", async () => {
  const fake = new FakeTable();
  const decisionTime = new Date("2026-10-03T03:00:00.000Z");
  const result = await applyReviewDecision(
    fake.asClient(),
    request({
      action: "suppress",
      reasonCode: "OperatorDeclinedReplay",
      evidenceReference: undefined,
    }),
    decisionTime,
  );

  assert.equal(result.targetStatus, "suppressed");
  const audit = fake.entities.get(`review-${ROW_KEY}-${DECISION_ID}`);
  assert.equal(audit?.decisionSource, "operator-suppress");
  assert.equal(audit?.evidenceReference, "");
  assert.equal(
    fake.entities.get(ROW_KEY)?.updatedAt,
    decisionTime.toISOString(),
  );
  assert.equal(audit?.timestamp, "2026-10-03T01:03:00.000Z");
  assert.equal(audit?.auditId, undefined);
  assert.equal(audit?.recipientId, undefined);
  assert.equal(audit?.audience, undefined);
  assert.equal(audit?.channel, undefined);
});

test("requeue requires provider-not-delivered evidence or duplicate-risk acknowledgement", async () => {
  const invalid = new FakeTable();
  await assert.rejects(
    applyReviewDecision(
      invalid.asClient(),
      request({ evidenceReference: undefined }),
    ),
    /ReviewRequeueDecisionInvalid/,
  );
  await assert.rejects(
    applyReviewDecision(
      new FakeTable().asClient(),
      request({ acknowledgeDuplicateRisk: true }),
    ),
    /ReviewRequeueDecisionInvalid/,
  );

  const override = new FakeTable();
  const result = await applyReviewDecision(
    override.asClient(),
    request({
      evidenceReference: undefined,
      acknowledgeDuplicateRisk: true,
      reasonCode: "OperatorAcceptedDuplicateRisk",
    }),
  );
  assert.equal(result.targetStatus, "pending");
  assert.equal(override.entities.get(ROW_KEY)?.status, "pending");
  assert.equal(
    override.entities.get(ROW_KEY)?.updatedAt,
    "2026-10-03T01:02:03.000Z",
  );
  assert.equal(
    override.entities.get(`review-${ROW_KEY}-${DECISION_ID}`)?.decisionSource,
    "operator-override",
  );
});

test("only review rows are actionable", async () => {
  for (const status of ["pending", "sending", "accepted", "suppressed"]) {
    const fake = new FakeTable(delivery(status));
    await assert.rejects(
      applyReviewDecision(fake.asClient(), request()),
      /ReviewDeliveryNotActionable/,
    );
    assert.equal(fake.transactions.length, 0);
  }
});

test("wrong actor tenant, stale ETag, unsafe evidence, and unsafe reason fail closed", async () => {
  await assert.rejects(
    applyReviewDecision(
      new FakeTable().asClient(),
      request({
        actor: {
          tenantId: "66666666-6666-4666-8666-666666666666",
          objectId: ACTOR_ID,
        },
      }),
    ),
    /ReviewActorTenantMismatch/,
  );
  await assert.rejects(
    applyReviewDecision(
      new FakeTable().asClient(),
      request({ etag: 'W/"stale"' }),
    ),
    /ReviewEtagMismatch/,
  );
  await assert.rejects(
    applyReviewDecision(
      new FakeTable().asClient(),
      request({ evidenceReference: "https://example.invalid/?sig=secret" }),
    ),
    /ReviewEvidenceReferenceInvalid/,
  );
  await assert.rejects(
    applyReviewDecision(
      new FakeTable().asClient(),
      request({ reasonCode: "free form explanation" }),
    ),
    /ReviewReasonCodeInvalid/,
  );
});

test("conditional transaction conflicts leave the review row unchanged", async () => {
  const fake = new FakeTable();
  fake.failBeforeStatus = 412;
  await assert.rejects(
    applyReviewDecision(fake.asClient(), request()),
    /ReviewDecisionConflict/,
  );
  assert.equal(fake.entities.get(ROW_KEY)?.status, "review");
  assert.equal(fake.entities.size, 1);
});

test("a caller-stable decision ID recovers a lost response without a second transition", async () => {
  const fake = new FakeTable();
  fake.failAfterApply = true;
  const first = await applyReviewDecision(fake.asClient(), request());
  assert.equal(first.alreadyApplied, true);
  const second = await applyReviewDecision(fake.asClient(), request());
  assert.equal(second.alreadyApplied, true);
  assert.equal(fake.transactions.length, 1);
  const audit = fake.entities.get(`review-${ROW_KEY}-${DECISION_ID}`)!;
  audit.timestamp = "2026-10-03T23:59:59.000Z";
  audit.etag = 'W/"service-metadata-changed"';
  const afterServiceMetadata = await applyReviewDecision(
    fake.asClient(),
    request(),
  );
  assert.equal(afterServiceMetadata.alreadyApplied, true);
  assert.equal(fake.transactions.length, 1);

  fake.entities.set(ROW_KEY, {
    partitionKey: TENANT_ID,
    rowKey: ROW_KEY,
    kind: "delivery",
    status: "accepted",
    compactedAt: "2026-10-04T00:00:00.000Z",
    etag: 'W/"compacted"',
  });
  const afterNormalProgress = await applyReviewDecision(
    fake.asClient(),
    request(),
  );
  assert.equal(afterNormalProgress.alreadyApplied, true);
  assert.equal(fake.transactions.length, 1);

  await assert.rejects(
    applyReviewDecision(
      fake.asClient(),
      request({ reasonCode: "DifferentDecision" }),
    ),
    /ReviewDecisionIdConflict/,
  );
  assert.equal(fake.transactions.length, 1);
});

test("access-token actor and fresh account checks bind the exact tenant and subscription", () => {
  const token = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        aud: "https://storage.azure.com",
        tid: TENANT_ID,
        oid: ACTOR_ID,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  assert.deepEqual(reviewActorFromAccessToken(token, TENANT_ID), {
    tenantId: TENANT_ID,
    objectId: ACTOR_ID,
  });
  validateAzureAccountContext(
    { id: SUBSCRIPTION_ID, tenantId: TENANT_ID, state: "Enabled" },
    SUBSCRIPTION_ID,
    TENANT_ID,
  );
  assert.throws(
    () =>
      validateAzureAccountContext(
        { id: SUBSCRIPTION_ID, tenantId: ACTOR_ID, state: "Enabled" },
        SUBSCRIPTION_ID,
        TENANT_ID,
      ),
    /ReviewAzureAccountMismatch/,
  );
});

test("the operator CLI has no transport or automatic dispatch dependency", async () => {
  const source = await readFile("scripts/Review-Deliveries.ts", "utf8");
  assert.doesNotMatch(source, /\.\/graph|\.\/bot|dispatch\s*\(|send\s*\(/);
  assert.match(source, /AzureCliCredential/);
  assert.match(source, /account show --subscription/);
  assert.match(source, /az\.cmd account show --subscription/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.match(source, /getToken: async \(\) => accessToken/);
});

test("the operator CLI defaults to a bounded read-only list and requires complete action coordinates", () => {
  const base = [
    "--subscription-id",
    SUBSCRIPTION_ID,
    "--tenant-id",
    TENANT_ID,
    "--table-endpoint",
    "https://examplestorage.table.core.windows.net/",
  ];
  const listed = parseReviewArguments(base);
  assert.equal(listed.action, undefined);
  assert.equal(listed.limit, 25);
  assert.equal(listed.acknowledgeDuplicateRisk, false);
  const continued = parseReviewArguments([
    ...base,
    "--continuation-token",
    "opaque-token",
  ]);
  assert.equal(continued.continuationToken, "opaque-token");
  assert.throws(
    () => parseReviewArguments([...base, "--delivery-row-key", ROW_KEY]),
    /ReviewArgumentsInvalid/,
  );
  assert.throws(
    () => parseReviewArguments([...base, "--action", "requeue"]),
    /ReviewArgumentsInvalid/,
  );
  assert.throws(
    () =>
      parseReviewArguments([...base.slice(0, -1), "https://attacker.invalid/"]),
    /ReviewTableEndpointInvalid/,
  );
  assert.throws(
    () =>
      parseReviewArguments([
        ...base.slice(2),
        "--subscription-id",
        `${SUBSCRIPTION_ID} & whoami`,
      ]),
    /ReviewArgumentsInvalid/,
  );
  const action = parseReviewArguments([
    ...base,
    "--action",
    "requeue",
    "--delivery-row-key",
    ROW_KEY,
    "--etag",
    'W/"review-etag"',
    "--decision-id",
    DECISION_ID,
    "--reason-code",
    "OperatorAcceptedDuplicateRisk",
    "--acknowledge-duplicate-risk",
  ]);
  assert.equal(action.action, "requeue");
  assert.equal(action.acknowledgeDuplicateRisk, true);
  assert.throws(
    () =>
      parseReviewArguments([
        ...base,
        "--continuation-token",
        "opaque-token",
        "--action",
        "requeue",
        "--delivery-row-key",
        ROW_KEY,
        "--etag",
        'W/"review-etag"',
        "--decision-id",
        DECISION_ID,
        "--reason-code",
        "OperatorAcceptedDuplicateRisk",
        "--acknowledge-duplicate-risk",
      ]),
    /ReviewArgumentsInvalid/,
  );
});
