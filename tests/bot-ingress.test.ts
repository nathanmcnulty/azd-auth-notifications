import assert from "node:assert/strict";
import test from "node:test";
import azureFunctions from "@azure/functions";
const { HttpRequest } = azureFunctions;
import { CloudAdapter, type Activity, type TurnContext } from "botbuilder";
import { ManagedIdentityTeamsBot } from "../src/bot.js";
import { MAX_HTTP_BODY_BYTES } from "../src/http-body.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
function fixture() {
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
  const bot = new ManagedIdentityTeamsBot(
    "33333333-3333-4333-8333-333333333333",
    tenant,
    repository,
    { error() {} },
  );
  return { bot, calls };
}
function request(text: string) {
  return new HttpRequest({
    url: "https://example.invalid/messages",
    method: "POST",
    body: { string: text },
  });
}
const activity = (): Partial<Activity> => ({
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
  test(`rejects ${status} input before SDK or table initialization`, async (t) => {
    let sdkCalls = 0;
    t.mock.method(CloudAdapter.prototype, "process", async () => {
      sdkCalls++;
    });
    const { bot, calls } = fixture();
    assert.equal((await bot.handle(request(body))).status, status);
    assert.equal(sdkCalls, 0);
    assert.deepEqual(calls, []);
  });
}

test("the real SDK rejects an unsigned activity without table initialization", async () => {
  const { bot, calls } = fixture();
  const response = await bot.handle(request(JSON.stringify(activity())));
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

for (const scope of [
  "valid",
  "foreign-tenant",
  "group",
  "foreign-channel",
  "missing-owner",
  "remove",
]) {
  test(`authenticated callback preserves conversation scope: ${scope}`, async (t) => {
    const message = activity();
    if (scope === "foreign-tenant")
      message.channelData = { tenant: { id: owner } };
    if (scope === "group") message.conversation!.conversationType = "groupChat";
    if (scope === "foreign-channel") message.channelId = "directline";
    if (scope === "missing-owner")
      message.from = { id: "fixture-user", name: "fixture" };
    if (scope === "remove") (message as { action?: string }).action = "remove";
    t.mock.method(
      CloudAdapter.prototype,
      "process",
      async (...args: unknown[]) => {
        await (args[2] as (context: TurnContext) => Promise<void>)({
          activity: message,
        } as TurnContext);
      },
    );
    const { bot, calls } = fixture();
    assert.equal(
      (await bot.handle(request(JSON.stringify(message)))).status,
      200,
    );
    assert.deepEqual(
      calls,
      scope === "valid"
        ? ["init", "put"]
        : scope === "remove"
          ? ["init", "delete"]
          : [],
    );
  });
}
