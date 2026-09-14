import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext,
  type ConversationReference
} from "botbuilder";
interface ConversationRepository { getConversation(id:string):Promise<unknown>; putConversation(id:string,reference:unknown):Promise<void>; deleteConversation(id:string):Promise<void> }
interface Logger { error(message:string,properties?:unknown):void }
class PermanentDeliveryError extends Error {}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizedUuid(value:string|undefined):string|undefined { return value&&UUID.test(value)?value.toLowerCase():undefined; }


interface WebResponseCapture {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  socket: unknown;
  header(name: string, value: unknown): void;
  setHeader(name: string, value: string): void;
  status(code: number): WebResponseCapture;
  send(body?: unknown): void;
  end(body?: unknown): void;
}

export class ManagedIdentityTeamsBot  {
  private readonly adapter: CloudAdapter;
  private readonly appId: string;
  private readonly tenantId: string;

  constructor(
    appId: string,
    tenantId: string,
    private readonly conversations: ConversationRepository,
    private readonly logger: Logger
  ) {
    this.appId=normalizedUuid(appId) ?? (()=>{throw Error('TeamsBotAppIdInvalid');})();
    this.tenantId=normalizedUuid(tenantId) ?? (()=>{throw Error('TeamsBotTenantIdInvalid');})();
    const authentication = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppType: "UserAssignedMSI",
      MicrosoftAppId: appId,
      MicrosoftAppPassword: "",
      MicrosoftAppTenantId: tenantId
    });
    this.adapter = new CloudAdapter(authentication);
    this.adapter.onTurnError = async () => {
      this.logger.error("Teams bot turn failed", { code: "TeamsBotTurnFailure" });
      throw new Error("TeamsBotTurnFailure");
    };
  }

  async sendToEntraUser(ownerObjectId: string, card: unknown): Promise<void> {
    const reference = await this.conversations.getConversation(ownerObjectId) as Partial<ConversationReference> | undefined;
    if (!reference?.serviceUrl || !reference.conversation) throw new PermanentDeliveryError('TeamsConversationUnavailable');
    await this.adapter.continueConversationAsync(this.appId, reference as ConversationReference, async (context) => {
      await context.sendActivity({ attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] });
    });
  }

  async handle(request: HttpRequest): Promise<HttpResponseInit> {
    const body = await request.json() as Record<string, unknown>;
    const response: WebResponseCapture = {
      statusCode: 200,
      headers: {},
      socket: undefined,
      header(name, value) { this.headers[name] = String(value); },
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      send(value) { this.body = value; },
      end(value) { this.body = value; }
    };
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { headers[name] = value; });
    const webRequest = { method: request.method, headers, body };
    await this.adapter.process(webRequest, response, async (context) => {
      const activityTenantId=normalizedUuid(context.activity.channelData?.tenant?.id);
      if (context.activity.channelId !== "msteams" || activityTenantId !== this.tenantId || context.activity.conversation?.conversationType !== "personal") return;
      const ownerObjectId=normalizedUuid(context.activity.from?.aadObjectId);
      if (ownerObjectId) {
        const installationAction = (context.activity as { action?: string }).action;
        if (context.activity.type === "installationUpdate" && installationAction === "remove") {
          await this.conversations.deleteConversation(ownerObjectId);
        } else {
          await this.conversations.putConversation(ownerObjectId, TurnContext.getConversationReference(context.activity));
        }
      }
    });
    return { status: response.statusCode, headers: response.headers, body: typeof response.body === "string" ? response.body : undefined, jsonBody: typeof response.body === "object" ? response.body : undefined };
  }
}

