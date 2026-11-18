import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import webPush from "web-push";
import type { CompletionAttentionPreference } from "../shared/contracts.js";
import {
  type NotificationSubscription,
  pushSubscriptionSchema,
  type TaskAlertEvent,
  type TaskAlertSettings,
  type TaskAlertUpdate,
  type TaskNotification,
  type TaskNotificationGrouping,
} from "../shared/notifications.js";
import { replacePrivateStateFile } from "./private-state-file.js";
import { requestError } from "./request-error.js";

export interface NotificationPrincipal {
  id: string;
}
type AlertClient = (event: TaskAlertEvent) => void;
const LIFETIME = 15 * 60_000;
const ACK_WAIT = 2_000;

interface Device {
  mode: CompletionAttentionPreference;
  grouping?: TaskNotificationGrouping;
  groupingUpdatedAt?: number;
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

function notificationSessionName(
  value: string | undefined,
): string | undefined {
  return value?.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Only the newest undelivered result per device/session remains eligible.
 * Tests have no session and keep their independent delivery identity. */
function coalescePending(items: Pending[]): Pending[] {
  const latest = new Map<string, Pending>();
  for (const item of items) {
    if (item.event.test || !item.event.sessionId) continue;
    const key = JSON.stringify([item.deviceId, item.event.sessionId]);
    const previous = latest.get(key);
    if (!previous || item.event.createdAt >= previous.event.createdAt)
      latest.set(key, item);
  }
  const retained = new Set(latest.values());
  return items.filter(
    (item) => item.event.test || !item.event.sessionId || retained.has(item),
  );
}

/** Per-browser delivery. Pending items expire; this is not a notification inbox. */
export class TaskNotifications {
  private saved!: Saved;
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private lastOutcomeAt = 0;
  private readonly clients = new Map<string, Set<AlertClient>>();
  private flushing: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private storageError: string | null = null;

  constructor(
    private readonly path: string,
    private readonly sendPush = webPush.sendNotification.bind(webPush),
    private readonly sessionContext?: (
      sessionId: string,
    ) => Promise<{ name?: string; cwd: string } | undefined>,
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
    this.saved.pending = coalescePending(
      this.saved.pending.filter(
        (item) => item.event.createdAt + LIFETIME > Date.now(),
      ),
    );
  }
  private save(): Promise<void> {
    const data = JSON.stringify(this.saved);
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await replacePrivateStateFile(this.path, data);
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
      mode: device?.mode ?? "off",
      grouping: device?.grouping ?? "session",
      groupingUpdatedAt: device?.groupingUpdatedAt ?? 0,
      publicKey: this.saved.vapid.publicKey,
      subscribed: Boolean(device?.subscription),
      endpoint:
        device?.subscription?.endpoint ?? device?.expiredEndpoint ?? null,
      error: this.storageError ?? device?.error ?? null,
    };
  }
  async configure(
    principal: NotificationPrincipal,
    update: TaskAlertUpdate,
  ): Promise<TaskAlertSettings> {
    await this.ready;
    const { id } = principal;
    const previous = this.saved.devices[id];
    if (!previous && Object.keys(this.saved.devices).length >= 64)
      throw requestError("Too many notification devices registered", 409);
    const device: Device = previous ?? { mode: "off" };
    const { subscription, grouping, mode = device.mode } = update;
    if (subscription) {
      pushSubscriptionSchema.parse(subscription);
      if (subscription.endpoint === previous?.expiredEndpoint)
        throw requestError(
          "Background subscription expired. Enable notifications again.",
          409,
        );
    }

    const old = device.subscription;
    const next =
      mode === "desktop" && subscription !== null
        ? (subscription ?? old)
        : undefined;
    // Keep the enrollment identity used by in-flight sends across settings edits.
    if (
      next?.endpoint !== old?.endpoint ||
      next?.keys.auth !== old?.keys.auth ||
      next?.keys.p256dh !== old?.keys.p256dh
    ) {
      device.subscription = next;
      delete device.error;
    }
    device.mode = mode;
    if (grouping !== undefined && grouping !== (device.grouping ?? "session")) {
      device.grouping = grouping;
      device.groupingUpdatedAt = Math.max(
        Date.now(),
        (device.groupingUpdatedAt ?? 0) + 1,
      );
    }
    if (mode !== "desktop" || subscription === null) delete device.error;
    if (subscription) delete device.expiredEndpoint;
    this.saved.devices[id] = device;
    if (
      (update.mode !== undefined && mode !== "desktop") ||
      subscription === null
    )
      this.saved.pending = this.saved.pending.filter(
        (item) => item.deviceId !== id,
      );
    await this.save();
    return this.publishSettings(id);
  }
  private publishSettings(id: string): TaskAlertSettings {
    const settings = this.currentSettings(id);
    for (const send of this.clients.get(id) ?? [])
      send({ type: "task_alert_settings", settings });
    return settings;
  }
  /** Listener stays installed independently of every browser connection. */
  observe = (event: TaskNotification): void => {
    if (this.closed || event.createdAt <= this.lastOutcomeAt) return;
    this.lastOutcomeAt = event.createdAt;
    void this.enqueue(event).catch(() => {});
  };
  private async enqueue(
    event: TaskNotification,
    onlyDevice?: string,
  ): Promise<void> {
    await this.ready;
    if (
      this.closed ||
      !Object.entries(this.saved.devices).some(
        ([id, device]) =>
          device.mode !== "off" && (!onlyDevice || id === onlyDevice),
      )
    )
      return;
    if (this.sessionContext && event.sessionId && !event.test) {
      try {
        const context = await this.sessionContext(event.sessionId);
        if (context)
          event = {
            ...event,
            project: basename(context.cwd),
            // Stable across Host restarts without exposing filesystem paths or
            // confusing two directories that share the same display label.
            projectId: createHmac("sha256", this.saved.vapid.privateKey)
              .update(context.cwd)
              .digest("base64url"),
            ...("name" in context
              ? { sessionName: notificationSessionName(context.name) }
              : {}),
          };
      } catch {
        // Optional metadata cannot discard the actual task result. Without a
        // trustworthy project identity the worker keeps this session separate.
      }
    }
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
    this.saved.pending = coalescePending(this.saved.pending).slice(-512);
    await this.save();
    for (const item of this.saved.pending.filter(
      (item) => item.event.id === event.id,
    ))
      this.offer(item);
  }
  attach(principal: NotificationPrincipal, send: AlertClient): () => void {
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
          if (item.deviceId === principal.id) this.offer(item, [send]);
      })
      .catch(() => {});
    return () => {
      clients.delete(send);
      if (!clients.size) this.clients.delete(principal.id);
    };
  }
  private delivery(event: TaskNotification, device: Device): TaskNotification {
    return {
      ...event,
      grouping: device.grouping ?? "session",
      groupingUpdatedAt: device.groupingUpdatedAt ?? 0,
      notificationOwner: this.saved.vapid.publicKey,
    };
  }
  private offer(
    item: Pending,
    clients: Iterable<AlertClient> | undefined = this.clients.get(
      item.deviceId,
    ),
  ): void {
    if (!clients || item.event.createdAt + LIFETIME <= Date.now()) return;
    const notification = this.delivery(
      item.event,
      this.saved.devices[item.deviceId]!,
    );
    for (const send of clients)
      send({ type: "task_notification", notification });
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
        await this.push(principal.id, event);
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
  private async push(deviceId: string, event: TaskNotification): Promise<void> {
    const device = this.saved.devices[deviceId]!;
    const subscription = device.subscription!;
    try {
      await this.sendPush(
        subscription,
        JSON.stringify({
          type: "inspire-task",
          ...this.delivery(event, device),
        }),
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
          ...(process.env.HTTPS_PROXY
            ? { proxy: process.env.HTTPS_PROXY }
            : {}),
        },
      );
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      const expired = status === 404 || status === 410;
      const message = expired
        ? "Background subscription expired. Enable notifications again."
        : "The Host could not reach the browser push service. Check its network connection and retry.";
      if (device.subscription === subscription) {
        device.error = message;
        if (expired) {
          device.expiredEndpoint = subscription.endpoint;
          delete device.subscription;
          this.saved.pending = this.saved.pending.filter(
            (item) => item.deviceId !== deviceId,
          );
        }
      }
      throw requestError(message, 502);
    }
    if (device.subscription === subscription) delete device.error;
  }
  private async flush(): Promise<void> {
    await this.ready;
    if (this.closed || !this.saved.pending.length) return;
    const now = Date.now();
    const pending = this.saved.pending;
    this.saved.pending = pending.filter(
      (item) => item.event.createdAt + LIFETIME > now,
    );
    let dirty = this.saved.pending.length !== pending.length;
    const delivered = new Set<Pending>();
    const changedSettings = new Set<string>();
    await Promise.all(
      this.saved.pending.map(async (item) => {
        const device = this.saved.devices[item.deviceId];
        if (
          item.nextAttempt > now ||
          device?.mode !== "desktop" ||
          !device.subscription
        )
          return;
        dirty = true;
        const previousError = device.error;
        try {
          await this.push(item.deviceId, item.event);
          delivered.add(item);
        } catch {
          item.attempts++;
          item.nextAttempt =
            Date.now() + Math.min(60_000, 10_000 * item.attempts);
        }
        if (previousError !== device.error) changedSettings.add(item.deviceId);
      }),
    );
    if (delivered.size)
      this.saved.pending = this.saved.pending.filter(
        (item) => !delivered.has(item),
      );
    if (dirty) await this.save();
    for (const id of changedSettings) this.publishSettings(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.clients.clear();
    await this.flushing;
    await this.writes.catch(() => {});
  }
}
