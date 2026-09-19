import assert from "node:assert/strict";
import test from "node:test";
import {
  toNotificationDeliveryResult,
  toNotificationEnvelope,
} from "../src/contracts.js";

const environment = {
  name: "auth-notifications-dev",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "22222222-2222-2222-2222-222222222222",
  resourceGroup: "rg-auth-notifications-dev",
};
const registration = {
  id: "33333333-3333-3333-3333-333333333333",
  userId: "44444444-4444-4444-4444-444444444444",
  occurredAt: "2026-09-13T12:34:56.000Z",
  method: "Microsoft Authenticator",
  correlationId: "55555555-5555-5555-5555-555555555555",
};
const delivery = {
  key: "internal-key",
  audience: "user" as const,
  channel: "teams" as const,
  recipientId: registration.userId,
};

test("maps registration events to the shared notification envelope", () => {
  assert.deepEqual(toNotificationEnvelope(registration, environment), {
    schemaVersion: "1.0",
    eventId: registration.id,
    eventType: "microsoftGraph.authenticationMethodRegistration",
    source: "microsoftGraph.directoryAudit",
    occurredAt: registration.occurredAt,
    severity: "informational",
    correlationId: registration.correlationId,
    isTest: false,
    environment,
    data: { method: registration.method },
  });
});

test("maps provider outcomes to safe shared delivery results", () => {
  const result = toNotificationDeliveryResult(
    registration,
    delivery,
    "review",
    "TeamsHttp403_BotDisabledByAdmin",
    environment,
    "2026-09-13T12:35:00.000Z",
    true,
  );

  assert.equal(result.route.transport, "teams.bot");
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.category, "unknown");
  assert.equal(result.failure?.retryable, false);
  assert.equal(result.evidence.providerCode, "TeamsHttp403_BotDisabledByAdmin");
  assert.match(result.idempotencyKey, /^[0-9a-f]{64}$/);
  assert.equal(result.isTest, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(registration.userId));
});

test("maps suppressed work to a policy skip without exposing the recipient", () => {
  const result = toNotificationDeliveryResult(
    registration,
    { ...delivery, audience: "admin" },
    "suppressed",
    "DeliveryNoLongerEligible",
    environment,
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "suppressedByPolicy");
  assert.equal(result.route.audience, "admin");
  assert.equal(result.evidence.providerCode, "DeliveryNoLongerEligible");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(registration.userId));
});
