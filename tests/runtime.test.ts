import assert from "node:assert/strict";
import test from "node:test";
import { Graph } from "../src/graph.js";
import { normalizeAudit } from "../src/core.js";

const tenant = "11111111-1111-4111-8111-111111111111";
function jwt(tid: string) {
  return `header.${Buffer.from(JSON.stringify({ tid })).toString("base64url")}.signature`;
}

test("a Graph token from another tenant is rejected before a request is sent", async () => {
  let requests = 0;
  const graph = new Graph(
    tenant,
    {
      async getToken() {
        return { token: jwt("22222222-2222-4222-8222-222222222222") };
      },
    },
    async () => {
      requests++;
      return new Response("{}");
    },
  );
  await assert.rejects(
    graph.recipient("33333333-3333-4333-8333-333333333333"),
    /GraphTenantMismatch/,
  );
  assert.equal(requests, 0);
});

test("a foreign pagination link is rejected without sending it a bearer token", async () => {
  const urls: string[] = [];
  const authorizations: string[] = [];
  const graph = new Graph(
    tenant,
    {
      async getToken() {
        return { token: jwt(tenant) };
      },
    },
    async (input, init) => {
      urls.push(String(input));
      authorizations.push(
        String((init?.headers as Record<string, string>).Authorization),
      );
      return new Response(
        JSON.stringify({
          value: [],
          "@odata.nextLink": "https://evil.example/v1.0/auditLogs",
        }),
        { status: 200 },
      );
    },
  );
  const pages = graph.audits(
    "2026-09-13T00:00:00.000Z",
    "2026-09-13T00:05:00.000Z",
  );
  await pages.next();
  await assert.rejects(pages.next(), /GraphUrlRejected/);
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).origin, "https://graph.microsoft.com");
  assert.equal(authorizations.length, 1);
});

function canonicalPasskey(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    result: "success",
    activityDateTime: "2026-09-13T00:00:00.000Z",
    activityDisplayName: "Add Passkey (device-bound)",
    targetResources: [
      { id: null, type: "User", userPrincipalName: "user@contoso.example" },
    ],
    initiatedBy: { user: { id: "33333333-3333-4333-8333-333333333333" } },
    ...overrides,
  };
}

test("resolves a canonical missing-ID passkey target by its verified UPN", async () => {
  const graph = new Graph(
    tenant,
    {
      async getToken() {
        return { token: jwt(tenant) };
      },
    },
    async (input) => {
      assert.match(String(input), /users\/user%40contoso\.example/);
      return new Response(
        JSON.stringify({
          id: "22222222-2222-4222-8222-222222222222",
          userPrincipalName: "USER@CONTOSO.EXAMPLE",
        }),
      );
    },
  );
  const raw = canonicalPasskey();
  const resolved = await graph.resolveAudit(raw);
  assert.notEqual(resolved, raw);
  assert.equal(
    normalizeAudit(resolved)?.userId,
    "22222222-2222-4222-8222-222222222222",
  );
});

test("does not use an actor ID when UPN resolution is mismatched", async () => {
  const graph = new Graph(
    tenant,
    {
      async getToken() {
        return { token: jwt(tenant) };
      },
    },
    async () =>
      new Response(
        JSON.stringify({
          id: "33333333-3333-4333-8333-333333333333",
          userPrincipalName: "other@contoso.example",
        }),
      ),
  );
  const raw = canonicalPasskey();
  assert.equal(await graph.resolveAudit(raw), raw);
  assert.equal(normalizeAudit(raw), undefined);
});

test("treats a missing UPN lookup as an unsupported audit without actor fallback", async () => {
  const graph = new Graph(
    tenant,
    {
      async getToken() {
        return { token: jwt(tenant) };
      },
    },
    async () => new Response("not found", { status: 404 }),
  );
  const raw = canonicalPasskey();
  assert.equal(await graph.resolveAudit(raw), raw);
  assert.equal(normalizeAudit(raw), undefined);
});

test("does not resolve malformed or multi-target audits", async () => {
  let requests = 0;
  const graph = new Graph(
    tenant,
    {
      async getToken() {
        return { token: jwt(tenant) };
      },
    },
    async () => {
      requests++;
      return new Response("{}");
    },
  );
  const multiTarget = canonicalPasskey({
    targetResources: [
      { id: null, type: "User", userPrincipalName: "user@contoso.example" },
      { id: null, type: "User", userPrincipalName: "other@contoso.example" },
    ],
  });
  const malformed = canonicalPasskey({
    targetResources: [{ id: null, type: "User", userPrincipalName: "" }],
  });
  assert.equal(await graph.resolveAudit(multiTarget), multiTarget);
  assert.equal(await graph.resolveAudit(malformed), malformed);
  assert.equal(requests, 0);
});
