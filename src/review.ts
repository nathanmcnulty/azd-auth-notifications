import type {
  TableClient,
  TableEntityResult,
  TransactionAction,
} from "@azure/data-tables";

import { deliveryRowKey } from "./state.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_KEY = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_EVIDENCE_REFERENCE =
  /^(ProviderCase|ExchangeTrace|TeamsActivity|GraphRequest):[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MAX_ETAG_LENGTH = 256;
const MAX_CONTINUATION_TOKEN_LENGTH = 4096;

type DeliveryStatus =
  "pending" | "sending" | "accepted" | "review" | "suppressed";

type ReviewAction = "accept" | "suppress" | "requeue";
type ReviewDecisionSource =
  | "provider-confirmed-delivered"
  | "provider-confirmed-not-delivered"
  | "operator-override"
  | "operator-suppress";

interface DeliveryIdentity {
  key: string;
  auditId: string;
  recipientId: string;
  audience: "user" | "admin";
  channel: "email" | "teams";
}

interface ReviewDecisionAudit extends Record<string, unknown> {
  partitionKey: string;
  rowKey: string;
  kind: "reviewDecision";
  decisionId: string;
  deliveryRowKey: string;
  priorStatus: "review";
  priorEtag: string;
  targetStatus: "accepted" | "suppressed" | "pending";
  action: ReviewAction;
  decisionSource: ReviewDecisionSource;
  reasonCode: string;
  evidenceReference: string;
  actorObjectId: string;
  tokenTenantId: string;
}

export interface ReviewItem {
  tenantId: string;
  deliveryRowKey: string;
  status: "review";
  etag: string;
  auditId: string;
  recipientId: string;
  audience: "user" | "admin";
  channel: "email" | "teams";
  providerCode?: string;
  updatedAt: string;
}

export interface ReviewPage {
  items: ReviewItem[];
  nextContinuationToken?: string;
}

export interface ReviewActor {
  tenantId: string;
  objectId: string;
}

export interface ReviewDecisionRequest {
  tenantId: string;
  deliveryRowKey: string;
  etag: string;
  decisionId: string;
  action: ReviewAction;
  reasonCode: string;
  evidenceReference?: string;
  acknowledgeDuplicateRisk?: boolean;
  actor: ReviewActor;
}

export interface ReviewDecisionResult {
  tenantId: string;
  deliveryRowKey: string;
  decisionId: string;
  action: ReviewAction;
  targetStatus: "accepted" | "suppressed" | "pending";
  alreadyApplied: boolean;
}

const statusCode = (error: unknown) =>
  (error as { statusCode?: number }).statusCode;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactUuid(value: string, code: string): string {
  if (!UUID.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function exactRowKey(value: string): string {
  if (!ROW_KEY.test(value)) throw new Error("ReviewDeliveryRowInvalid");
  return value;
}

function exactEtag(value: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_ETAG_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("ReviewEtagInvalid");
  }
  return value;
}

function exactContinuationToken(value: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_CONTINUATION_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("ReviewContinuationTokenInvalid");
  }
  return value;
}

function safeCode(value: string, code: string): string {
  if (!SAFE_CODE.test(value)) throw new Error(code);
  return value;
}

function safeReference(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SAFE_EVIDENCE_REFERENCE.test(value)) {
    throw new Error("ReviewEvidenceReferenceInvalid");
  }
  return value;
}

function exactDate(value: unknown): string {
  if (typeof value !== "string") throw new Error("ReviewUpdatedAtInvalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("ReviewUpdatedAtInvalid");
  }
  return value;
}

function deliveryIdentity(payload: unknown, rowKey: string): DeliveryIdentity {
  if (typeof payload !== "string") throw new Error("ReviewPayloadInvalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("ReviewPayloadInvalid");
  }
  const job = record(parsed);
  const registration = record(job?.registration);
  const key = job?.key;
  const auditId = registration?.id;
  const recipientId = job?.recipientId;
  const audience = job?.audience;
  const channel = job?.channel;
  const normalizedRecipientId =
    typeof recipientId === "string" ? recipientId.toLowerCase() : undefined;
  if (
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > 1024 ||
    deliveryRowKey(key) !== rowKey ||
    typeof auditId !== "string" ||
    !SAFE_IDENTIFIER.test(auditId) ||
    typeof recipientId !== "string" ||
    !UUID.test(recipientId) ||
    (audience !== "user" && audience !== "admin") ||
    (channel !== "email" && channel !== "teams") ||
    key !== `${auditId}:${channel}:${normalizedRecipientId}`
  ) {
    throw new Error("ReviewPayloadInvalid");
  }
  return {
    key,
    auditId,
    recipientId: normalizedRecipientId!,
    audience,
    channel,
  };
}

function deliveryEntity(
  entity: TableEntityResult<Record<string, unknown>>,
  tenantId: string,
  rowKey: string,
): { identity: DeliveryIdentity; status: DeliveryStatus; etag: string } {
  if (
    entity.partitionKey !== tenantId ||
    entity.rowKey !== rowKey ||
    entity.kind !== "delivery" ||
    !["pending", "sending", "accepted", "review", "suppressed"].includes(
      String(entity.status),
    )
  ) {
    throw new Error("ReviewDeliveryStateInvalid");
  }
  if (typeof entity.etag !== "string") {
    throw new Error("StateEtagUnavailable");
  }
  return {
    identity: deliveryIdentity(entity.payload, rowKey),
    status: entity.status as DeliveryStatus,
    etag: exactEtag(entity.etag),
  };
}

function decisionShape(request: ReviewDecisionRequest): {
  targetStatus: ReviewDecisionAudit["targetStatus"];
  source: ReviewDecisionSource;
  evidenceReference: string;
} {
  const evidenceReference = safeReference(request.evidenceReference);
  const acknowledged = request.acknowledgeDuplicateRisk === true;
  if (request.action === "accept") {
    if (!evidenceReference || acknowledged) {
      throw new Error("ReviewAcceptRequiresProviderEvidence");
    }
    return {
      targetStatus: "accepted",
      source: "provider-confirmed-delivered",
      evidenceReference,
    };
  }
  if (request.action === "suppress") {
    if (evidenceReference || acknowledged) {
      throw new Error("ReviewSuppressEvidenceInvalid");
    }
    return {
      targetStatus: "suppressed",
      source: "operator-suppress",
      evidenceReference: "",
    };
  }
  if (request.action === "requeue") {
    if (Boolean(evidenceReference) === acknowledged) {
      throw new Error("ReviewRequeueDecisionInvalid");
    }
    return {
      targetStatus: "pending",
      source: evidenceReference
        ? "provider-confirmed-not-delivered"
        : "operator-override",
      evidenceReference: evidenceReference ?? "",
    };
  }
  throw new Error("ReviewActionInvalid");
}

function auditRowKey(deliveryKey: string, decisionId: string): string {
  return `review-${deliveryKey}-${decisionId}`;
}

function sameAudit(
  actual: TableEntityResult<Record<string, unknown>>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => actual[key] === value,
  );
}

async function getAudit(
  table: TableClient,
  tenantId: string,
  rowKey: string,
): Promise<TableEntityResult<Record<string, unknown>> | undefined> {
  try {
    return await table.getEntity<Record<string, unknown>>(tenantId, rowKey);
  } catch (error) {
    if (statusCode(error) === 404) return undefined;
    throw error;
  }
}

async function appliedResult(
  table: TableClient,
  request: ReviewDecisionRequest,
  shape: ReturnType<typeof decisionShape>,
  expectedAudit?: ReviewDecisionAudit,
): Promise<ReviewDecisionResult | undefined> {
  const rowKey = auditRowKey(request.deliveryRowKey, request.decisionId);
  const existingAudit = await getAudit(table, request.tenantId, rowKey);
  if (!existingAudit) return undefined;
  const expectedRequest: Record<string, unknown> = {
    partitionKey: request.tenantId,
    rowKey,
    kind: "reviewDecision",
    decisionId: request.decisionId,
    deliveryRowKey: request.deliveryRowKey,
    priorStatus: "review",
    priorEtag: request.etag,
    targetStatus: shape.targetStatus,
    action: request.action,
    decisionSource: shape.source,
    reasonCode: request.reasonCode,
    evidenceReference: shape.evidenceReference,
    actorObjectId: request.actor.objectId,
    tokenTenantId: request.actor.tenantId,
  };
  if (
    !sameAudit(existingAudit, expectedRequest) ||
    (expectedAudit && !sameAudit(existingAudit, expectedAudit))
  ) {
    throw new Error("ReviewDecisionIdConflict");
  }
  return {
    tenantId: request.tenantId,
    deliveryRowKey: request.deliveryRowKey,
    decisionId: request.decisionId,
    action: request.action,
    targetStatus: shape.targetStatus,
    alreadyApplied: true,
  };
}

export async function listReviewDeliveries(
  table: TableClient,
  tenantId: string,
  limit = 25,
  continuationToken?: string,
): Promise<ReviewPage> {
  tenantId = exactUuid(tenantId, "ReviewTenantInvalid");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ReviewLimitInvalid");
  }
  const validatedContinuationToken = continuationToken
    ? exactContinuationToken(continuationToken)
    : undefined;
  const pages = table
    .listEntities<Record<string, unknown>>({
      queryOptions: {
        filter:
          `PartitionKey eq '${tenantId}' and kind eq 'delivery' and ` +
          `status eq 'review'`,
        select: [
          "PartitionKey",
          "RowKey",
          "kind",
          "status",
          "payload",
          "code",
          "updatedAt",
        ],
      },
    })
    .byPage({
      maxPageSize: limit,
      ...(validatedContinuationToken
        ? { continuationToken: validatedContinuationToken }
        : {}),
    });
  const first = await pages.next();
  const entities =
    first.done || !first.value ? [] : first.value.slice(0, limit);
  const items = entities.map((entity) => {
    const rowKey = exactRowKey(String(entity.rowKey));
    const parsed = deliveryEntity(entity, tenantId, rowKey);
    if (parsed.status !== "review") {
      throw new Error("ReviewDeliveryNotActionable");
    }
    const providerCode =
      typeof entity.code === "string" && SAFE_CODE.test(entity.code)
        ? entity.code
        : undefined;
    return {
      tenantId,
      deliveryRowKey: rowKey,
      status: "review" as const,
      etag: parsed.etag,
      auditId: parsed.identity.auditId,
      recipientId: parsed.identity.recipientId,
      audience: parsed.identity.audience,
      channel: parsed.identity.channel,
      ...(providerCode ? { providerCode } : {}),
      updatedAt: exactDate(entity.updatedAt),
    };
  });
  const nextContinuationToken =
    !first.done && first.value?.continuationToken
      ? exactContinuationToken(first.value.continuationToken)
      : undefined;
  return {
    items,
    ...(nextContinuationToken ? { nextContinuationToken } : {}),
  };
}

export async function applyReviewDecision(
  table: TableClient,
  value: ReviewDecisionRequest,
  now = new Date(),
): Promise<ReviewDecisionResult> {
  const request: ReviewDecisionRequest = {
    ...value,
    tenantId: exactUuid(value.tenantId, "ReviewTenantInvalid"),
    deliveryRowKey: exactRowKey(value.deliveryRowKey),
    etag: exactEtag(value.etag),
    decisionId: exactUuid(value.decisionId, "ReviewDecisionIdInvalid"),
    reasonCode: safeCode(value.reasonCode, "ReviewReasonCodeInvalid"),
    actor: {
      tenantId: exactUuid(value.actor.tenantId, "ReviewActorTenantInvalid"),
      objectId: exactUuid(value.actor.objectId, "ReviewActorObjectInvalid"),
    },
  };
  if (request.actor.tenantId !== request.tenantId) {
    throw new Error("ReviewActorTenantMismatch");
  }
  const shape = decisionShape(request);
  const decisionTime = exactDate(now.toISOString());
  const existing = await appliedResult(table, request, shape);
  if (existing) return existing;
  const entity = await table.getEntity<Record<string, unknown>>(
    request.tenantId,
    request.deliveryRowKey,
  );
  const parsed = deliveryEntity(
    entity,
    request.tenantId,
    request.deliveryRowKey,
  );
  const audit: ReviewDecisionAudit = {
    partitionKey: request.tenantId,
    rowKey: auditRowKey(request.deliveryRowKey, request.decisionId),
    kind: "reviewDecision",
    decisionId: request.decisionId,
    deliveryRowKey: request.deliveryRowKey,
    priorStatus: "review",
    priorEtag: request.etag,
    targetStatus: shape.targetStatus,
    action: request.action,
    decisionSource: shape.source,
    reasonCode: request.reasonCode,
    evidenceReference: shape.evidenceReference,
    actorObjectId: request.actor.objectId,
    tokenTenantId: request.actor.tenantId,
  };
  if (parsed.status !== "review") {
    throw new Error("ReviewDeliveryNotActionable");
  }
  if (parsed.etag !== request.etag) {
    throw new Error("ReviewEtagMismatch");
  }

  const update = {
    partitionKey: request.tenantId,
    rowKey: request.deliveryRowKey,
    status: shape.targetStatus,
    code: shape.targetStatus === "pending" ? "" : request.reasonCode,
    reviewDecisionId: request.decisionId,
    reviewDecisionSource: shape.source,
    ...(shape.targetStatus === "accepted" || shape.targetStatus === "suppressed"
      ? { updatedAt: decisionTime }
      : {}),
  };
  const actions: TransactionAction[] = [
    ["update", update, "Merge", { etag: request.etag }],
    ["create", audit],
  ];
  try {
    await table.submitTransaction(actions);
  } catch (error) {
    const afterFailure = await appliedResult(table, request, shape, audit);
    if (afterFailure) return afterFailure;
    if (statusCode(error) === 409 || statusCode(error) === 412) {
      throw new Error("ReviewDecisionConflict");
    }
    throw error;
  }
  return {
    tenantId: request.tenantId,
    deliveryRowKey: request.deliveryRowKey,
    decisionId: request.decisionId,
    action: request.action,
    targetStatus: shape.targetStatus,
    alreadyApplied: false,
  };
}

export function reviewActorFromAccessToken(
  accessToken: string,
  expectedTenantId: string,
): ReviewActor {
  expectedTenantId = exactUuid(expectedTenantId, "ReviewTenantInvalid");
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new Error("ReviewAccessTokenInvalid");
  let claims: Record<string, unknown> | undefined;
  try {
    claims = record(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("ReviewAccessTokenInvalid");
  }
  const tenantId =
    typeof claims?.tid === "string"
      ? exactUuid(claims.tid, "ReviewAccessTokenTenantInvalid")
      : undefined;
  const objectId =
    typeof claims?.oid === "string"
      ? exactUuid(claims.oid, "ReviewAccessTokenActorInvalid")
      : undefined;
  if (
    claims?.aud !== "https://storage.azure.com" &&
    claims?.aud !== "https://storage.azure.com/"
  ) {
    throw new Error("ReviewAccessTokenAudienceInvalid");
  }
  if (!tenantId || tenantId !== expectedTenantId) {
    throw new Error("ReviewAccessTokenTenantMismatch");
  }
  if (!objectId) throw new Error("ReviewAccessTokenActorInvalid");
  return { tenantId, objectId };
}

export function validateAzureAccountContext(
  value: unknown,
  expectedSubscriptionId: string,
  expectedTenantId: string,
): void {
  const account = record(value);
  const subscriptionId = exactUuid(
    expectedSubscriptionId,
    "ReviewSubscriptionInvalid",
  );
  const tenantId = exactUuid(expectedTenantId, "ReviewTenantInvalid");
  if (
    typeof account?.id !== "string" ||
    typeof account.tenantId !== "string" ||
    account.state !== "Enabled" ||
    account.id.toLowerCase() !== subscriptionId ||
    account.tenantId.toLowerCase() !== tenantId
  ) {
    throw new Error("ReviewAzureAccountMismatch");
  }
}
