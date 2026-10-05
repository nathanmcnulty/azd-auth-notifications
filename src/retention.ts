import { TableClient, type TableEntityResult } from "@azure/data-tables";

const status = (error: unknown) =>
  (error as { statusCode?: number }).statusCode;

export interface TerminalRetentionCandidate {
  partitionKey: string;
  rowKey: string;
  kind: string;
  status: "accepted" | "suppressed";
  updatedAt: string;
  etag: string;
}

export interface TerminalRetentionResult {
  compacted: number;
  conflicts: number;
  sweepCompleted: boolean;
  cursorConflict: boolean;
  cursorReset: boolean;
}

interface RetentionCursor {
  partitionKey: string;
  rowKey: "retention-cursor";
  kind: "retentionCursor";
  filterVersion: number;
  cutoff: string;
  pageSize: number;
  continuationToken: string;
  etag: string;
}

const RETENTION_CURSOR_ROW = "retention-cursor" as const;
const RETENTION_FILTER_VERSION = 1;

const terminalStatus = (
  value: unknown,
): value is TerminalRetentionCandidate["status"] =>
  value === "accepted" || value === "suppressed";

/**
 * Replaces delivery details with a permanent deduplication tombstone. A stale
 * ETag loses the race and leaves the newer entity unchanged.
 */
export async function compactTerminalCandidate(
  table: TableClient,
  candidate: TerminalRetentionCandidate,
  compactedAt: Date,
): Promise<boolean> {
  try {
    await table.updateEntity(
      {
        partitionKey: candidate.partitionKey,
        rowKey: candidate.rowKey,
        kind: "delivery",
        status: candidate.status,
        compactedAt: compactedAt.toISOString(),
      },
      "Replace",
      { etag: candidate.etag },
    );
    return true;
  } catch (error) {
    if (status(error) === 412) return false;
    throw error;
  }
}

function validRetentionCursor(
  entity: TableEntityResult<Record<string, unknown>>,
  tenantId: string,
): entity is TableEntityResult<Record<string, unknown>> & RetentionCursor {
  const cutoffTime =
    typeof entity.cutoff === "string" ? Date.parse(entity.cutoff) : NaN;
  return (
    entity.partitionKey === tenantId &&
    entity.rowKey === RETENTION_CURSOR_ROW &&
    entity.kind === "retentionCursor" &&
    entity.filterVersion === RETENTION_FILTER_VERSION &&
    typeof entity.cutoff === "string" &&
    Number.isFinite(cutoffTime) &&
    new Date(cutoffTime).toISOString() === entity.cutoff &&
    Number.isInteger(entity.pageSize) &&
    Number(entity.pageSize) >= 1 &&
    Number(entity.pageSize) <= 100 &&
    typeof entity.continuationToken === "string" &&
    typeof entity.etag === "string" &&
    entity.etag.length > 0
  );
}

async function retentionCursor(
  table: TableClient,
  tenantId: string,
  cutoff: string,
  pageSize: number,
): Promise<RetentionCursor | undefined> {
  try {
    const existing = await table.getEntity<Record<string, unknown>>(
      tenantId,
      RETENTION_CURSOR_ROW,
    );
    if (!validRetentionCursor(existing, tenantId)) {
      throw new Error("RetentionCursorInvalid");
    }
    return existing;
  } catch (error) {
    if (status(error) !== 404) throw error;
  }

  try {
    const cursor = {
      partitionKey: tenantId,
      rowKey: RETENTION_CURSOR_ROW,
      kind: "retentionCursor" as const,
      filterVersion: RETENTION_FILTER_VERSION,
      cutoff,
      pageSize,
      continuationToken: "",
    };
    const response = await table.createEntity(cursor);
    if (!response.etag) throw new Error("StateEtagUnavailable");
    return { ...cursor, etag: response.etag };
  } catch (error) {
    if (status(error) === 409) return undefined;
    throw error;
  }
}

async function deleteRetentionCursor(
  table: TableClient,
  cursor: RetentionCursor,
): Promise<boolean> {
  try {
    await table.deleteEntity(cursor.partitionKey, cursor.rowKey, {
      etag: cursor.etag,
    });
    return true;
  } catch (error) {
    if (status(error) === 404) return true;
    if (status(error) === 412) return false;
    throw error;
  }
}

async function advanceRetentionCursor(
  table: TableClient,
  cursor: RetentionCursor,
  continuationToken: string,
): Promise<boolean> {
  try {
    await table.updateEntity(
      {
        partitionKey: cursor.partitionKey,
        rowKey: cursor.rowKey,
        kind: cursor.kind,
        filterVersion: cursor.filterVersion,
        cutoff: cursor.cutoff,
        pageSize: cursor.pageSize,
        continuationToken,
      },
      "Replace",
      { etag: cursor.etag },
    );
    return true;
  } catch (error) {
    if (status(error) === 412) return false;
    throw error;
  }
}

/**
 * Compacts at most one bounded page. The strict updatedAt cutoff is the
 * terminal transition time, not the audit occurrence time.
 */
export async function compactTerminalPayloads(
  table: TableClient,
  tenantId: string,
  cutoff: Date,
  limit: number,
  compactedAt = new Date(),
): Promise<TerminalRetentionResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("RetentionLimitInvalid");
  }
  if (Number.isNaN(cutoff.getTime()) || Number.isNaN(compactedAt.getTime())) {
    throw new Error("RetentionDateInvalid");
  }
  const requestedCutoff = cutoff.toISOString();
  const cursor = await retentionCursor(table, tenantId, requestedCutoff, limit);
  if (!cursor) {
    return {
      compacted: 0,
      conflicts: 0,
      sweepCompleted: false,
      cursorConflict: true,
      cursorReset: false,
    };
  }
  if (Date.parse(cursor.cutoff) > cutoff.getTime() || cursor.pageSize > limit) {
    const reset = await deleteRetentionCursor(table, cursor);
    return {
      compacted: 0,
      conflicts: 0,
      sweepCompleted: false,
      cursorConflict: !reset,
      cursorReset: reset,
    };
  }
  const filter =
    `PartitionKey eq '${tenantId}' and kind eq 'delivery' and ` +
    `(status eq 'accepted' or status eq 'suppressed') and ` +
    `updatedAt lt '${cursor.cutoff}'`;
  const pages = table
    .listEntities<{
      kind: string;
      status: string;
      updatedAt: string;
    }>({
      queryOptions: {
        filter,
        select: ["PartitionKey", "RowKey", "kind", "status", "updatedAt"],
      },
    })
    .byPage({
      maxPageSize: cursor.pageSize,
      ...(cursor.continuationToken
        ? { continuationToken: cursor.continuationToken }
        : {}),
    });
  const first = await pages.next();
  const page = first.done || !first.value ? [] : first.value;

  let compacted = 0;
  let conflicts = 0;
  for (const entity of page.slice(0, cursor.pageSize)) {
    const candidate = entity as TableEntityResult<{
      kind: string;
      status: string;
      updatedAt: string;
    }>;
    const updatedAt = Date.parse(candidate.updatedAt);
    if (
      candidate.partitionKey !== tenantId ||
      candidate.kind !== "delivery" ||
      !terminalStatus(candidate.status) ||
      !Number.isFinite(updatedAt) ||
      updatedAt >= Date.parse(cursor.cutoff)
    ) {
      continue;
    }
    if (!candidate.etag) throw new Error("StateEtagUnavailable");
    const replaced = await compactTerminalCandidate(
      table,
      candidate as TerminalRetentionCandidate,
      compactedAt,
    );
    if (replaced) compacted++;
    else conflicts++;
  }
  const continuationToken = page.continuationToken;
  const progressed = continuationToken
    ? await advanceRetentionCursor(table, cursor, continuationToken)
    : await deleteRetentionCursor(table, cursor);
  return {
    compacted,
    conflicts,
    sweepCompleted: !continuationToken && progressed,
    cursorConflict: !progressed,
    cursorReset: false,
  };
}
