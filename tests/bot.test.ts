import assert from "node:assert/strict";
import test from "node:test";
import { classifyBotError } from "../src/bot.js";

test("classifies a safe HTTP status and provider error code", () => {
  assert.equal(
    classifyBotError({
      statusCode: 403,
      body: { error: { code: "BotNotInConversationRoster" } },
    }),
    "TeamsHttp403_BotNotInConversationRoster",
  );
});

test("uses a safe direct provider code when no HTTP status is available", () => {
  assert.equal(
    classifyBotError({ code: "ConversationNotFound" }),
    "TeamsConversationNotFound",
  );
});

test("uses the alternate HTTP status field when it is present", () => {
  assert.equal(
    classifyBotError({ status: 429, code: "Throttled" }),
    "TeamsHttp429_Throttled",
  );
});

test("does not expose a malicious error message or response body", () => {
  assert.equal(
    classifyBotError({
      message: "Bearer token https://example.invalid/secret",
      body: { error: { code: "https://example.invalid/secret" } },
    }),
    "TeamsBotTurnFailure",
  );
});

test("uses a bounded safe error name and falls back for missing objects", () => {
  assert.equal(classifyBotError({ name: "NetworkError" }), "TeamsNetworkError");
  assert.equal(classifyBotError(undefined), "TeamsBotTurnFailure");
});
