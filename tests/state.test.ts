import assert from "node:assert/strict";
import test from "node:test";
import type { TableClient } from "@azure/data-tables";

import type { Job } from "../src/engine.js";
import { compactTerminalPayloads } from "../src/retention.js";
import { createDeliveryEntity, deliveryRowKey } from "../src/state.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const CUTOFF = new Date("2026-10-01T00:00:00.000Z");
const COMPACTED_AT = new Date("2026-10-03T00:00:00.000Z");

function storageError(statusCode: number) {
  return Object.assign(new Error(`Storage${statusCode}`), { statusCode });
}

function candidate(
  rowKey: string,
  status: string,
  updatedAt = "2026-09-01T00:00:00.000Z",
  overrides: Record<string, unknown> = {},
) {
  return {
    partitionKey: TENANT_ID,
    rowKey,
    kind: "delivery",
    status,
    updatedAt,
    etag: `etag-${rowKey}`,
    ...overrides,
  };
}

interface Page {
  rows: Array<Record<string, unknown>>;
  continuationToken?: string;
}

function fakeTable(
  pages: Record<string, Page>,
  updateDelivery: (
    entity: Record<string, unknown>,
    mode: string,
    options: { etag?: string },
  ) => Promise<unknown>,
  initialCursor?: Record<string, unknown>,
) {
  let cursor = initialCursor;
  let cursorVersion = 1;
  const listCalls: Array<{
    options: Record<string, unknown>;
    pageOptions: Record<string, unknown>;
  }> = [];
  let cursorCreates = 0;
  let cursorDeletes = 0;
  const table = {
    async getEntity(_partitionKey: string, rowKey: string) {
      if (rowKey !== "retention-cursor" || !cursor) throw storageError(404);
      return { ...cursor };
    },
    async createEntity(entity: Record<string, unknown>) {
      if (entity.rowKey !== "retention-cursor") {
        throw new Error("unexpected delivery create");
      }
      if (cursor) throw storageError(409);
      cursorCreates++;
      cursor = { ...entity, etag: `cursor-${cursorVersion}` };
      return { etag: `cursor-${cursorVersion}` };
    },
    listEntities(options: Record<string, unknown>) {
      return {
        byPage(pageOptions: Record<string, unknown>) {
          listCalls.push({ options, pageOptions });
          const token = String(pageOptions.continuationToken ?? "");
          const configured = pages[token] ?? { rows: [] };
          const value = [...configured.rows] as Array<
            Record<string, unknown>
          > & {
            continuationToken?: string;
          };
          value.continuationToken = configured.continuationToken;
          return {
            async next() {
              return { done: false, value };
            },
          };
        },
      };
    },
    async updateEntity(
      entity: Record<string, unknown>,
      mode: string,
      options: { etag?: string },
    ) {
      if (entity.rowKey !== "retention-cursor") {
        return updateDelivery(entity, mode, options);
      }
      if (!cursor || options.etag !== cursor.etag) throw storageError(412);
      cursorVersion++;
      cursor = { ...entity, etag: `cursor-${cursorVersion}` };
      return { etag: `cursor-${cursorVersion}` };
    },
    async deleteEntity(
      _partitionKey: string,
      rowKey: string,
      options: { etag?: string },
    ) {
      if (rowKey !== "retention-cursor" || !cursor) throw storageError(404);
      if (options.etag !== cursor.etag) throw storageError(412);
      cursorDeletes++;
      cursor = undefined;
      return {};
    },
  } as unknown as TableClient;
  return {
    table,
    observed: () => ({
      cursor: cursor ? { ...cursor } : undefined,
      cursorCreates,
      cursorDeletes,
      listCalls: [...listCalls],
    }),
  };
}

test("compacts only old terminal deliveries and clears a completed sweep", async () => {
  const updates: Array<{
    entity: Record<string, unknown>;
    mode: string;
    etag?: string;
  }> = [];
  const fake = fakeTable(
    {
      "": {
        rows: [
          candidate("accepted", "accepted"),
          candidate("suppressed", "suppressed"),
          candidate("review", "review"),
          candidate("exact-cutoff", "accepted", CUTOFF.toISOString()),
          candidate("conversation", "accepted", "2026-09-01T00:00:00.000Z", {
            kind: "conversation",
          }),
        ],
      },
    },
    async (entity, mode, options) => {
      updates.push({ entity, mode, etag: options.etag });
      return {};
    },
  );

  const result = await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    CUTOFF,
    10,
    COMPACTED_AT,
  );

  assert.deepEqual(result, {
    compacted: 2,
    conflicts: 0,
    sweepCompleted: true,
    cursorConflict: false,
    cursorReset: false,
  });
  assert.deepEqual(
    updates.map((item) => item.entity.rowKey),
    ["accepted", "suppressed"],
  );
  for (const update of updates) {
    assert.equal(update.mode, "Replace");
    assert.equal(update.etag, `etag-${update.entity.rowKey}`);
    assert.deepEqual(Object.keys(update.entity).sort(), [
      "compactedAt",
      "kind",
      "partitionKey",
      "rowKey",
      "status",
    ]);
  }
  const observed = fake.observed();
  assert.equal(observed.cursor, undefined);
  assert.equal(observed.cursorCreates, 1);
  assert.equal(observed.cursorDeletes, 1);
  assert.deepEqual(observed.listCalls[0].pageOptions, { maxPageSize: 10 });
  const filter = String(
    (observed.listCalls[0].options.queryOptions as { filter?: string }).filter,
  );
  assert.match(filter, /updatedAt lt '2026-10-01T00:00:00.000Z'/);
});

test("an empty page continuation resumes on the next bounded invocation", async () => {
  const updates: string[] = [];
  const fake = fakeTable(
    {
      "": { rows: [], continuationToken: "next-page" },
      "next-page": { rows: [candidate("later", "accepted")] },
    },
    async (entity) => {
      updates.push(String(entity.rowKey));
      return {};
    },
  );

  const first = await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    CUTOFF,
    2,
    COMPACTED_AT,
  );
  assert.deepEqual(first, {
    compacted: 0,
    conflicts: 0,
    sweepCompleted: false,
    cursorConflict: false,
    cursorReset: false,
  });
  assert.equal(fake.observed().cursor?.continuationToken, "next-page");

  const laterRequestedCutoff = new Date("2026-10-01T00:05:00.000Z");
  const second = await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    laterRequestedCutoff,
    2,
    COMPACTED_AT,
  );
  assert.equal(second.compacted, 1);
  assert.equal(second.sweepCompleted, true);
  assert.deepEqual(updates, ["later"]);
  const calls = fake.observed().listCalls;
  assert.deepEqual(calls[1].pageOptions, {
    maxPageSize: 2,
    continuationToken: "next-page",
  });
  const resumedFilter = String(
    (calls[1].options.queryOptions as { filter?: string }).filter,
  );
  assert.match(resumedFilter, /updatedAt lt '2026-10-01T00:00:00.000Z'/);
});

test("a longer retention policy resets a newer active sweep before querying", async () => {
  const cursor = {
    partitionKey: TENANT_ID,
    rowKey: "retention-cursor",
    kind: "retentionCursor",
    filterVersion: 1,
    cutoff: "2026-10-01T00:00:00.000Z",
    pageSize: 25,
    continuationToken: "next-page",
    etag: "cursor-existing",
  };
  const fake = fakeTable({}, async () => ({}), cursor);

  const result = await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    new Date("2026-09-01T00:00:00.000Z"),
    25,
    COMPACTED_AT,
  );

  assert.deepEqual(result, {
    compacted: 0,
    conflicts: 0,
    sweepCompleted: false,
    cursorConflict: false,
    cursorReset: true,
  });
  assert.equal(fake.observed().cursor, undefined);
  assert.equal(fake.observed().listCalls.length, 0);
});

test("a lower current cap resets a larger active page before querying", async () => {
  const fake = fakeTable(
    { "": { rows: [], continuationToken: "next-page" } },
    async () => ({}),
  );
  await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    CUTOFF,
    10,
    COMPACTED_AT,
  );
  assert.equal(fake.observed().cursor?.pageSize, 10);
  assert.equal(fake.observed().listCalls.length, 1);

  const result = await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    new Date("2026-10-01T00:05:00.000Z"),
    2,
    COMPACTED_AT,
  );

  assert.equal(result.cursorReset, true);
  assert.equal(result.compacted, 0);
  assert.equal(fake.observed().cursor, undefined);
  assert.equal(fake.observed().listCalls.length, 1);
});

test("malformed retention cursor state fails closed", async () => {
  const fake = fakeTable({}, async () => ({}), {
    partitionKey: TENANT_ID,
    rowKey: "retention-cursor",
    kind: "retentionCursor",
    filterVersion: 999,
    cutoff: CUTOFF.toISOString(),
    pageSize: 25,
    continuationToken: "",
    etag: "cursor-invalid",
  });

  await assert.rejects(
    compactTerminalPayloads(fake.table, TENANT_ID, CUTOFF, 25, COMPACTED_AT),
    /RetentionCursorInvalid/,
  );
  assert.equal(fake.observed().listCalls.length, 0);
});

test("a parseable but noncanonical cursor cutoff fails closed", async () => {
  const fake = fakeTable({}, async () => ({}), {
    partitionKey: TENANT_ID,
    rowKey: "retention-cursor",
    kind: "retentionCursor",
    filterVersion: 1,
    cutoff: "2026-10-01T00:00:00Z",
    pageSize: 25,
    continuationToken: "",
    etag: "cursor-invalid-cutoff",
  });

  await assert.rejects(
    compactTerminalPayloads(fake.table, TENANT_ID, CUTOFF, 25, COMPACTED_AT),
    /RetentionCursorInvalid/,
  );
  assert.equal(fake.observed().listCalls.length, 0);
});

test("stale delivery ETags lose safely and page work stays hard capped", async () => {
  const attempted: string[] = [];
  const fake = fakeTable(
    {
      "": {
        rows: [
          candidate("race", "accepted"),
          candidate("second", "accepted"),
          candidate("third", "accepted"),
        ],
      },
    },
    async (entity) => {
      attempted.push(String(entity.rowKey));
      throw storageError(412);
    },
  );

  const result = await compactTerminalPayloads(
    fake.table,
    TENANT_ID,
    CUTOFF,
    2,
    COMPACTED_AT,
  );

  assert.equal(result.compacted, 0);
  assert.equal(result.conflicts, 2);
  assert.deepEqual(attempted, ["race", "second"]);
  assert.equal(fake.observed().listCalls.length, 1);
});

test("an eligible row without an ETag fails closed before cursor progress", async () => {
  const fake = fakeTable(
    {
      "": {
        rows: [
          candidate("missing-etag", "accepted", "2026-09-01T00:00:00.000Z", {
            etag: undefined,
          }),
        ],
        continuationToken: "must-not-save",
      },
    },
    async () => {
      throw new Error("unexpected update");
    },
  );

  await assert.rejects(
    compactTerminalPayloads(fake.table, TENANT_ID, CUTOFF, 1, COMPACTED_AT),
    /StateEtagUnavailable/,
  );
  assert.equal(fake.observed().cursor?.continuationToken, "");
});

test("a tombstone keeps the hashed row occupied during delayed replay", async () => {
  const value: Job = {
    key: "audit-1:email:22222222-2222-4222-8222-222222222222",
    audience: "user",
    channel: "email",
    recipientId: "22222222-2222-4222-8222-222222222222",
    registration: {
      id: "audit-1",
      userId: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-09-01T00:00:00.000Z",
      method: "Passkey (device-bound)",
    },
    status: "pending",
  };
  const rowKey = deliveryRowKey(value.key);
  const tombstone = {
    partitionKey: TENANT_ID,
    rowKey,
    kind: "delivery",
    status: "accepted",
    compactedAt: COMPACTED_AT.toISOString(),
  };
  const entities = new Map([[rowKey, tombstone]]);
  const table = {
    async createEntity(entity: Record<string, unknown>) {
      assert.equal(entity.rowKey, rowKey);
      if (entities.has(String(entity.rowKey))) throw storageError(409);
      entities.set(String(entity.rowKey), entity as typeof tombstone);
      return { etag: "created" };
    },
  } as unknown as TableClient;

  assert.equal(
    await createDeliveryEntity(table, TENANT_ID, value, COMPACTED_AT),
    false,
  );
  assert.deepEqual(entities.get(rowKey), {
    partitionKey: TENANT_ID,
    rowKey,
    kind: "delivery",
    status: "accepted",
    compactedAt: COMPACTED_AT.toISOString(),
  });
  assert.equal(value.etag, undefined);
});
