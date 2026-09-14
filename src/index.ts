import { app } from "@azure/functions";
import { randomUUID } from "node:crypto";
import {
  parseConfig,
  planDeliveries,
  renderNotification,
  type Registration,
} from "./core.js";
import { collect, dispatch, type DispatchOutcome, type Job } from "./engine.js";
import { AzureState } from "./state.js";
import { Graph } from "./graph.js";
import { ManagedIdentityTeamsBot } from "./bot.js";
const config = parseConfig(process.env);
const state = new AzureState(
  `https://${process.env.STORAGE_ACCOUNT_NAME}.table.core.windows.net`,
  config.tenantId,
);
const graph = new Graph(config.tenantId);
const teamsEnabled = [...config.userChannels, ...config.adminChannels].includes(
  "teams",
);
const teamsAppId = process.env.TEAMS_BOT_APP_ID;
if (teamsEnabled && !teamsAppId) throw Error("TeamsBotAppIdRequired");
const bot = teamsEnabled
  ? new ManagedIdentityTeamsBot(teamsAppId!, config.tenantId, state, console)
  : undefined;
async function send(job: Job) {
  const message = renderNotification(
    job.registration,
    job.audience,
    config.helpdeskText,
  );
  if (job.channel === "email")
    await graph.email(
      config.senderUserId!,
      await graph.recipient(job.recipientId),
      message.subject,
      message.html,
    );
  else {
    if (!bot) throw Error("TeamsNotConfigured");
    await bot.sendToEntraUser(job.recipientId, message.card);
  }
}
app.timer("registrationNotifications", {
  schedule: "0 */5 * * * *",
  useMonitor: true,
  handler: async (_timer, context) => {
    if (!config.enabled) return;
    await state.init();
    // Drain existing work even when collection is temporarily unavailable.
    const delivered = await dispatch(config, state, send);
    const queued = await collect(config, state, graph);
    context.log("Registration notification cycle", {
      queued,
      attempted: delivered,
    });
  },
});
if (bot)
  app.http("teamsMessages", {
    route: "messages",
    methods: ["POST"],
    authLevel: "anonymous",
    handler: async (request) => {
      await state.init();
      return bot.handle(request);
    },
  });
app.http("testDelivery", {
  route: "test-delivery",
  methods: ["POST"],
  authLevel: "function",
  handler: async (request) => {
    if (config.enabled)
      return {
        status: 409,
        jsonBody: { code: "TestDeliveryRequiresCollectionDisabled" },
      };
    if (config.allUsers || config.pilotUserIds.length === 0)
      return {
        status: 400,
        jsonBody: { code: "TestDeliveryRequiresExplicitPilot" },
      };
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { code: "TestDeliveryInvalidBody" } };
    }
    const userId =
      typeof (body as { userId?: unknown })?.userId === "string"
        ? (body as { userId: string }).userId.toLowerCase()
        : undefined;
    if (!userId || !config.pilotUserIds.includes(userId))
      return { status: 403, jsonBody: { code: "TestDeliveryUserNotPilot" } };
    const registration: Registration = {
      id: randomUUID(),
      userId,
      occurredAt: new Date().toISOString(),
      method: "Test authentication method",
    };
    const effectiveConfig = { ...config, enabled: true, allUsers: false };
    const jobs = planDeliveries(registration, effectiveConfig).map(
      (delivery) => ({ ...delivery, registration, status: "pending" }),
    );
    await state.init();
    for (const job of jobs) await state.add(job);
    const outcomes: DispatchOutcome[] = [];
    await dispatch(
      effectiveConfig,
      state,
      send,
      jobs.length,
      new Set(jobs.map((job) => job.key)),
      (outcome) => outcomes.push(outcome),
    );
    return {
      status: 200,
      jsonBody: { registrationId: registration.id, deliveries: outcomes },
    };
  },
});
app.http("health", {
  route: "health",
  methods: ["GET"],
  authLevel: "function",
  handler: async () => ({
    jsonBody: {
      status: "ready",
      collectionEnabled: config.enabled,
      version: "0.1.0",
    },
  }),
});
