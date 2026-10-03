import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { TableClient } from "@azure/data-tables";
import { createHash } from "node:crypto";
import type { Job, State } from "./engine.js";
import { compactTerminalPayloads } from "./retention.js";

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
export const deliveryRowKey = (key: string) => hash(key);
const status = (error: unknown) =>
  (error as { statusCode?: number }).statusCode;

export async function createDeliveryEntity(
  table: TableClient,
  tenantId: string,
  job: Job,
  createdAt = new Date(),
): Promise<boolean> {
  try {
    const response = await table.createEntity({
      partitionKey: tenantId,
      rowKey: deliveryRowKey(job.key),
      kind: "delivery",
      status: "pending",
      payload: JSON.stringify(job),
      createdAt: createdAt.toISOString(),
    });
    if (response.etag) job.etag = response.etag;
    return true;
  } catch (error) {
    if (status(error) === 409) return false;
    throw error;
  }
}

export class AzureState implements State {
  private table: TableClient;
  constructor(
    endpoint: string,
    private tenantId: string,
    tableName = "AuthNotifications",
    credential: TokenCredential = new DefaultAzureCredential({
      managedIdentityClientId: process.env.MANAGED_IDENTITY_CLIENT_ID,
    }),
  ) {
    this.table = new TableClient(endpoint, tableName, credential);
  }
  async init() {
    try {
      await this.table.createTable();
    } catch (e) {
      if (status(e) !== 409) throw e;
    }
  }
  private async get(rowKey: string) {
    try {
      return await this.table.getEntity(this.tenantId, rowKey);
    } catch (e) {
      if (status(e) === 404) return undefined;
      throw e;
    }
  }
  async checkpoint() {
    const e = await this.get("checkpoint");
    return e ? { start: String(e.start), cursor: String(e.cursor) } : undefined;
  }
  async saveCheckpoint(value: { start: string; cursor: string }) {
    await this.table.upsertEntity(
      { partitionKey: this.tenantId, rowKey: "checkpoint", ...value },
      "Replace",
    );
  }
  async add(job: Job) {
    await createDeliveryEntity(this.table, this.tenantId, job);
  }
  async *pending(): AsyncGenerator<Job> {
    for await (const e of this.table.listEntities({
      queryOptions: {
        filter: `PartitionKey eq '${this.tenantId}' and kind eq 'delivery' and status eq 'pending'`,
      },
    }))
      yield { ...JSON.parse(String(e.payload)), etag: e.etag };
  }
  async claim(job: Job) {
    try {
      const response = await this.table.updateEntity(
        {
          partitionKey: this.tenantId,
          rowKey: deliveryRowKey(job.key),
          status: "sending",
          attemptedAt: new Date().toISOString(),
        },
        "Merge",
        { etag: job.etag },
      );
      if (!response.etag) throw Error("StateEtagUnavailable");
      job.etag = response.etag;
      return true;
    } catch (e) {
      if (status(e) === 412) return false;
      throw e;
    }
  }
  async finish(job: Job, deliveryStatus: string, code = "") {
    if (!job.etag) throw Error("StateEtagUnavailable");
    await this.table.updateEntity(
      {
        partitionKey: this.tenantId,
        rowKey: deliveryRowKey(job.key),
        status: deliveryStatus,
        code,
        updatedAt: new Date().toISOString(),
      },
      "Merge",
      { etag: job.etag },
    );
  }
  async getConversation(userId: string) {
    const e = await this.get(`conversation-${hash(userId.toLowerCase())}`);
    return e ? JSON.parse(String(e.reference)) : undefined;
  }
  async putConversation(userId: string, reference: unknown) {
    await this.table.upsertEntity(
      {
        partitionKey: this.tenantId,
        rowKey: `conversation-${hash(userId.toLowerCase())}`,
        kind: "conversation",
        reference: JSON.stringify(reference),
      },
      "Replace",
    );
  }
  async deleteConversation(userId: string) {
    try {
      await this.table.deleteEntity(
        this.tenantId,
        `conversation-${hash(userId.toLowerCase())}`,
      );
    } catch (e) {
      if (status(e) !== 404) throw e;
    }
  }
  async compactTerminalPayloads(
    cutoff: Date,
    limit: number,
    compactedAt = new Date(),
  ) {
    return compactTerminalPayloads(
      this.table,
      this.tenantId,
      cutoff,
      limit,
      compactedAt,
    );
  }
}
