import { resolve } from "node:path";
import { ATTACH_CONTROL_STALE_MS } from "../extensions/attach-control.js";
import type {
  ExternalSessionActivities,
  ExternalSessionActivity,
} from "../shared/session-activity.js";
import type { AttachControlRegistry } from "./attach-control.js";
import type { SessionCatalogLike } from "./session-catalog.js";

const POLL_MS = 2_000;

interface ObserverOptions {
  catalog: Pick<SessionCatalogLike, "refresh">;
  registry: Pick<AttachControlRegistry, "observe">;
  publish(activities: ExternalSessionActivities): void;
}

/** Local observations only. Never starts, adopts, stops or writes a Pi session. */
export class PiSessionActivity {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: ObserverOptions) {}

  start(): void {
    if (this.stopped || this.timer || this.pending) return;
    this.tick();
  }

  private tick = (): void => {
    this.timer = null;
    void this.refresh().finally(() => {
      if (this.stopped) return;
      this.timer = setTimeout(this.tick, POLL_MS);
      this.timer.unref();
    });
  };

  /** Repeat full maps so newly connected clients also receive the baseline. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    const pending = this.read().then(
      (activities) => this.publish(activities),
      () => this.publish({}),
    );
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    return pending;
  }

  private publish(activities: ExternalSessionActivities): void {
    if (this.stopped) return;
    if (this.expiry) clearTimeout(this.expiry);
    this.options.publish(activities);
    this.expiry = setTimeout(() => {
      this.expiry = null;
      if (!this.stopped) this.options.publish({});
    }, ATTACH_CONTROL_STALE_MS);
    this.expiry.unref();
  }

  private async read(): Promise<ExternalSessionActivities> {
    const reports = await this.options.registry.observe();
    if (this.stopped || reports.length === 0) return {};

    // Both native identity and file must match the existing discovery catalog.
    // Reports do not expand storage roots or authorize access to arbitrary files.
    const records = await this.options.catalog.refresh();
    const counts = new Map<string, number>();
    for (const record of records)
      counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    const byId = new Map(
      records
        .filter((record) => counts.get(record.id) === 1)
        .map((record) => [record.id, record]),
    );
    const priorities = { idle: 0, blocked: 1, working: 2 };
    const result = new Map<string, ExternalSessionActivity>();
    for (const report of reports) {
      const record = byId.get(report.sessionId);
      if (!record || resolve(record.path) !== resolve(report.sessionFile))
        continue;
      const previous = result.get(record.id);
      if (!previous || priorities[report.activity] > priorities[previous])
        result.set(record.id, report.activity);
    }
    return Object.fromEntries(result);
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.expiry) clearTimeout(this.expiry);
    this.timer = null;
    this.expiry = null;
  }
}
