import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ACTIVITY_STALE_MS,
  piActivityDirectory,
  type PiActivityRecord,
} from "../docs/examples/session-activity.js";
import type {
  ExternalSessionActivities,
  ExternalSessionActivity,
} from "../shared/session-activity.js";
import type { SessionCatalogLike } from "./session-catalog.js";

const POLL_MS = 2_000;
const MAX_RECORD_BYTES = 16_384;
const REPORT_NAME = /^[1-9]\d*-[0-9a-f-]{36}\.json$/;

interface ObserverOptions {
  catalog: Pick<SessionCatalogLike, "refresh">;
  publish(activities: ExternalSessionActivities): void;
  directory?: string;
}

export function isPiActivityRecord(value: unknown): value is PiActivityRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PiActivityRecord>;
  return (
    record.version === 1 &&
    (record.processIdentity === undefined ||
      (typeof record.processIdentity === "string" &&
        record.processIdentity.length > 0 &&
        record.processIdentity.length <= 256)) &&
    (record.inactive === undefined || typeof record.inactive === "boolean") &&
    (record.released === undefined || typeof record.released === "boolean") &&
    Number.isSafeInteger(record.pid) &&
    record.pid! > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.sessionFile === "string" &&
    isAbsolute(record.sessionFile) &&
    (record.activity === "working" ||
      record.activity === "blocked" ||
      record.activity === "idle") &&
    Number.isSafeInteger(record.updatedAt) &&
    record.updatedAt! > 0
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Local observations only. Never starts, adopts, stops or writes a Pi session. */
export class PiSessionActivity {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private readonly directory: string;

  constructor(private readonly options: ObserverOptions) {
    this.directory = options.directory ?? piActivityDirectory();
  }

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
    }, ACTIVITY_STALE_MS);
    this.expiry.unref();
  }

  private async readRecord(name: string): Promise<PiActivityRecord | null> {
    const path = join(this.directory, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isPiActivityRecord(record) || !name.startsWith(`${record.pid}-`))
        return null;
      if (!isAlive(record.pid)) {
        // A crashed process cannot clean up its own ephemeral report.
        await rm(path, { force: true });
        return null;
      }
      if (record.inactive || record.released) return null;
      const age = Date.now() - record.updatedAt;
      return age >= 0 && age < ACTIVITY_STALE_MS ? record : null;
    } catch {
      return null;
    }
  }

  private async read(): Promise<ExternalSessionActivities> {
    const names = (await readdir(this.directory)).filter((name) =>
      REPORT_NAME.test(name),
    );
    const reports = (
      await Promise.all(names.map((name) => this.readRecord(name)))
    ).filter((record): record is PiActivityRecord => record !== null);
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
      if (
        !record ||
        resolve(record.path) !== resolve(report.sessionFile) ||
        Date.now() - report.updatedAt >= ACTIVITY_STALE_MS
      )
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
