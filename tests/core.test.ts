import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAudit, parseConfig, planDeliveries, renderNotification } from "../src/core.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_ID = "33333333-3333-3333-3333-333333333333";

function config(overrides: Record<string, string | undefined> = {}) {
  return parseConfig({
    AZURE_TENANT_ID: TENANT_ID,
    EMAIL_SENDER_USER_ID: ADMIN_ID,
    COLLECTION_ENABLED: "true",
    PILOT_USER_IDS: USER_ID,
    ...overrides,
  });
}

function audit(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    result: "success",
    activityDateTime: "2026-09-13T12:34:56.000Z",
    activityDisplayName: "User registered security info",
    targetResources: [{ id: USER_ID, type: "User" }],
    additionalDetails: [{ key: "AuthenticationMethod", value: "Microsoft Authenticator" }],
    correlationId: "55555555-5555-5555-5555-555555555555",
    ...overrides,
  };
}

test("normalizes supported registrations from the target user, not the actor", () => {
  const registration = normalizeAudit(audit({
    initiatedBy: { user: { id: ADMIN_ID } },
  }));

  assert.deepEqual(registration, {
    id: "44444444-4444-4444-4444-444444444444",
    userId: USER_ID,
    occurredAt: "2026-09-13T12:34:56.000Z",
    method: "Microsoft Authenticator",
    correlationId: "55555555-5555-5555-5555-555555555555",
  });
});

test("rejects actor-only, malformed, and non-registration audit records", () => {
  assert.equal(normalizeAudit(audit({ targetResources: [], initiatedBy: { user: { id: USER_ID } } })), undefined);
  assert.equal(normalizeAudit(audit({ targetResources: [{ id: USER_ID, type: "User" }, { id: ADMIN_ID, type: "User" }] })), undefined);
  assert.equal(normalizeAudit(audit({ result: "failure" })), undefined);
  assert.equal(normalizeAudit(audit({ activityDateTime: "not a date" })), undefined);
  assert.equal(normalizeAudit(audit({ activityDisplayName: "Update user" })), undefined);
});

test("uses the device-bound passkey event and excludes its generic paired event", () => {
  const passkey = normalizeAudit(audit({
    activityDisplayName: "Add Passkey (device-bound)",
    additionalDetails: [],
  }));
  const genericPair = normalizeAudit(audit({
    activityDisplayName: "User registered security info",
    additionalDetails: [{ key: "AuthenticationMethod", value: "Passkey" }],
  }));

  assert.equal(passkey?.method, "Passkey (device-bound)");
  assert.equal(genericPair, undefined);
});

test("never uses unrecognized authentication-detail text as notification content", () => {
  const registration = normalizeAudit(audit({
    additionalDetails: [{ key: "AuthenticationMethod", value: "+1 (555) 0100" }],
  }));

  assert.equal(registration?.method, "Authentication method");
});

test("validates delivery configuration and its pilot safety boundary", () => {
  assert.throws(() => config({ PILOT_USER_IDS: undefined }), /PILOT_USER_IDS/);
  assert.throws(() => config({ USER_CHANNELS: "sms" }), /USER_CHANNELS/);
  assert.throws(() => config({ EMAIL_SENDER_USER_ID: "not-a-uuid" }), /EMAIL_SENDER_USER_ID/);
  assert.throws(() => config({ AUDIT_OVERLAP_MINUTES: "1441" }), /AUDIT_OVERLAP_MINUTES/);
  assert.throws(() => config({ HELPDESK_TEXT: "<b>call us</b>" }), /HELPDESK_TEXT/);

  const allUsers = config({ PILOT_USER_IDS: undefined, ALL_USERS: "true", ADMIN_CHANNELS: "teams", ADMIN_USER_IDS: ADMIN_ID });
  assert.equal(allUsers.allUsers, true);
  assert.deepEqual(allUsers.userChannels, ["email"]);
  assert.equal(allUsers.overlapMinutes, 60);

  const noAdminChannels = config({ ADMIN_CHANNELS: "" });
  assert.deepEqual(noAdminChannels.adminChannels, []);
});

test("plans in-scope user and admin deliveries without duplicate recipient-channel sends", () => {
  const registration = normalizeAudit(audit())!;
  const deliveries = planDeliveries(registration, config({
    USER_CHANNELS: "email,teams",
    ADMIN_CHANNELS: "email,teams",
    ADMIN_USER_IDS: `${USER_ID},${ADMIN_ID}`,
  }));

  assert.deepEqual(deliveries, [
    { key: `${registration.id}:email:${USER_ID}`, audience: "user", channel: "email", recipientId: USER_ID },
    { key: `${registration.id}:teams:${USER_ID}`, audience: "user", channel: "teams", recipientId: USER_ID },
    { key: `${registration.id}:email:${ADMIN_ID}`, audience: "admin", channel: "email", recipientId: ADMIN_ID },
    { key: `${registration.id}:teams:${ADMIN_ID}`, audience: "admin", channel: "teams", recipientId: ADMIN_ID },
  ]);

  assert.deepEqual(planDeliveries(registration, config({ PILOT_USER_IDS: ADMIN_ID })), []);
});

test("renders escaped user and admin notifications with a fixed security-info link", () => {
  const registration = {
    id: "44444444-4444-4444-4444-444444444444",
    userId: USER_ID,
    occurredAt: "2026-09-13T12:34:56.000Z",
    method: "<unsafe>",
  };
  const notification = renderNotification(registration, "admin", "contact <helpdesk>");

  assert.match(notification.html, /&lt;unsafe&gt;/);
  assert.match(notification.html, /&lt;helpdesk&gt;/);
  assert.match(notification.html, new RegExp(USER_ID));
  assert.match(notification.text, new RegExp(USER_ID));
  assert.doesNotMatch(notification.text, /Review your security information/);
  assert.equal((notification.card.body as Array<Record<string, unknown>>)[1].type, "FactSet");

  const userNotification = renderNotification(registration, "user", "contact helpdesk");
  assert.match(userNotification.html, /https:\/\/mysignins\.microsoft\.com\/security-info/);
});
