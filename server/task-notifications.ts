import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush from "web-push";
import { z } from "zod";
import type { CompletionAttentionPreference } from "../shared/contracts.js";
import type {
  NotificationSubscription,
  TaskAlertSettings,
  TaskAlertEvent,
  TaskNotification,
  TaskOutcome,
} from "../shared/notifications.js";
import { requestError } from "./request-error.js";

export interface NotificationPrincipal {
  id: string;
  origin: string;
}
const LIFETIME = 15 * 60_000;
const ACK_WAIT = 2_000;

/** A subscription is an outbound capability, not an arbitrary URL to fetch. */
export const pushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          !url.hash &&
          (url.hostname === "fcm.googleapis.com" ||
            url.hostname === "updates.push.services.mozilla.com" ||
            url.hostname === "web.push.apple.com" ||
            url.hostname.endsWith(".push.apple.com") ||
            url.hostname.endsWith(".notify.windows.com"))
        );
      }, "This browser's push service is not supported"),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,1}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
      })
      .strict(),
  })
  .strict();

interface Device {
  origin: string;
  mode: CompletionAttentionPreference;
  subscription?: NotificationSubscription;
  expiredEndpoint?: string;
  error?: string;
}
interface Pending {
  deviceId: string;
  event: TaskNotification;
  nextAttempt: number;
  attempts: number;
}
interface Saved {
  version: 1;
  vapid: { publicKey: string; privateKey: string };
  devices: Record<string, Device>;
  pending: Pending[];
}
type Wire = Record<string, unknown>;

/** Correlates live work once in the Host, never from browser snapshot ownership. */
export class TaskOutcomeTracker {
  private runs = new Map<
    string,
    { id: string; kind: "agent" | "compaction" }
  >();
  private nativeSeen = new Map<string, string>();
  observe(event: Wire): TaskNotification | null {
    if (typeof event.sessionId !== "string") return null;
    const sessionId = event.sessionId;
    if (event.type === "native_task_outcome") {
      if (
        typeof event.outcomeId !== "string" ||
        this.nativeSeen.get(sessionId) === event.outcomeId
      )
        return null;
      this.nativeSeen.set(sessionId, event.outcomeId);
      this.runs.delete(sessionId);
      if (event.outcome === "aborted") return null;
      return this.result(
        sessionId,
        event.outcomeId,
        event.outcome === "failed"
          ? "failed"
          : event.outcome === "completed"
            ? "completed"
            : "ended",
        event,
      );
    }
    if (event.type === "agent_start" || event.type === "auto_retry_start") {
      if (!this.runs.has(sessionId))
        this.runs.set(sessionId, { id: randomUUID(), kind: "agent" });
      return null;
    }
    if (
      event.type === "compaction_start" &&
      event.reason === "manual" &&
      !this.runs.has(sessionId)
    ) {
      this.runs.set(sessionId, { id: randomUUID(), kind: "compaction" });
      return null;
    }
    const run = this.runs.get(sessionId);
    if (!run) return null;
    if (
      event.type !== "runtime_error" &&
      !(event.type === "agent_settled" && run.kind === "agent") &&
      !(event.type === "compaction_end" && run.kind === "compaction")
    )
      return null;
    this.runs.delete(sessionId);
    // A richer native settlement is published separately, even for short runs.
    if (event.taskOutcomeReported === true) return null;
    const status = (event.sessionStatus ?? {}) as Wire;
    if (
      event.aborted === true ||
      (event.outcomeUnknown !== true && status.runState === "aborted")
    )
      return null;
    const failed =
      event.type === "runtime_error" ||
      (event.outcomeUnknown !== true &&
        (status.runState === "failed" || status.runState === "conflict")) ||
      (event.type === "compaction_end" && Boolean(event.errorMessage));
    return this.result(
      sessionId,
      run.id,
      failed
        ? "failed"
        : event.outcomeUnknown === true
          ? "ended"
          : event.type === "compaction_end" && event.result == null
            ? "failed"
            : "completed",
      event,
    );
  }
  private result(
    sessionId: string,
    id: string,
    outcome: TaskOutcome,
    event: Wire,
  ): TaskNotification {
    return {
      id,
      sessionId,
      outcome,
      createdAt: Date.now(),
      ...(typeof event.taskProject === "string"
        ? { project: event.taskProject.slice(0, 160) }
        : {}),
    };
  }
}

/** Per-browser delivery. Pending items expire; this is not a notification inbox. */
export class TaskNotifications {
  private saved!: Saved;
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly tracker = new TaskOutcomeTracker();
  private readonly clients = new Map<
    string,
    Set<(event: TaskAlertEvent) => boolean>
  >();
  private flushing: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private storageError: string | null = null;

  constructor(
    private readonly path: string,
    private readonly sendPush = webPush.sendNotification.bind(webPush),
  ) {
    this.ready = this.load();
    // Delivery failures are surfaced by the authenticated Settings endpoint.
    void this.ready.catch(() => {});
    this.timer = setInterval(() => {
      this.flushing ??= this.flush()
        .catch(() => {})
        .finally(() => {
          this.flushing = null;
        });
    }, 1_000);
    this.timer.unref();
  }

  private async load(): Promise<void> {
    try {
      this.saved = JSON.parse(await readFile(this.path, "utf8")) as Saved;
      if (
        this.saved.version !== 1 ||
        !this.saved.vapid?.privateKey ||
        !this.saved.devices ||
        !Array.isArray(this.saved.pending)
      )
        throw new Error("Invalid notification state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.saved = {
        version: 1,
        vapid: webPush.generateVAPIDKeys(),
        devices: {},
        pending: [],
      };
    }
    this.saved.pending = this.saved.pending.filter(
      (item) => item.event.createdAt + LIFETIME > Date.now(),
    );
  }
  private save(): Promise<void> {
    const data = JSON.stringify(this.saved);
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = this.path + ".tmp";
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, this.path);
      });
    this.writes = operation.then(
      () => {
        this.storageError = null;
      },
      (error) => {
        this.storageError =
          "The Host could not save notification state. Check its notification storage.";
        throw error;
      },
    );
    return this.writes;
  }
  async settings(principal: NotificationPrincipal): Promise<TaskAlertSettings> {
    await this.ready;
    return this.currentSettings(principal.id);
  }
  private currentSettings(id: string): TaskAlertSettings {
    const device = this.saved.devices[id];
    return {
      installationId: id,
      mode: device?.mode ?? null,
      publicKey: this.saved.vapid.publicKey,
      subscribed: Boolean(device?.subscription),
      endpoint:
        device?.subscription?.endpoint ?? device?.expiredEndpoint ?? null,
      error: this.storageError ?? device?.error ?? null,
    };
  }
  async configure(
    principal: NotificationPrincipal,
    mode: CompletionAttentionPreference | undefined,
    subscription?: NotificationSubscription | null,
  ): Promise<TaskAlertSettings> {
    await this.ready;
    const previous = this.saved.devices[principal.id];
    mode ??= previous?.mode ?? "off";
    if (!previous && Object.keys(this.saved.devices).length >= 64)
      throw requestError("Too many notification devices registered", 409);
    if (subscription) {
      pushSubscriptionSchema.parse(subscription);
      if (subscription.endpoint === previous?.expiredEndpoint)
        throw requestError(
          "Background subscription expired. Enable notifications again.",
          409,
        );
    }
    this.saved.devices[principal.id] = {
      origin: principal.origin,
      mode,
      ...(!subscription && previous?.expiredEndpoint
        ? { expiredEndpoint: previous.expiredEndpoint }
        : {}),
      ...(previous?.error &&
      mode === "desktop" &&
      subscription !== null &&
      (!subscription ||
        subscription.endpoint === previous.subscription?.endpoint)
        ? { error: previous.error }
        : {}),
      ...(mode === "desktop" && subscription !== null
        ? { subscription: subscription ?? previous?.subscription }
        : {}),
    };
    if (mode !== "desktop" || subscription === null)
      this.saved.pending = this.saved.pending.filter(
        (item) => item.deviceId !== principal.id,
      );
    await this.save();
    return this.publishSettings(principal.id);
  }
  private publishSettings(id: string): TaskAlertSettings {
    const settings = this.currentSettings(id);
    for (const send of this.clients.get(id) ?? [])
      send({ type: "task_alert_settings", settings });
    return settings;
  }
  /** Listener stays installed independently of every browser connection. */
  observe = (value: unknown): void => {
    if (this.closed || !value || typeof value !== "object") return;
    const event = this.tracker.observe(value as Wire);
    if (event) void this.enqueue(event).catch(() => {});
  };
  private async enqueue(
    event: TaskNotification,
    onlyDevice?: string,
  ): Promise<void> {
    await this.ready;
    if (this.closed) return;
    const count = this.saved.pending.length;
    for (const [id, device] of Object.entries(this.saved.devices)) {
      if (device.mode === "off" || (onlyDevice && id !== onlyDevice)) continue;
      const item: Pending = {
        deviceId: id,
        event,
        nextAttempt: Date.now() + ACK_WAIT,
        attempts: 0,
      };
      this.saved.pending.push(item);
    }
    if (this.saved.pending.length === count) return;
    this.saved.pending = this.saved.pending.slice(-512);
    await this.save();
    for (const item of this.saved.pending.filter(
      (item) => item.event.id === event.id,
    ))
      this.offer(item);
  }
  attach(
    principal: NotificationPrincipal,
    send: (event: TaskAlertEvent) => boolean,
  ): () => void {
    const clients = this.clients.get(principal.id) ?? new Set();
    clients.add(send);
    this.clients.set(principal.id, clients);
    void this.ready
      .then(() => {
        if (!clients.has(send)) return;
        send({
          type: "task_alert_settings",
          settings: this.currentSettings(principal.id),
        });
        for (const item of this.saved.pending)
          if (
            item.deviceId === principal.id &&
            item.event.createdAt + LIFETIME > Date.now()
          )
            send({ type: "task_notification", notification: item.event });
      })
      .catch(() => {});
    return () => {
      clients.delete(send);
      if (!clients.size) this.clients.delete(principal.id);
    };
  }
  private offer(item: Pending): void {
    if (item.event.createdAt + LIFETIME <= Date.now()) return;
    for (const send of this.clients.get(item.deviceId) ?? [])
      send({ type: "task_notification", notification: item.event });
  }
  async acknowledge(
    principal: NotificationPrincipal,
    id: string,
  ): Promise<void> {
    await this.ready;
    const count = this.saved.pending.length;
    this.saved.pending = this.saved.pending.filter(
      (item) => item.deviceId !== principal.id || item.event.id !== id,
    );
    if (this.saved.pending.length !== count) await this.save();
  }
  async test(
    principal: NotificationPrincipal,
  ): Promise<{ transport: "push" | "page" }> {
    await this.ready;
    const device = this.saved.devices[principal.id];
    if (device?.mode !== "desktop")
      throw requestError("Enable system notifications first", 409);
    const event: TaskNotification = {
      id: randomUUID(),
      sessionId: null,
      outcome: "completed",
      createdAt: Date.now(),
      test: true,
    };
    if (device.subscription) {
      try {
        await this.push(device, event);
        delete device.error;
      } catch (error) {
        this.pushFailure(device, error);
        throw requestError(device.error!, 502);
      } finally {
        await this.save();
        this.publishSettings(principal.id);
      }
      return { transport: "push" };
    }
    if (!this.clients.get(principal.id)?.size)
      throw requestError("No connected Inspire page", 409);
    await this.enqueue(event, principal.id);
    return { transport: "page" };
  }
  private async push(device: Device, event: TaskNotification): Promise<void> {
    // No redirects: web-push uses https.request directly and exposes non-2xx.
    await this.sendPush(
      device.subscription!,
      JSON.stringify({ type: "inspire-task", ...event }),
      {
        TTL: Math.max(
          1,
          Math.floor((event.createdAt + LIFETIME - Date.now()) / 1000),
        ),
        urgency: "normal",
        timeout: 10_000,
        vapidDetails: {
          subject: "https://github.com/XWIlluDelu/pi-inspire",
          ...this.saved.vapid,
        },
        ...(process.env.HTTPS_PROXY ? { proxy: process.env.HTTPS_PROXY } : {}),
      },
    );
  }
  private async flush(): Promise<void> {
    await this.ready;
    if (this.closed) return;
    const now = Date.now();
    const expired = this.saved.pending.filter(
      (item) => item.event.createdAt + LIFETIME <= now,
    );
    if (expired.length) {
      this.saved.pending = this.saved.pending.filter(
        (item) => !expired.includes(item),
      );
      await this.save();
    }
    await Promise.all(
      this.saved.pending.map(async (item) => {
        const device = this.saved.devices[item.deviceId];
        if (
          item.nextAttempt > now ||
          device?.mode !== "desktop" ||
          !device.subscription
        )
          return;
        const previousError = device.error;
        try {
          await this.push(device, item.event);
          this.saved.pending = this.saved.pending.filter(
            (candidate) => candidate !== item,
          );
          delete device.error;
        } catch (error) {
          this.pushFailure(device, error);
          item.attempts++;
          item.nextAttempt =
            Date.now() + Math.min(60_000, 10_000 * item.attempts);
        } finally {
          await this.save();
          if (previousError !== device.error)
            this.publishSettings(item.deviceId);
        }
      }),
    );
  }
  private pushFailure(device: Device, error: unknown): void {
    const status = (error as { statusCode?: number }).statusCode;
    device.error =
      status === 404 || status === 410
        ? "Background subscription expired. Enable notifications again."
        : "The Host could not reach the browser push service. Check its network connection and retry.";
    if (status === 404 || status === 410) {
      device.expiredEndpoint =
        device.subscription?.endpoint ?? device.expiredEndpoint;
      delete device.subscription;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.clients.clear();
    await this.flushing;
    await this.writes.catch(() => {});
  }
}
