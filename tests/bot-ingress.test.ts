import assert from "node:assert/strict";
import test from "node:test";
import azureFunctions from "@azure/functions";
import { ManagedIdentityTeamsBot } from "../src/bot.js";
import { MAX_HTTP_BODY_BYTES } from "../src/http-body.js";
import { createTestTeamsApp } from "./teams-app-fixture.js";

const { HttpRequest } = azureFunctions;
const tenant = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
interface TestActivity {
  type: string;
  channelId: string;
  channelData: { tenant: { id: string } };
  from: { id: string; name: string; aadObjectId?: string };
  conversation: {
    id: string;
    conversationType: string;
    isGroup?: boolean;
    name: string;
  };
  recipient: { id: string; name: string };
  serviceUrl: string;
}

function fixture(realSdk = false) {
  const calls: string[] = [];
  const repository = {
    async init() {
      calls.push("init");
    },
    async getConversation() {
      calls.push("get");
      return undefined;
    },
    async putConversation() {
      calls.push("put");
    },
    async deleteConversation() {
      calls.push("delete");
    },
  };
  const sdk = realSdk ? undefined : createTestTeamsApp();
  const bot = new ManagedIdentityTeamsBot(
    "33333333-3333-4333-8333-333333333333",
    tenant,
    repository,
    { error() {} },
    sdk?.app,
  );
  return { bot, calls, sdk };
}

function request(text: string) {
  return new HttpRequest({
    url: "https://example.invalid/messages",
    method: "POST",
    body: { string: text },
  });
}

const activity = (): TestActivity => ({
  type: "installationUpdate",
  channelId: "msteams",
  channelData: { tenant: { id: tenant } },
  from: { id: "fixture-user", name: "fixture", aadObjectId: owner },
  conversation: {
    id: "fixture-conversation",
    conversationType: "personal",
    isGroup: false,
    name: "fixture",
  },
  recipient: { id: "fixture-bot", name: "fixture" },
  serviceUrl: "https://example.invalid",
});

for (const [status, body] of [
  [413, '{"text":"' + "x".repeat(MAX_HTTP_BODY_BYTES) + '"}'],
  [400, "{"],
  [400, "null"],
] as const) {
  test(`rejects ${status} input before SDK or table initialization`, async () => {
    const { bot, calls, sdk } = fixture();
    assert.equal((await bot.handle(request(body))).status, status);
    assert.equal(sdk?.requestCalls, 0);
    assert.equal(sdk?.initializationCalls, 0);
    assert.deepEqual(calls, []);
  });
}

test("the real Teams SDK rejects an unsigned activity before storage access", async () => {
  const { bot, calls } = fixture(true);
  const response = await bot.handle(request(JSON.stringify(activity())));
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("explicit false keeps SDK authentication enabled despite environment opt-out", async () => {
  const previous = process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS;
  process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS = "true";
  try {
    const { bot, calls } = fixture(true);
    const response = await bot.handle(request(JSON.stringify(activity())));
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined)
      delete process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS;
    else process.env.DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS = previous;
  }
});
