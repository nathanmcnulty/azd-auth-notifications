import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AzureCliCredential } from "@azure/identity";
import { TableClient } from "@azure/data-tables";

import type { Job } from "../src/engine.js";
import {
  compactTerminalCandidate,
  type TerminalRetentionCandidate,
} from "../src/retention.js";
import { AzureState, deliveryRowKey } from "../src/state.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const endpoint = required("AUTH_RETENTION_TEST_ENDPOINT");
const tableName = required("AUTH_RETENTION_TEST_TABLE");
const tenantId = required("AZURE_TENANT_ID");
const subscriptionId = required("AZURE_SUBSCRIPTION_ID");
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    tenantId,
  ) ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    subscriptionId,
  )
) {
  throw new Error("AZURE_TENANT_ID and AZURE_SUBSCRIPTION_ID must be UUIDs.");
}
if (process.env.AUTH_RETENTION_TEST_CONFIRM_DISPOSABLE !== "true") {
  throw new Error(
    "Set AUTH_RETENTION_TEST_CONFIRM_DISPOSABLE=true only for an owned disposable table.",
  );
}
if (
  !/^https:\/\/[a-z0-9-]+\.table\.core\.windows\.net$/i.test(endpoint) ||
  !/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(tableName) ||
  tableName.toLowerCase() === "authnotifications"
) {
  throw new Error("The test endpoint or disposable table name is invalid.");
}

const partitionKey =
  process.env.AUTH_RETENTION_TEST_PARTITION?.trim() ||
  `retention-${randomUUID()}`;
if (!/^[A-Za-z0-9-]{1,200}$/.test(partitionKey)) {
  throw new Error("AUTH_RETENTION_TEST_PARTITION is invalid.");
}
const credential = new AzureCliCredential({
  subscription: subscriptionId,
});
const table = new TableClient(endpoint, tableName, credential);
const state = new AzureState(endpoint, partitionKey, tableName, credential);
await state.init();

const now = new Date();
const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const old = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString();
const userId = "11111111-1111-4111-8111-111111111111";

function job(name: string): Job {
  return {
    key: `${name}:email:${userId}`,
    audience: "user",
    channel: "email",
    recipientId: userId,
    registration: {
      id: name,
      userId,
      occurredAt: old,
      method: "Synthetic method",
      correlationId: "22222222-2222-4222-8222-222222222222",
    },
    status: "pending",
  };
}

async function seedDelivery(
  value: Job,
  deliveryStatus: string,
  updatedAt: string,
) {
  await table.createEntity({
    partitionKey,
    rowKey: deliveryRowKey(value.key),
    kind: "delivery",
    status: deliveryStatus,
    payload: JSON.stringify(value),
    createdAt: old,
    attemptedAt: old,
    updatedAt,
    code: "SyntheticResult",
  });
}

async function entity(rowKey: string) {
  return table.getEntity<Record<string, unknown>>(partitionKey, rowKey);
}

const accepted = job("accepted");
const suppressed = job("suppressed");
const delayedReplay = job("delayed-replay");
const pending = job("pending");
const sending = job("sending");
const review = job("review");
const exactCutoff = job("exact-cutoff");

await seedDelivery(accepted, "accepted", old);
await seedDelivery(suppressed, "suppressed", old);
await seedDelivery(delayedReplay, "accepted", old);
await seedDelivery(pending, "pending", old);
await seedDelivery(sending, "sending", old);
await seedDelivery(review, "review", old);
await seedDelivery(exactCutoff, "accepted", cutoff.toISOString());
await table.createEntity({
  partitionKey,
  rowKey: "checkpoint",
  start: old,
  cursor: old,
});
await table.createEntity({
  partitionKey,
  rowKey: "conversation-synthetic",
  kind: "conversation",
  reference: JSON.stringify({ serviceUrl: "https://invalid.example" }),
});

const first = await state.compactTerminalPayloads(cutoff, 2, now);
assert.equal(first.compacted, 2, "the first cleanup must honor the hard cap");
assert.equal(first.conflicts, 0);
assert.equal(first.sweepCompleted, false);
const second = await state.compactTerminalPayloads(cutoff, 10, now);
assert.equal(second.compacted, 1, "the next cycle must finish eligible rows");
assert.equal(second.conflicts, 0);
assert.equal(second.sweepCompleted, true);
await assert.rejects(
  table.getEntity(partitionKey, "retention-cursor"),
  (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
  "a completed sweep must remove its retention cursor",
);

for (const [value, expectedStatus] of [
  [accepted, "accepted"],
  [suppressed, "suppressed"],
  [delayedReplay, "accepted"],
] as const) {
  const retained = await entity(deliveryRowKey(value.key));
  assert.equal(retained.kind, "delivery");
  assert.equal(retained.status, expectedStatus);
  for (const removed of [
    "payload",
    "code",
    "attemptedAt",
    "updatedAt",
    "createdAt",
    "key",
    "recipientId",
  ]) {
    assert.equal(retained[removed], undefined, `${removed} must be removed`);
  }
  await state.add(value);
  const duplicate = await entity(deliveryRowKey(value.key));
  assert.equal(duplicate.status, retained.status);
  assert.equal(
    duplicate.payload,
    undefined,
    "a replay must not recreate payload",
  );
}

for (const [value, deliveryStatus] of [
  [pending, "pending"],
  [sending, "sending"],
  [review, "review"],
] as const) {
  const untouched = await entity(deliveryRowKey(value.key));
  assert.equal(untouched.status, deliveryStatus);
  assert.equal(typeof untouched.payload, "string");
}
assert.equal(
  typeof (await entity(deliveryRowKey(exactCutoff.key))).payload,
  "string",
  "an exact-cutoff row must not be selected by the strict-before filter",
);
assert.equal((await entity("checkpoint")).cursor, old);
assert.equal(
  typeof (await entity("conversation-synthetic")).reference,
  "string",
);

const raced = job("etag-race");
await seedDelivery(raced, "accepted", old);
const stale = await entity(deliveryRowKey(raced.key));
assert.ok(stale.etag);
await table.updateEntity(
  {
    partitionKey,
    rowKey: deliveryRowKey(raced.key),
    status: "review",
    code: "ConcurrentReview",
  },
  "Merge",
  { etag: stale.etag },
);
const raceWon = await compactTerminalCandidate(
  table,
  stale as unknown as TerminalRetentionCandidate,
  now,
);
assert.equal(raceWon, false, "a stale cleanup ETag must lose the race");
const reviewed = await entity(deliveryRowKey(raced.key));
assert.equal(reviewed.status, "review");
assert.equal(typeof reviewed.payload, "string");

console.log(
  JSON.stringify({
    status: "pass",
    table: tableName,
    partition: partitionKey,
    boundedFirstCycle: first.compacted,
    remainingSecondCycle: second.compacted,
    etagRacePreserved: true,
    tombstonesPreserved: 3,
  }),
);
