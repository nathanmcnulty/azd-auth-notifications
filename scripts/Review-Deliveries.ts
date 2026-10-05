import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { TableClient } from "@azure/data-tables";
import { AzureCliCredential, type TokenCredential } from "@azure/identity";

import {
  applyReviewDecision,
  listReviewDeliveries,
  reviewActorFromAccessToken,
  validateAzureAccountContext,
} from "../src/review.js";

const execFileAsync = promisify(execFile);
const TABLE_NAME = /^[A-Za-z][A-Za-z0-9]{2,62}$/;
const TABLE_HOST = /^[a-z0-9]{3,24}\.table\.core\.windows\.net$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReviewCliArguments {
  subscriptionId: string;
  tenantId: string;
  tableEndpoint: string;
  tableName: string;
  limit: number;
  continuationToken?: string;
  action?: "accept" | "suppress" | "requeue";
  deliveryRowKey?: string;
  etag?: string;
  decisionId?: string;
  reasonCode?: string;
  evidenceReference?: string;
  acknowledgeDuplicateRisk: boolean;
}

function optionValues(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith("--") || result.has(name)) {
      throw new Error("ReviewArgumentsInvalid");
    }
    if (name === "--acknowledge-duplicate-risk") {
      result.set(name, true);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error("ReviewArgumentsInvalid");
    }
    result.set(name, value);
  }
  return result;
}

function required(options: Map<string, string | true>, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string") throw new Error("ReviewArgumentsInvalid");
  return value;
}

function optional(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("ReviewArgumentsInvalid");
  return value;
}

function uuid(options: Map<string, string | true>, name: string): string {
  const value = required(options, name);
  if (!UUID.test(value)) throw new Error("ReviewArgumentsInvalid");
  return value.toLowerCase();
}

export function parseReviewArguments(argv: string[]): ReviewCliArguments {
  const options = optionValues(argv);
  const known = new Set([
    "--subscription-id",
    "--tenant-id",
    "--table-endpoint",
    "--table-name",
    "--limit",
    "--continuation-token",
    "--action",
    "--delivery-row-key",
    "--etag",
    "--decision-id",
    "--reason-code",
    "--evidence-reference",
    "--acknowledge-duplicate-risk",
  ]);
  if ([...options.keys()].some((name) => !known.has(name))) {
    throw new Error("ReviewArgumentsInvalid");
  }
  const action = optional(options, "--action");
  if (
    action !== undefined &&
    action !== "accept" &&
    action !== "suppress" &&
    action !== "requeue"
  ) {
    throw new Error("ReviewArgumentsInvalid");
  }
  const mutationNames = [
    "--delivery-row-key",
    "--etag",
    "--decision-id",
    "--reason-code",
    "--evidence-reference",
    "--acknowledge-duplicate-risk",
  ];
  if (!action && mutationNames.some((name) => options.has(name))) {
    throw new Error("ReviewArgumentsInvalid");
  }
  if (action && options.has("--continuation-token")) {
    throw new Error("ReviewArgumentsInvalid");
  }
  const tableEndpoint = required(options, "--table-endpoint");
  const endpoint = new URL(tableEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    !TABLE_HOST.test(endpoint.hostname) ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new Error("ReviewTableEndpointInvalid");
  }
  const tableName = optional(options, "--table-name") ?? "AuthNotifications";
  if (!TABLE_NAME.test(tableName)) throw new Error("ReviewTableNameInvalid");
  const limitText = optional(options, "--limit") ?? "25";
  if (!/^[0-9]{1,3}$/.test(limitText)) throw new Error("ReviewLimitInvalid");
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) throw new Error("ReviewLimitInvalid");
  return {
    subscriptionId: uuid(options, "--subscription-id"),
    tenantId: uuid(options, "--tenant-id"),
    tableEndpoint: endpoint.toString(),
    tableName,
    limit,
    ...(optional(options, "--continuation-token")
      ? { continuationToken: optional(options, "--continuation-token") }
      : {}),
    ...(action
      ? {
          action,
          deliveryRowKey: required(options, "--delivery-row-key"),
          etag: required(options, "--etag"),
          decisionId: required(options, "--decision-id"),
          reasonCode: required(options, "--reason-code"),
          ...(optional(options, "--evidence-reference")
            ? {
                evidenceReference: optional(options, "--evidence-reference"),
              }
            : {}),
        }
      : {}),
    acknowledgeDuplicateRisk: options.has("--acknowledge-duplicate-risk"),
  };
}

async function azureAccount(subscriptionId: string): Promise<unknown> {
  try {
    if (!UUID.test(subscriptionId))
      throw new Error("ReviewSubscriptionInvalid");
    const windows = process.platform === "win32";
    const result = await execFileAsync(
      windows ? (process.env.ComSpec ?? "cmd.exe") : "az",
      windows
        ? [
            "/d",
            "/s",
            "/c",
            `az.cmd account show --subscription ${subscriptionId} --output json`,
          ]
        : [
            "account",
            "show",
            "--subscription",
            subscriptionId,
            "--output",
            "json",
          ],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("ReviewAzureAccountContextUnavailable");
  }
}

async function main() {
  const args = parseReviewArguments(process.argv.slice(2));
  validateAzureAccountContext(
    await azureAccount(args.subscriptionId),
    args.subscriptionId,
    args.tenantId,
  );
  const credential = new AzureCliCredential({
    subscription: args.subscriptionId,
    processTimeoutInMs: 30_000,
  });
  const accessToken = await credential.getToken(
    "https://storage.azure.com/.default",
  );
  if (!accessToken) throw new Error("ReviewAccessTokenUnavailable");
  const actor = reviewActorFromAccessToken(accessToken.token, args.tenantId);
  const pinnedCredential: TokenCredential = {
    getToken: async () => accessToken,
  };
  const table = new TableClient(
    args.tableEndpoint,
    args.tableName,
    pinnedCredential,
  );
  if (!args.action) {
    const page = await listReviewDeliveries(
      table,
      args.tenantId,
      args.limit,
      args.continuationToken,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          subscriptionId: args.subscriptionId.toLowerCase(),
          tenantId: args.tenantId.toLowerCase(),
          tableName: args.tableName,
          count: page.items.length,
          items: page.items,
          ...(page.nextContinuationToken
            ? { nextContinuationToken: page.nextContinuationToken }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const result = await applyReviewDecision(table, {
    tenantId: args.tenantId,
    deliveryRowKey: args.deliveryRowKey!,
    etag: args.etag!,
    decisionId: args.decisionId!,
    action: args.action,
    reasonCode: args.reasonCode!,
    ...(args.evidenceReference
      ? { evidenceReference: args.evidenceReference }
      : {}),
    acknowledgeDuplicateRisk: args.acknowledgeDuplicateRisk,
    actor,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const code =
      error instanceof Error ? error.message : "ReviewWorkflowFailed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
