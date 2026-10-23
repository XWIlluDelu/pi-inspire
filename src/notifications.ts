import type { CompletionAttentionPreference } from "../shared/contracts";
import type {
  TaskAlertSettings,
  TaskAlertState,
  TaskNotification,
} from "../shared/notifications";
import type { Api } from "./api";
import type { AppState } from "./app-state";
import { migrateTaskAlertIntent } from "./browser-auth";
import {
  browserNotificationPermission,
  requestBrowserNotificationPermission,
} from "./browser-notifications";
import type { SessionOpenResult } from "./controllers/session-selection-controller";

function deadline<T>(
  operation: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface Host {
  state(): AppState;
  patch(value: Partial<AppState>): void;
  api(): Api | null;
  mark(event: TaskNotification): void;
  clear(): void;
  openSession(id: string): Promise<SessionOpenResult>;
}

/** Browser intent and display transport; the Host owns task/result correlation. */
export class TaskNotificationController {
  private generation = 0;
  private pendingSettings: TaskAlertSettings | null = null;
  private listening = false;
  private openingTarget: { id: string } | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private enrollment: Promise<unknown> = Promise.resolve();
  private readonly targetKey = "inspire-notification-target";

  constructor(private readonly host: Host) {}

  private patch(value: Partial<TaskAlertState>): void {
    this.host.patch({
      taskAlerts: { ...this.host.state().taskAlerts, ...value },
    });
  }
  refreshPermission = (): void => {
    this.patch({ permission: browserNotificationPermission() });
  };
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    navigator.serviceWorker?.addEventListener("message", this.onWorkerMessage);
    window.addEventListener("focus", this.refreshPermission);
    document.addEventListener("visibilitychange", this.refreshPermission);
  }
  captureTarget(): void {
    this.listen();
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const target = fragment.get("inspire-session");
    if (!target) return;
    try {
      sessionStorage.setItem(this.targetKey, target);
    } catch {
      /* private storage */
    }
    fragment.delete("inspire-session");
    url.hash = fragment.toString();
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  private onWorkerMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (data?.type === "inspire-notification-view") {
      event.ports[0]?.postMessage({
        sessionId: this.host.state().sessionId,
        foreground:
          document.visibilityState === "visible" && document.hasFocus(),
      });
    } else if (
      data?.type === "inspire-notification-open" &&
      typeof data.sessionId === "string"
    ) {
      try {
        sessionStorage.setItem(this.targetKey, data.sessionId);
      } catch {
        /* storage disabled */
      }
      void this.openTarget();
    } else if (
      data?.type === "inspire-notification-shown" &&
      data.test === true
    ) {
      this.patch({
        testResult:
          "Display request accepted. Check your system notifications.",
      });
    }
  };
  async openTarget(): Promise<void> {
    if (this.host.state().connection !== "open") return;
    let target: string | null = null;
    try {
      target = sessionStorage.getItem(this.targetKey);
    } catch {
      /* storage disabled */
    }
    if (!target || this.openingTarget?.id === target) return;
    const opening = { id: target };
    this.openingTarget = opening;
    try {
      const result = await this.host.openSession(target);
      if (
        this.openingTarget === opening &&
        sessionStorage.getItem(this.targetKey) === target &&
        (result === "opened" ||
          result === "missing" ||
          (result === "superseded" && this.host.state().connection === "open"))
      )
        sessionStorage.removeItem(this.targetKey);
    } finally {
      if (this.openingTarget === opening) this.openingTarget = null;
    }
  }
  private updateEnrollment<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.enrollment.catch(() => {}).then(operation);
    this.enrollment = pending;
    return pending;
  }
  applySettings(settings: TaskAlertSettings): void {
    // Let an in-flight local gesture finish rather than applying its older echo.
    if (this.host.state().taskAlerts.busy) {
      this.pendingSettings = settings;
      return;
    }
    if (settings.mode !== this.host.state().taskAlerts.mode) this.generation++;
    this.patch({
      mode: settings.mode ?? "off",
      subscribed: settings.subscribed,
      error: settings.error,
    });
    if (settings.mode === "off") this.host.clear();
  }
  private finishUpdate(): void {
    this.patch({ busy: false });
    const settings = this.pendingSettings;
    this.pendingSettings = null;
    // Same-choice echoes must not hide a setup error produced after that echo.
    if (settings && settings.mode !== this.host.state().taskAlerts.mode)
      this.applySettings(settings);
  }
  async initialize(legacy: CompletionAttentionPreference): Promise<void> {
    this.captureTarget();
    this.refreshPermission();
    const api = this.host.api();
    if (!api) return;
    const generation = this.generation;
    try {
      let settings = await api.taskAlertSettings();
      if (generation !== this.generation || this.host.api() !== api) return;
      if (settings.mode === null)
        settings = await this.save(await migrateTaskAlertIntent(legacy));
      if (generation !== this.generation || this.host.api() !== api) return;
      if (settings.mode === "off" || settings.mode === "title") {
        await this.updateEnrollment(async () => {
          if (generation !== this.generation || this.host.api() !== api) return;
          const registration = await navigator.serviceWorker?.getRegistration();
          const subscription =
            await registration?.pushManager?.getSubscription();
          if (generation === this.generation && this.host.api() === api)
            await subscription?.unsubscribe();
        });
        if (generation !== this.generation || this.host.api() !== api) return;
      }
      if (settings.mode === "desktop") {
        const registration = await navigator.serviceWorker?.getRegistration();
        const subscription = await registration?.pushManager?.getSubscription();
        const key = subscription?.options.applicationServerKey;
        const encoded = key
          ? btoa(String.fromCharCode(...new Uint8Array(key)))
              .replace(/=/g, "")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
          : null;
        if (generation !== this.generation || this.host.api() !== api) return;
        if (
          browserNotificationPermission() !== "granted" ||
          encoded !== settings.publicKey
        ) {
          if (settings.subscribed) settings = await this.save(undefined, null);
        } else if (subscription!.endpoint !== settings.endpoint) {
          // Browser enrollment can succeed even if its Host registration fails
          // or times out. Reconcile the existing subscription, not a new one:
          // no permission prompt, no subscribe(), and no rewrite of intent.
          // A retained endpoint with subscribed=false was explicitly expired;
          // only a different browser subscription can repair that destination.
          settings = await this.save(undefined, subscription!.toJSON());
        }
        if (generation !== this.generation || this.host.api() !== api) return;
      }
      this.patch({
        mode: settings.mode ?? "off",
        subscribed: settings.subscribed,
        error: settings.error,
      });
    } catch (error) {
      if (generation === this.generation && this.host.api() === api)
        this.patch({
          error:
            error instanceof Error
              ? error.message
              : "Notification setup is unavailable",
        });
    }
  }
  private registration(): Promise<ServiceWorkerRegistration> {
    if (!("serviceWorker" in navigator))
      return Promise.reject(
        new Error("System notifications are unavailable in this browser"),
      );
    return deadline(
      navigator.serviceWorker.ready,
      8_000,
      "The notification service is not ready. Reload Inspire and retry.",
    );
  }
  private save(
    mode: CompletionAttentionPreference | undefined,
    subscription?: PushSubscriptionJSON | null,
  ): Promise<TaskAlertSettings> {
    const api = this.host.api();
    if (!api) return Promise.reject(new Error("Connect to the Host first"));
    const operation = this.writes
      .catch(() => {})
      .then(() => api.configureTaskAlerts(mode, subscription));
    this.writes = operation;
    return operation;
  }
  async setMode(mode: CompletionAttentionPreference): Promise<boolean> {
    const generation = ++this.generation;
    this.pendingSettings = null;
    this.patch({ mode, busy: true, error: null, testResult: null });
    if (mode === "off") this.host.clear();
    // Request permission before awaiting Host I/O: iOS needs this user gesture.
    const permission =
      mode === "desktop"
        ? requestBrowserNotificationPermission()
        : Promise.resolve(browserNotificationPermission());
    try {
      const granted = await permission;
      if (generation !== this.generation) return false;
      this.patch({ permission: granted });
      const saved = await this.save(
        mode,
        mode === "desktop" && granted === "granted" ? undefined : null,
      );
      if (generation !== this.generation) return false;
      this.patch({ subscribed: saved.subscribed });
      return await this.updateEnrollment(async () => {
        if (generation !== this.generation) return false;
        if (mode !== "desktop") {
          // Disable the server destination first; failure to unsubscribe cannot reactivate it.
          const registration = await navigator.serviceWorker?.getRegistration();
          await (
            await registration?.pushManager?.getSubscription()
          )?.unsubscribe();
          return true;
        }
        if (granted !== "granted") return false;
        const registration = await this.registration();
        if (generation !== this.generation) return false;
        if (!registration.pushManager)
          throw new Error(
            "Background push is unavailable; notifications work while Inspire is open.",
          );
        let subscription = await registration.pushManager.getSubscription();
        const bytes = Uint8Array.from(
          atob(saved.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        );
        if (subscription) {
          const existing = subscription.options.applicationServerKey;
          if (
            (!saved.subscribed && subscription.endpoint === saved.endpoint) ||
            !existing ||
            new Uint8Array(existing).some((value, i) => value !== bytes[i]) ||
            existing.byteLength !== bytes.length
          ) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
        subscription ??= await deadline(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: bytes,
          }),
          15_000,
          "Background setup timed out. Notifications still work while Inspire is open; retry when the browser can reach its push service.",
        );
        if (generation !== this.generation) {
          if (this.host.state().taskAlerts.mode !== "desktop")
            await subscription.unsubscribe();
          return false;
        }
        // Enrollment fills in transport, not intent: another window may have
        // disabled alerts while the browser was creating this subscription.
        const enrolled = await this.save(undefined, subscription.toJSON());
        if (generation !== this.generation) return false;
        this.patch({ subscribed: enrolled.subscribed, error: enrolled.error });
        if (enrolled.mode !== "desktop") {
          this.pendingSettings = enrolled;
          await subscription.unsubscribe();
          return false;
        }
        return true;
      });
    } catch (error) {
      if (generation === this.generation)
        this.patch({
          error:
            error instanceof Error
              ? error.message
              : "Notification setup failed",
        });
      return false;
    } finally {
      if (generation === this.generation) this.finishUpdate();
    }
  }
  async receive(event: TaskNotification): Promise<void> {
    if (!event || typeof event.id !== "string") return;
    const api = this.host.api();
    const generation = this.generation;
    const current = () =>
      this.host.api() === api && this.generation === generation;
    const mode = this.host.state().taskAlerts.mode;
    if (!event.test && event.sessionId) this.host.mark(event);
    if (
      mode !== "desktop" ||
      (!event.test &&
        event.sessionId === this.host.state().sessionId &&
        document.visibilityState === "visible" &&
        document.hasFocus())
    ) {
      await api?.acknowledgeTaskAlert(event.id).catch(() => {});
      return;
    }
    if (browserNotificationPermission() !== "granted") return;
    try {
      const registration = await this.registration();
      // A newer device choice or connection retires this pending display.
      if (!current()) return;
      const worker = registration.active;
      if (!worker) throw new Error("Notification service is not active");
      const response = await new Promise<{ error?: string }>(
        (resolve, reject) => {
          const channel = new MessageChannel();
          const timeout = setTimeout(() => {
            channel.port1.close();
            reject(new Error("Notification display timed out"));
          }, 5_000);
          channel.port1.onmessage = (message) => {
            clearTimeout(timeout);
            channel.port1.close();
            resolve(message.data);
          };
          worker.postMessage(
            { type: "inspire-notification-display", notification: event },
            [channel.port2],
          );
        },
      );
      if (!current()) return;
      if (response.error) throw new Error(response.error);
      await api?.acknowledgeTaskAlert(event.id);
      if (current() && event.test)
        this.patch({
          testResult:
            "Display request accepted. Check your system notifications.",
        });
    } catch (error) {
      if (current())
        this.patch({
          error:
            error instanceof Error
              ? error.message
              : "System notification failed",
        });
    }
  }
  async test(): Promise<void> {
    this.patch({ busy: true, testResult: null, error: null });
    try {
      const result = await this.host.api()?.testTaskAlert();
      // Push delivery can beat the HTTP response. Do not downgrade a worker's
      // display acceptance to the earlier "sent" stage when that response arrives.
      if (result && this.host.state().taskAlerts.testResult === null)
        this.patch({
          testResult:
            result.transport === "push"
              ? "Sent to the browser push service. Check your system notifications."
              : "Sent to this page for display.",
        });
    } catch (error) {
      this.patch({
        error:
          error instanceof Error ? error.message : "Test notification failed",
      });
    } finally {
      this.finishUpdate();
    }
  }
}
