import { requestError } from "./request-error.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  type HostUpdateStatus,
  type PiExtensionUpdate,
  type PiUpdateCheckResponse,
  UPDATE_SNOOZE_MS,
  type UpdateCheckResponse,
} from "../shared/contracts.js";
import type { DiagnosticLogger } from "./diagnostics.js";
import type { PiUpdateCheckerLike } from "./pi-update-checker.js";
import { inspireStateDirectory } from "./platform-paths.mjs";
import type { UpdateCheckerLike } from "./update-checker.js";

const AUTOMATIC_UPDATE_CHECK_HOUR = 8;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const updateIdentityEntriesSchema = z.array(
  z.union([
    z.tuple([z.literal("inspire"), z.string()]),
    z.tuple([z.literal("pi"), z.string()]),
    z.tuple([z.literal("extension"), z.string(), z.string()]),
  ]),
);

type UpdateIdentityEntry = z.infer<typeof updateIdentityEntriesSchema>[number];

const persistedUpdateStateSchema = z
  .object({
    version: z.literal(1),
    automaticCheckDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable(),
    snooze: z
      .object({
        identity: z
          .string()
          .min(1)
          .max(64 * 1024),
        dismissedAt: z.number().finite().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

type PersistedUpdateState = z.infer<typeof persistedUpdateStateSchema>;

type UpdateStatusListener = (status: HostUpdateStatus) => void;

export interface UpdateCoordinatorLike {
  status(): Promise<HostUpdateStatus>;
  checkInspire(force?: boolean): Promise<HostUpdateStatus>;
  checkPi(force?: boolean): Promise<HostUpdateStatus>;
  dismiss(identity: string): Promise<HostUpdateStatus>;
  promptAccepted(): Promise<void>;
  subscribe(listener: UpdateStatusListener): () => void;
  close(): Promise<void>;
}

interface UpdateCoordinatorOptions {
  currentPiVersion: string;
  inspireChecker?: UpdateCheckerLike;
  piChecker?: PiUpdateCheckerLike;
  statePath?: string;
  now?: () => number;
  diagnostics?: DiagnosticLogger;
}

function deploymentKey(root: string, host: string, port: number): string {
  return createHash("sha256")
    .update(resolve(root))
    .update("\0")
    .update(host)
    .update("\0")
    .update(String(port))
    .digest("hex");
}

/** Operational update state follows one stable Host deployment, not a browser
 * origin or the process-lifetime authority id. */
export function defaultUpdateStatePath(
  root: string,
  host: string,
  port: number,
): string {
  return join(
    inspireStateDirectory(),
    "updates",
    `${deploymentKey(root, host, port)}.json`,
  );
}

function automaticCheckDay(now: number): string | null {
  const local = new Date(now);
  if (local.getHours() < AUTOMATIC_UPDATE_CHECK_HOUR) return null;
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extensionIdentityOrder(
  left: PiExtensionUpdate,
  right: PiExtensionUpdate,
): number {
  if (left.displayName < right.displayName) return -1;
  if (left.displayName > right.displayName) return 1;
  if (left.type < right.type) return -1;
  if (left.type > right.type) return 1;
  return 0;
}

function availableUpdateEntries(
  inspire: UpdateCheckResponse | null,
  pi: PiUpdateCheckResponse | null,
): UpdateIdentityEntry[] {
  const entries: UpdateIdentityEntry[] = [];
  if (inspire?.kind === "available")
    entries.push(["inspire", inspire.update.latestVersion]);
  if (pi?.pi.kind === "available") entries.push(["pi", pi.pi.latestVersion]);
  if (pi?.extensions.kind === "available") {
    for (const update of [...pi.extensions.updates].sort(
      extensionIdentityOrder,
    )) {
      entries.push(["extension", update.type, update.displayName]);
    }
  }
  return entries;
}

/** Exact identity of the currently observed available set. */
function availableUpdateIdentity(
  inspire: UpdateCheckResponse | null,
  pi: PiUpdateCheckResponse | null,
): string | null {
  const entries = availableUpdateEntries(inspire, pi);
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

function initialPersistedState(): PersistedUpdateState {
  return {
    version: 1,
    automaticCheckDay: null,
    snooze: null,
  };
}

function httpConflict(message: string): Error {
  return requestError(message, 409);
}

/**
 * Owns update observations, daily prompt-triggering, and acknowledgement for
 * every authenticated view of one Host deployment.
 */
export class UpdateCoordinator implements UpdateCoordinatorLike {
  private readonly now: () => number;
  private readonly listeners = new Set<UpdateStatusListener>();
  private readonly ready: Promise<void>;
  private persisted = initialPersistedState();
  private revision = 0;
  private inspireUpdateCheck: UpdateCheckResponse | null = null;
  private piUpdateCheck: PiUpdateCheckResponse | null = null;
  private inspireUpdateChecking = false;
  private piUpdateChecking = false;
  private inspireInFlight: Promise<HostUpdateStatus> | null = null;
  private piInFlight: Promise<HostUpdateStatus> | null = null;
  private mutationQueue = Promise.resolve();
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.ready = this.load();
  }

  subscribe(listener: UpdateStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status(): Promise<HostUpdateStatus> {
    await this.ready;
    return this.snapshot();
  }

  checkInspire(force = false): Promise<HostUpdateStatus> {
    return this.check("inspire", force);
  }

  checkPi(force = false): Promise<HostUpdateStatus> {
    return this.check("pi", force);
  }

  async dismiss(identity: string): Promise<HostUpdateStatus> {
    await this.ready;
    return this.enqueueMutation(() => this.performDismiss(identity));
  }

  promptAccepted(): Promise<void> {
    const task = this.runAutomaticCheck();
    void task.catch((error) =>
      this.recordFailure("automatic_update_check_failed", error),
    );
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = null;
    this.listeners.clear();
    await this.ready;
    await this.mutationQueue;
  }

  private async performDismiss(identity: string): Promise<HostUpdateStatus> {
    if (this.inspireUpdateChecking || this.piUpdateChecking)
      throw httpConflict("Update observations changed while dismissing");
    const currentIdentity = this.currentIdentity();
    if (!currentIdentity || currentIdentity !== identity)
      throw httpConflict("The available update set has changed");

    const now = this.now();
    const existing = this.persisted.snooze;
    if (
      existing?.identity === identity &&
      existing.dismissedAt <= now &&
      now < existing.dismissedAt + UPDATE_SNOOZE_MS
    ) {
      return this.snapshot();
    }

    const next = { identity, dismissedAt: now };
    this.persisted.snooze = next;
    try {
      await this.persistCurrentState();
    } catch (error) {
      if (this.persisted.snooze === next) this.persisted.snooze = existing;
      throw error;
    }
    this.scheduleSnoozeExpiry(next);
    return this.publish();
  }

  private async check(
    kind: "inspire" | "pi",
    force: boolean,
  ): Promise<HostUpdateStatus> {
    await this.ready;
    const inFlight =
      kind === "inspire" ? this.inspireInFlight : this.piInFlight;
    if (inFlight) return inFlight;
    if (this.closed) return this.snapshot();

    const task = this.performCheck(kind, force);
    if (kind === "inspire") this.inspireInFlight = task;
    else this.piInFlight = task;
    const clear = () => {
      if (kind === "inspire" && this.inspireInFlight === task)
        this.inspireInFlight = null;
      if (kind === "pi" && this.piInFlight === task) this.piInFlight = null;
    };
    void task.then(clear, clear);
    return task;
  }

  private async performCheck(
    kind: "inspire" | "pi",
    force: boolean,
  ): Promise<HostUpdateStatus> {
    if (kind === "inspire") this.inspireUpdateChecking = true;
    else this.piUpdateChecking = true;
    this.publish();
    try {
      if (kind === "inspire") {
        this.inspireUpdateCheck = this.options.inspireChecker
          ? await this.options.inspireChecker.check(force)
          : { kind: "unavailable" };
      } else {
        this.piUpdateCheck = this.options.piChecker
          ? await this.options.piChecker.check(force)
          : this.unavailablePiCheck();
      }
    } catch {
      if (kind === "inspire") this.inspireUpdateCheck = { kind: "unavailable" };
      else this.piUpdateCheck = this.unavailablePiCheck();
    } finally {
      if (kind === "inspire") this.inspireUpdateChecking = false;
      else this.piUpdateChecking = false;
    }
    if (this.closed) return this.snapshot();
    await this.reconcileSnooze();
    return this.publish();
  }

  private unavailablePiCheck(): PiUpdateCheckResponse {
    return {
      currentVersion: this.options.currentPiVersion,
      pi: { kind: "unavailable" },
      extensions: { kind: "unavailable" },
    };
  }

  private async runAutomaticCheck(): Promise<void> {
    await this.ready;
    const claimed = await this.enqueueMutation(async () => {
      if (this.closed) return false;
      const day = automaticCheckDay(this.now());
      if (!day || this.persisted.automaticCheckDay === day) return false;

      this.persisted.automaticCheckDay = day;
      try {
        await this.persistCurrentState();
      } catch (error) {
        // The process-lifetime owner still prevents duplicate checks. Update
        // observation must never turn an accepted prompt into a failed write.
        this.recordFailure("update_state_write_failed", error);
      }
      return true;
    });
    if (!claimed) return;
    await Promise.all([this.checkInspire(false), this.checkPi(false)]);
  }

  private observationsPresent(): boolean {
    return this.inspireUpdateCheck !== null || this.piUpdateCheck !== null;
  }

  private currentIdentity(): string | null {
    return availableUpdateIdentity(this.inspireUpdateCheck, this.piUpdateCheck);
  }

  private snoozeMatchesObserved(identity: string): boolean {
    let expected: UpdateIdentityEntry[];
    try {
      expected = updateIdentityEntriesSchema.parse(JSON.parse(identity));
    } catch {
      return false;
    }
    const observed = availableUpdateEntries(
      this.inspireUpdateCheck,
      this.piUpdateCheck,
    );
    const sameEntries = (source: "inspire" | "pi") => {
      const categories =
        source === "inspire"
          ? new Set(["inspire"])
          : new Set(["pi", "extension"]);
      return (
        JSON.stringify(
          observed.filter(([category]) => categories.has(category)),
        ) ===
        JSON.stringify(
          expected.filter(([category]) => categories.has(category)),
        )
      );
    };
    return (
      (this.inspireUpdateCheck === null || sameEntries("inspire")) &&
      (this.piUpdateCheck === null || sameEntries("pi"))
    );
  }

  private activeSnoozeUntil(): number | null {
    const snooze = this.persisted.snooze;
    if (!snooze) return null;
    const now = this.now();
    const until = snooze.dismissedAt + UPDATE_SNOOZE_MS;
    if (snooze.dismissedAt > now || now >= until) return null;
    return this.snoozeMatchesObserved(snooze.identity) ? until : null;
  }

  private reconcileSnooze(): Promise<void> {
    return this.enqueueMutation(async () => {
      if (
        this.inspireUpdateChecking ||
        this.piUpdateChecking ||
        !this.observationsPresent()
      )
        return;
      const snooze = this.persisted.snooze;
      if (!snooze) return;
      const now = this.now();
      const valid =
        snooze.dismissedAt <= now &&
        now < snooze.dismissedAt + UPDATE_SNOOZE_MS &&
        this.snoozeMatchesObserved(snooze.identity);
      if (valid) {
        this.scheduleSnoozeExpiry(snooze);
        return;
      }

      this.persisted.snooze = null;
      if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
      this.snoozeTimer = null;
      try {
        await this.persistCurrentState();
      } catch (error) {
        this.recordFailure("update_state_write_failed", error);
      }
    });
  }

  private snapshot(): HostUpdateStatus {
    return {
      revision: this.revision,
      inspireUpdateCheck: this.inspireUpdateCheck
        ? structuredClone(this.inspireUpdateCheck)
        : null,
      piUpdateCheck: this.piUpdateCheck
        ? structuredClone(this.piUpdateCheck)
        : null,
      inspireUpdateChecking: this.inspireUpdateChecking,
      piUpdateChecking: this.piUpdateChecking,
      availableUpdateIdentity: this.currentIdentity(),
      updateSnoozedUntil: this.activeSnoozeUntil(),
    };
  }

  private publish(): HostUpdateStatus {
    this.revision += 1;
    const status = this.snapshot();
    if (this.closed) return status;
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(status));
      } catch (error) {
        this.recordFailure("update_status_listener_failed", error);
      }
    }
    return status;
  }

  private scheduleSnoozeExpiry(
    snooze: NonNullable<PersistedUpdateState["snooze"]>,
  ): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    const delay = Math.max(
      0,
      snooze.dismissedAt + UPDATE_SNOOZE_MS - this.now(),
    );
    this.snoozeTimer = setTimeout(() => {
      this.snoozeTimer = null;
      void this.expireSnooze(snooze);
    }, delay);
    this.snoozeTimer.unref();
  }

  private async expireSnooze(
    expected: NonNullable<PersistedUpdateState["snooze"]>,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      if (this.persisted.snooze !== expected) return;
      this.persisted.snooze = null;
      try {
        await this.persistCurrentState();
      } catch (error) {
        this.recordFailure("update_state_write_failed", error);
      }
      this.publish();
    });
  }

  private async load(): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    try {
      const parsed = persistedUpdateStateSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      this.persisted = parsed;
      const snooze = parsed.snooze;
      if (snooze) {
        const now = this.now();
        if (
          snooze.dismissedAt <= now &&
          now < snooze.dismissedAt + UPDATE_SNOOZE_MS
        ) {
          this.scheduleSnoozeExpiry(snooze);
        } else {
          this.persisted.snooze = null;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.recordFailure("update_state_read_failed", error);
      this.persisted = initialPersistedState();
    }
  }

  private async persistCurrentState(): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    await mkdir(dirname(path), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    const temporary = join(
      dirname(path),
      `.${String(process.pid)}-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(this.persisted)}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
        flag: "wx",
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private recordFailure(event: string, error: unknown): void {
    this.options.diagnostics?.record("warning", event, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
