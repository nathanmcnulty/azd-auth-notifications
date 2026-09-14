import {
  normalizeAudit,
  planDeliveries,
  type Config,
  type Registration,
  type Delivery,
} from "./core.js";
export interface Job extends Delivery {
  registration: Registration;
  status: string;
  etag?: string;
}
export interface State {
  checkpoint(): Promise<{ start: string; cursor: string } | undefined>;
  saveCheckpoint(value: { start: string; cursor: string }): Promise<void>;
  add(job: Job): Promise<void>;
  pending(): AsyncIterable<Job>;
  claim(job: Job): Promise<boolean>;
  finish(job: Job, status: string, code?: string): Promise<void>;
}
export interface AuditReader {
  audits(from: string, to: string): AsyncIterable<unknown[]>;
  resolveAudit?(raw: unknown): Promise<unknown>;
}
export interface DispatchOutcome {
  key: string;
  status: "accepted" | "review" | "suppressed";
  code?: string;
}
export async function collect(
  config: Config,
  state: State,
  graph: AuditReader,
  now = new Date(),
): Promise<number> {
  if (!config.enabled) return 0;
  const end = now.toISOString();
  const checkpoint = await state.checkpoint();
  if (!checkpoint) {
    await state.saveCheckpoint({ start: end, cursor: end });
    return 0;
  }
  const from = new Date(
    Math.max(
      Date.parse(checkpoint.start),
      Date.parse(checkpoint.cursor) - config.overlapMinutes * 60000,
    ),
  ).toISOString();
  let count = 0;
  for await (const page of graph.audits(from, end)) {
    for (const raw of page) {
      const event = normalizeAudit(
        graph.resolveAudit ? await graph.resolveAudit(raw) : raw,
      );
      if (
        !event ||
        event.occurredAt < checkpoint.start ||
        Date.parse(event.occurredAt) > now.getTime()
      )
        continue;
      for (const delivery of planDeliveries(event, config)) {
        await state.add({
          ...delivery,
          registration: event,
          status: "pending",
        });
        count++;
      }
    }
  }
  await state.saveCheckpoint({ start: checkpoint.start, cursor: end });
  return count;
}
export async function dispatch(
  config: Config,
  state: State,
  send: (job: Job) => Promise<void>,
  limit = 100,
  onlyKeys?: ReadonlySet<string>,
  onOutcome?: (outcome: DispatchOutcome) => void,
): Promise<number> {
  if (!config.enabled) return 0;
  let count = 0;
  for await (const job of state.pending()) {
    if (onlyKeys && !onlyKeys.has(job.key)) continue;
    // Re-check the current audience and channel before honoring previously queued work.
    if (
      !planDeliveries(job.registration, config).some((d) => d.key === job.key)
    ) {
      if (!(await state.claim(job))) continue;
      await state.finish(job, "suppressed", "DeliveryNoLongerEligible");
      onOutcome?.({
        key: job.key,
        status: "suppressed",
        code: "DeliveryNoLongerEligible",
      });
      continue;
    }
    if (!(await state.claim(job))) continue;
    try {
      await send(job);
    } catch (error) {
      // Never blindly retry a send that may have reached the provider.
      const code =
        error instanceof Error && /^[A-Za-z0-9_:-]{1,80}$/.test(error.message)
          ? error.message
          : "DeliveryOutcomeUnknown";
      await state.finish(job, "review", code);
      onOutcome?.({ key: job.key, status: "review", code });
      if (++count >= limit) break;
      continue;
    }
    // A crash/storage failure here leaves 'sending', requiring operator review.
    await state.finish(job, "accepted");
    onOutcome?.({ key: job.key, status: "accepted" });
    if (++count >= limit) break;
  }
  return count;
}
