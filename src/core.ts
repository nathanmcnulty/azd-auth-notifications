export type Channel = "email" | "teams";
export type Audience = "user" | "admin";

export interface Registration {
  id: string;
  userId: string;
  occurredAt: string;
  method: string;
  correlationId?: string;
}

export interface Config {
  enabled: boolean;
  tenantId: string;
  userChannels: Channel[];
  adminChannels: Channel[];
  adminUserIds: string[];
  pilotUserIds: string[];
  allUsers: boolean;
  senderUserId?: string;
  helpdeskText: string;
  overlapMinutes: number;
}

export interface Delivery {
  key: string;
  audience: Audience;
  channel: Channel;
  recipientId: string;
}

export interface Notification {
  subject: string;
  html: string;
  text: string;
  card: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECURITY_INFO_URL = "https://mysignins.microsoft.com/security-info";
const DEFAULT_HELPDESK_TEXT = "Contact your helpdesk immediately.";

const METHOD_LABELS = new Map<string, string>([
  ["microsoft authenticator", "Microsoft Authenticator"],
  ["microsoft authenticator app", "Microsoft Authenticator"],
  ["authenticator app", "Authenticator app"],
  ["fido2 security key", "FIDO2 security key"],
  ["passkey (device-bound)", "Passkey (device-bound)"],
  ["phone", "Phone"],
  ["sms", "SMS"],
  ["voice call", "Voice call"],
  ["email", "Email"],
  ["email otp", "Email one-time passcode"],
  ["temporary access pass", "Temporary Access Pass"],
  ["software oath token", "Software OATH token"],
  ["hardware oath token", "Hardware OATH token"],
  ["windows hello for business", "Windows Hello for Business"],
  ["certificate-based authentication", "Certificate-based authentication"],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID.test(value);
}

function canonicalMethod(value: string): string {
  return METHOD_LABELS.get(value.trim().toLocaleLowerCase()) ?? "Authentication method";
}

function authenticationMethod(details: unknown): string | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }

  for (const detail of details) {
    const item = record(detail);
    if (item && text(item.key)?.toLocaleLowerCase() === "authenticationmethod") {
      return text(item.value);
    }
  }

  return undefined;
}

/**
 * Selects only supported, successful authentication-method registration audits.
 * The user comes from a User target resource; audit actors are never recipients.
 */
export function normalizeAudit(audit: any): Registration | undefined {
  const event = record(audit);
  if (!event || text(event.result)?.toLocaleLowerCase() !== "success") {
    return undefined;
  }

  const id = text(event.id);
  const sourceDate = text(event.activityDateTime);
  const date = sourceDate ? new Date(sourceDate) : undefined;
  if (!id || !date || Number.isNaN(date.getTime())) {
    return undefined;
  }

  const userTargets = Array.isArray(event.targetResources)
    ? event.targetResources
        .map(record)
        .filter((target) => text(target?.type)?.toLocaleLowerCase() === "user")
    : [];
  if (userTargets.length !== 1) {
    return undefined;
  }
  const userId = text(userTargets[0]?.id);
  if (!isUuid(userId)) {
    return undefined;
  }

  const activity = text(event.activityDisplayName ?? event.operationName)?.toLocaleLowerCase();
  let method: string | undefined;
  if (activity === "add passkey (device-bound)") {
    method = "Passkey (device-bound)";
  } else if (activity === "user registered security info") {
    const detail = authenticationMethod(event.additionalDetails);
    if (!detail || detail.toLocaleLowerCase() === "passkey") {
      return undefined;
    }
    method = canonicalMethod(detail);
  } else {
    return undefined;
  }

  const correlationId = text(event.correlationId);
  return {
    id,
    userId: userId.toLocaleLowerCase(),
    occurredAt: date.toISOString(),
    method,
    ...(correlationId ? { correlationId } : {}),
  };
}

function parseBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function parseUuid(value: string | undefined, name: string, required = true): string | undefined {
  const normalized = text(value);
  if (!normalized) {
    if (required) {
      throw new Error(`${name} is required.`);
    }
    return undefined;
  }
  if (!isUuid(normalized)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return normalized.toLocaleLowerCase();
}

function parseUuidList(value: string | undefined, name: string): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => !item)) {
    throw new Error(`${name} must be a comma-separated list of UUIDs.`);
  }
  return [...new Set(values.map((item) => parseUuid(item, name)!))];
}

function parseChannels(
  value: string | undefined,
  name: string,
  defaultChannels: Channel[],
  allowEmpty = false,
): Channel[] {
  if (value === undefined) {
    return [...defaultChannels];
  }
  if (!value.trim()) {
    if (allowEmpty) {
      return [];
    }
    throw new Error(`${name} must include at least one channel.`);
  }
  const values = value.split(",").map((item) => item.trim().toLocaleLowerCase());
  if (values.some((item) => item !== "email" && item !== "teams")) {
    throw new Error(`${name} supports only email and teams.`);
  }
  return [...new Set(values as Channel[])];
}

function parseHelpdeskText(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_HELPDESK_TEXT;
  }
  const normalized = value.trim();
  if (normalized.length > 500 || /[<>\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("HELPDESK_TEXT must be plain text of at most 500 characters.");
  }
  return normalized;
}

function parseOverlapMinutes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return 60;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("AUDIT_OVERLAP_MINUTES must be an integer from 1 to 1440.");
  }
  const minutes = Number(value.trim());
  if (minutes < 1 || minutes > 1440) {
    throw new Error("AUDIT_OVERLAP_MINUTES must be an integer from 1 to 1440.");
  }
  return minutes;
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const enabled = parseBoolean(env.COLLECTION_ENABLED, "COLLECTION_ENABLED", false);
  const tenantId = parseUuid(env.AZURE_TENANT_ID, "AZURE_TENANT_ID")!;
  const userChannels = parseChannels(env.USER_CHANNELS, "USER_CHANNELS", ["email"]);
  const adminChannels = parseChannels(env.ADMIN_CHANNELS, "ADMIN_CHANNELS", [], true);
  const adminUserIds = parseUuidList(env.ADMIN_USER_IDS, "ADMIN_USER_IDS");
  const pilotUserIds = parseUuidList(env.PILOT_USER_IDS, "PILOT_USER_IDS");
  const allUsers = parseBoolean(env.ALL_USERS, "ALL_USERS", false);

  if (userChannels.length === 0) {
    throw new Error("USER_CHANNELS must include at least one channel.");
  }
  if ((adminChannels.length === 0) !== (adminUserIds.length === 0)) {
    throw new Error("ADMIN_CHANNELS and ADMIN_USER_IDS must be configured together.");
  }
  if (enabled && !allUsers && pilotUserIds.length === 0) {
    throw new Error("PILOT_USER_IDS is required when COLLECTION_ENABLED is true and ALL_USERS is not true.");
  }

  const usesEmail = userChannels.includes("email") || adminChannels.includes("email");
  const senderUserId = parseUuid(env.EMAIL_SENDER_USER_ID, "EMAIL_SENDER_USER_ID", usesEmail);

  return {
    enabled,
    tenantId,
    userChannels,
    adminChannels,
    adminUserIds,
    pilotUserIds,
    allUsers,
    ...(senderUserId ? { senderUserId } : {}),
    helpdeskText: parseHelpdeskText(env.HELPDESK_TEXT),
    overlapMinutes: parseOverlapMinutes(env.AUDIT_OVERLAP_MINUTES),
  };
}

export function planDeliveries(registration: Registration, config: Config): Delivery[] {
  if (!config.enabled || (!config.allUsers && !config.pilotUserIds.includes(registration.userId))) {
    return [];
  }

  const deliveries: Delivery[] = [];
  const recipients = new Set<string>();
  const add = (audience: Audience, channel: Channel, recipientId: string) => {
    const key = `${registration.id}:${channel}:${recipientId}`;
    if (recipients.has(key)) {
      return;
    }
    recipients.add(key);
    deliveries.push({ key, audience, channel, recipientId });
  };

  for (const channel of config.userChannels) {
    add("user", channel, registration.userId);
  }
  for (const recipientId of config.adminUserIds) {
    for (const channel of config.adminChannels) {
      add("admin", channel, recipientId);
    }
  }
  return deliveries;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escapes[character];
  });
}

function utcTime(occurredAt: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
    hourCycle: "h23",
  }).format(new Date(occurredAt)) + " UTC";
}

export function renderNotification(registration: Registration, audience: Audience, helpdeskText: string): Notification {
  const method = escapeHtml(registration.method);
  const time = escapeHtml(utcTime(registration.occurredAt));
  const userId = escapeHtml(registration.userId);
  const helpdesk = escapeHtml(helpdeskText);
  const isAdmin = audience === "admin";
  const subject = isAdmin
    ? `Authentication method registered for ${registration.userId}: ${registration.method}`
    : `Authentication method registered: ${registration.method}`;
  const lead = isAdmin
    ? "An authentication method was registered for a user."
    : "A new authentication method was registered for your account.";
  const affectedUser = isAdmin ? `\n\nAffected user ID: ${registration.userId}` : "";
  const htmlAffectedUser = isAdmin ? `<p><strong>Affected user ID:</strong> ${userId}</p>` : "";
  const nextStep = isAdmin
    ? "Use the affected user ID to investigate this registration."
    : `Review your security information: ${SECURITY_INFO_URL}`;
  const htmlNextStep = isAdmin
    ? "<p>Use the affected user ID to investigate this registration.</p>"
    : `<p><a href="${SECURITY_INFO_URL}">Review your security information</a></p>`;
  const actions = isAdmin
    ? []
    : [{ type: "Action.OpenUrl", title: "Review security information", url: SECURITY_INFO_URL }];

  return {
    subject,
    text: `${lead}\n\nMethod: ${registration.method}\nTime: ${utcTime(registration.occurredAt)}${affectedUser}\n\n${nextStep}\n\nIf you did not expect this registration, ${helpdeskText}`,
    html: `<p>${lead}</p><p><strong>Method:</strong> ${method}<br><strong>Time:</strong> ${time}</p>${htmlAffectedUser}${htmlNextStep}<p>If you did not expect this registration, ${helpdesk}</p>`,
    card: {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body: [
        { type: "TextBlock", text: lead, wrap: true },
        { type: "FactSet", facts: [
          { title: "Method", value: registration.method },
          { title: "Time", value: utcTime(registration.occurredAt) },
          ...(isAdmin ? [{ title: "Affected user ID", value: registration.userId }] : []),
        ] },
        { type: "TextBlock", text: `If you did not expect this registration, ${helpdeskText}`, wrap: true },
      ],
      actions,
    },
  };
}
