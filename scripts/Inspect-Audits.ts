import { Graph } from "../src/graph.js";
import { normalizeAudit } from "../src/core.js";
const tenant = process.env.AZURE_TENANT_ID;
if (!tenant) throw Error("AZURE_TENANT_ID is required");
const graph = new Graph(tenant);
const hours = Number(process.env.AUDIT_INSPECTION_HOURS ?? 24);
if (!Number.isInteger(hours) || hours < 1 || hours > 168)
  throw Error("AUDIT_INSPECTION_HOURS must be 1..168");
const end = new Date();
const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
const activityCounts: Record<string, number> = {};
const methodCounts: Record<string, number> = {};
let records = 0;
for await (const page of graph.audits(start.toISOString(), end.toISOString())) {
  for (const raw of page) {
    records++;
    const event = raw as { activityDisplayName?: string; result?: string };
    const activity = `${event.activityDisplayName} (${event.result})`;
    activityCounts[activity] = (activityCounts[activity] ?? 0) + 1;
    const registration = normalizeAudit(await graph.resolveAudit(raw));
    if (registration)
      methodCounts[registration.method] =
        (methodCounts[registration.method] ?? 0) + 1;
  }
}
console.log(
  JSON.stringify(
    { windowHours: hours, records, activityCounts, methodCounts },
    null,
    2,
  ),
);
