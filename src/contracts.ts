import { createHash } from "node:crypto";
import type { Audience, Channel, Delivery, Registration } from "./core.js";

export const AUTHENTICATION_METHOD_EVENT_TYPE =
  "microsoftGraph.authenticationMethodRegistration";
export const DIRECTORY_AUDIT_SOURCE = "microsoftGraph.directoryAudit";

export interface NotificationEnvironment {
  name: string;
  tenantId: string;
  subscriptionId?: string;
  resourceGroup?: string;
}

export interface NotificationEnvelope {
  schemaVersion: "1.0";
  eventId: string;
  eventType: typeof AUTHENTICATION_METHOD_EVENT_TYPE;
  source: typeof DIRECTORY_AUDIT_SOURCE;
  occurredAt: string;
  severity: "informational";
  correlationId: string;
  isTest: boolean;
  environment: NotificationEnvironment;
  data: { method: string };
}

export interface NotificationDeliveryResult {
  schemaVersion: "1.0";
  eventId: string;
  eventType: typeof AUTHENTICATION_METHOD_EVENT_TYPE;
  correlationId: string;
  idempotencyKey: string;
  route: {
    id: string;
    audience: Audience;
    transport: "email.graph" | "teams.bot";
  };
  status: "succeeded" | "alreadyDelivered" | "skipped" | "failed";
  attempt: number;
  recordedAt: string;
  isTest: boolean;
  environment: NotificationEnvironment;
  evidence: { providerCode?: string };
  skipReason?: "initialBaseline" | "suppressedByPolicy" | "concurrentDelivery";
  failure?: {
    category:
      | "authentication"
      | "authorization"
      | "throttled"
      | "timeout"
      | "transientProvider"
      | "invalidRequest"
      | "destinationUnavailable"
      | "unknown";
    retryable: boolean;
    code?: string;
  };
}

function safeCorrelationId(registration: Registration): string {
  const candidate = registration.correlationId?.replace(/[\u0000-\u001f]/g, "");
  return candidate && candidate.length <= 256 ? candidate : registration.id;
}

function routeId(delivery: Delivery): string {
  const recipientHash = createHash("sha256")
    .update(delivery.recipientId.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `${delivery.audience}.${delivery.channel}.${recipientHash}`;
}

function idempotencyKey(
  eventId: string,
  route: string,
  tenantId: string,
): string {
  return createHash("sha256")
    .update(
      `${tenantId}\n${AUTHENTICATION_METHOD_EVENT_TYPE}\n${eventId}\n${route}`,
    )
    .digest("hex");
}

function providerCode(code: string | undefined): string | undefined {
  return code && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(code)
    ? code
    : undefined;
}

export function toNotificationEnvelope(
  registration: Registration,
  environment: NotificationEnvironment,
  isTest = false,
): NotificationEnvelope {
  return {
    schemaVersion: "1.0",
    eventId: registration.id,
    eventType: AUTHENTICATION_METHOD_EVENT_TYPE,
    source: DIRECTORY_AUDIT_SOURCE,
    occurredAt: registration.occurredAt,
    severity: "informational",
    correlationId: safeCorrelationId(registration),
    isTest,
    environment,
    data: { method: registration.method },
  };
}

export function toNotificationDeliveryResult(
  registration: Registration,
  delivery: Delivery,
  status: "accepted" | "review" | "suppressed",
  code: string | undefined,
  environment: NotificationEnvironment,
  recordedAt = new Date().toISOString(),
  isTest = false,
): NotificationDeliveryResult {
  const id = routeId(delivery);
  const result: NotificationDeliveryResult = {
    schemaVersion: "1.0",
    eventId: registration.id,
    eventType: AUTHENTICATION_METHOD_EVENT_TYPE,
    correlationId: safeCorrelationId(registration),
    idempotencyKey: idempotencyKey(registration.id, id, environment.tenantId),
    route: {
      id,
      audience: delivery.audience,
      transport: delivery.channel === "email" ? "email.graph" : "teams.bot",
    },
    status:
      status === "accepted"
        ? "succeeded"
        : status === "suppressed"
          ? "skipped"
          : "failed",
    attempt: 1,
    recordedAt,
    isTest,
    environment,
    evidence: {},
  };
  const safeProviderCode = providerCode(code);
  if (safeProviderCode) result.evidence.providerCode = safeProviderCode;
  if (status === "suppressed") result.skipReason = "suppressedByPolicy";
  if (status === "review") {
    result.failure = {
      category: "unknown",
      retryable: false,
      ...(safeProviderCode ? { code: safeProviderCode } : {}),
    };
  }
  return result;
}
