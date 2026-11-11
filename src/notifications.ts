import type { CompletionAttentionPreference } from "../shared/contracts";
import type {
  TaskAlertSettings,
  TaskAlertState,
  TaskNotification,
  TaskNotificationGrouping,
} from "../shared/notifications";
import type { Api } from "./api";
import type { AppState } from "./app-state";
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
  private groupingGeneration = 0;
  private groupingSync = 0;
  private pendingSettings: {
    value: TaskAlertSettings;
    api: Api | null;
  } | null = null;
  private groupingSettings: Pick<
    TaskAlertSettings,
    "grouping" | "groupingUpdatedAt" | "publicKey"
  > | null = null;
  private listening = false;
  private openingTarget: { id: string } | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private enrollment: Promise<unknown> = Promise.resolve();
  private readonly targetKey = "inspire-notification-target";
  private initialSettingsApi: Api | null = null;

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
    navigator.serviceWorker?.addEventListener(
      "controllerchange",
      this.onWorkerChange,
    );
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
  private onWorkerChange = (): void => {
    if (this.groupingSettings) void this.syncGrouping(this.groupingSettings);
  };
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
  /** The event connection sends device settings before notification offers.
   * Browser enrollment is optional work, never a prerequisite for that stream. */
  start(): void {
    this.initialSettingsApi = this.host.api();
    this.captureTarget();
    this.refreshPermission();
  }

  invalidateForTransportReplacement(): void {
    this.generation++;
    this.groupingGeneration++;
    this.groupingSync++;
    this.initialSettingsApi = null;
    this.pendingSettings = null;
    this.patch({ busy: false, groupingBusy: false });
  }

  private updateEnrollment<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.enrollment.catch(() => {}).then(operation);
    this.enrollment = pending;
    return pending;
  }
  applySettings(settings: TaskAlertSettings): void {
    // Let an in-flight local gesture finish rather than applying its older echo.
    if (
      this.host.state().taskAlerts.busy ||
      this.host.state().taskAlerts.groupingBusy
    ) {
      this.pendingSettings = { value: settings, api: this.host.api() };
      return;
    }
    if (settings.mode !== this.host.state().taskAlerts.mode) this.generation++;
    const groupingCurrent = this.acceptGroupingSettings(settings);
    this.projectSettings(settings, groupingCurrent);
    if (settings.mode === "off") this.host.clear();
    const initial =
      this.initialSettingsApi !== null &&
      this.initialSettingsApi === this.host.api();
    if (initial) {
      this.initialSettingsApi = null;
      void this.initialize(settings);
    } else if (groupingCurrent) void this.syncGrouping(settings);
  }
  private projectSettings(
    settings: TaskAlertSettings,
    groupingCurrent: boolean,
  ): void {
    this.patch({
      mode: settings.mode,
      ...(groupingCurrent
        ? {
            grouping: settings.grouping,
            groupingUpdatedAt: settings.groupingUpdatedAt,
          }
        : {}),
      subscribed: settings.subscribed,
      error: settings.error,
    });
  }
  private acceptGroupingSettings(settings: TaskAlertSettings): boolean {
    const state = this.host.state().taskAlerts;
    const stamp = settings.groupingUpdatedAt;
    // An unchanged echo cannot erase a failed explicit choice. A newer Host
    // revision can resolve a lost response or a choice made in another window.
    const current =
      settings.publicKey !== this.groupingSettings?.publicKey ||
      stamp > state.groupingUpdatedAt ||
      (stamp === state.groupingUpdatedAt &&
        (!state.groupingError || settings.grouping === state.grouping));
    if (current) this.groupingSettings = settings;
    return current;
  }
  private finishUpdate(): void {
    this.patch({ busy: false });
    this.flushPendingSettings();
  }
  private flushPendingSettings(): void {
    const state = this.host.state().taskAlerts;
    if (state.busy || state.groupingBusy) return;
    const pending = this.pendingSettings;
    this.pendingSettings = null;
    if (!pending || pending.api !== this.host.api()) return;
    const { value: settings } = pending;
    // Same-choice echoes must not hide a later permission/setup failure.
    if (
      (this.initialSettingsApi !== null &&
        this.initialSettingsApi === pending.api) ||
      settings.mode !== state.mode ||
      settings.publicKey !== this.groupingSettings?.publicKey ||
      settings.groupingUpdatedAt > state.groupingUpdatedAt
    )
      this.applySettings(settings);
  }
  async initialize(initialSettings?: TaskAlertSettings): Promise<void> {
    this.captureTarget();
    this.refreshPermission();
    const api = this.host.api();
    if (!api) return;
    const generation = this.generation;
    const current = () =>
      generation === this.generation && api === this.host.api();
    const groupingGeneration = this.groupingGeneration;
    try {
      let settings = initialSettings ?? (await api.taskAlertSettings());
      if (!current()) return;
      this.initialSettingsApi = null;
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
        if (!current()) return;
        if (
          browserNotificationPermission() !== "granted" ||
          encoded !== settings.publicKey
        ) {
          if (settings.subscribed)
            settings = await this.save(undefined, null, undefined, api);
        } else if (subscription!.endpoint !== settings.endpoint) {
          // Browser enrollment can succeed even if its Host registration fails
          // or times out. Reconcile the existing subscription, not a new one:
          // no permission prompt, no subscribe(), and no rewrite of intent.
          // A retained endpoint with subscribed=false was explicitly expired;
          // only a different browser subscription can repair that destination.
          settings = await this.save(
            undefined,
            subscription!.toJSON(),
            undefined,
            api,
          );
        }
      } else {
        await this.updateEnrollment(() => this.unsubscribe(current));
      }
      if (!current()) return;
      const groupingCurrent =
        groupingGeneration === this.groupingGeneration &&
        this.acceptGroupingSettings(settings);
      this.projectSettings(settings, groupingCurrent);
      if (groupingCurrent) await this.syncGrouping(settings);
    } catch (error) {
      if (current())
        this.patch({
          error:
            error instanceof Error
              ? error.message
              : "Notification setup is unavailable",
        });
    }
  }

  private async unsubscribe(current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    const registration = await navigator.serviceWorker?.getRegistration();
    if (!current()) return false;
    const subscription = await registration?.pushManager?.getSubscription();
    if (!current()) return false;
    await subscription?.unsubscribe();
    return current();
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
    grouping?: TaskNotificationGrouping,
    api = this.host.api(),
  ): Promise<TaskAlertSettings> {
    if (!api) return Promise.reject(new Error("Connect to the Host first"));
    const operation = this.writes
      .catch(() => {})
      .then(() => {
        if (this.host.api() !== api)
          throw new Error(
            "The Host connection changed before notification settings were saved",
          );
        return api.configureTaskAlerts(mode, subscription, grouping);
      });
    this.writes = operation;
    return operation;
  }
  private workerRequest(worker: ServiceWorker, data: object): Promise<void> {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error("Notification service timed out"));
      }, 5_000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timeout);
        channel.port1.close();
        data?.error ? reject(new Error(data.error)) : resolve();
      };
      worker.postMessage(data, [channel.port2]);
    });
  }
  private async syncGrouping(
    settings: Pick<
      TaskAlertSettings,
      "grouping" | "groupingUpdatedAt" | "publicKey"
    >,
  ): Promise<boolean> {
    const sequence = ++this.groupingSync;
    const api = this.host.api();
    const { grouping, groupingUpdatedAt: updatedAt } = settings;
    const current = () =>
      sequence === this.groupingSync &&
      api === this.host.api() &&
      this.groupingSettings?.publicKey === settings.publicKey &&
      this.host.state().taskAlerts.grouping === grouping &&
      this.host.state().taskAlerts.groupingUpdatedAt === updatedAt;
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (!current()) return false;
      if (registration?.active)
        await this.workerRequest(registration.active, {
          type: "inspire-notification-settings",
          grouping,
          updatedAt,
          owner: settings.publicKey,
        });
      if (current()) this.patch({ groupingError: null });
      return true;
    } catch (error) {
      if (current())
        this.patch({
          groupingError:
            error instanceof Error
              ? error.message
              : "Could not update notification grouping",
        });
      return false;
    }
  }
  async setGrouping(grouping: TaskNotificationGrouping): Promise<boolean> {
    const generation = ++this.groupingGeneration;
    const api = this.host.api();
    const current = () =>
      generation === this.groupingGeneration && api === this.host.api();
    this.patch({ grouping, groupingBusy: true, groupingError: null });
    try {
      const settings = await this.save(undefined, undefined, grouping);
      if (!current()) return false;
      this.groupingSettings = settings;
      this.patch({
        grouping: settings.grouping,
        groupingUpdatedAt: settings.groupingUpdatedAt,
      });
      return await this.syncGrouping(settings);
    } catch (error) {
      if (current())
        this.patch({
          groupingError:
            error instanceof Error
              ? error.message
              : "Could not save notification grouping",
        });
      return false;
    } finally {
      if (current()) {
        this.patch({ groupingBusy: false });
        this.flushPendingSettings();
      }
    }
  }
  async setMode(mode: CompletionAttentionPreference): Promise<boolean> {
    const generation = ++this.generation;
    const api = this.host.api();
    const current = () =>
      generation === this.generation && this.host.api() === api;
    this.initialSettingsApi = null;
    this.pendingSettings = null;
    this.patch({ mode, busy: true, error: null, testResult: null });
    if (mode === "off") this.host.clear();
    // Request permission before awaiting Host I/O: iOS needs this user gesture.
    const permission =
      mode === "desktop"
        ? requestBrowserNotificationPermission()
        : Promise.resolve(browserNotificationPermission());
    try {
      // Save the gesture's intent while permission is pending. Its later
      // result may fill in transport, but cannot rewrite another window's Off.
      const [granted, saved] = await Promise.all([
        permission,
        this.save(mode, mode === "desktop" ? undefined : null, undefined, api),
      ]);
      if (!current()) return false;
      this.patch({ permission: granted, subscribed: saved.subscribed });
      return await this.updateEnrollment(async () => {
        if (!current()) return false;
        if (mode !== "desktop") {
          // Disable the server destination first; failure to unsubscribe cannot reactivate it.
          return this.unsubscribe(current);
        }
        if (granted !== "granted") {
          const disabled = await this.save(undefined, null, undefined, api);
          if (current()) this.patch({ subscribed: disabled.subscribed });
          return false;
        }
        const registration = await this.registration();
        if (!current()) return false;
        if (!registration.pushManager)
          throw new Error(
            "Background push is unavailable; notifications work while Inspire is open.",
          );
        let subscription = await registration.pushManager.getSubscription();
        if (!current()) return false;
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
            if (!current()) return false;
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
        if (!current()) {
          if (this.host.state().taskAlerts.mode !== "desktop")
            await subscription.unsubscribe();
          return false;
        }
        // Enrollment fills in transport, not intent: another window may have
        // disabled alerts while the browser was creating this subscription.
        const enrolled = await this.save(
          undefined,
          subscription.toJSON(),
          undefined,
          api,
        );
        if (!current()) return false;
        this.patch({ subscribed: enrolled.subscribed, error: enrolled.error });
        if (enrolled.mode !== "desktop") {
          this.pendingSettings = { value: enrolled, api };
          await subscription.unsubscribe();
          return false;
        }
        return true;
      });
    } catch (error) {
      if (current())
        this.patch({
          error:
            error instanceof Error
              ? error.message
              : "Notification setup failed",
        });
      return false;
    } finally {
      if (current()) this.finishUpdate();
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
    // The worker also consumes foreground results so it can remove that
    // session from an existing project notification without losing its peers.
    if (mode !== "desktop") {
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
      await this.workerRequest(worker, {
        type: "inspire-notification-display",
        notification: event,
      });
      if (!current()) return;
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
    const api = this.host.api();
    const generation = this.generation;
    const current = () =>
      this.host.api() === api && this.generation === generation;
    this.patch({ busy: true, testResult: null, error: null });
    try {
      const result = await api?.testTaskAlert();
      // Push delivery can beat the HTTP response. Do not downgrade a worker's
      // display acceptance to the earlier "sent" stage when that response arrives.
      if (
        current() &&
        result &&
        this.host.state().taskAlerts.testResult === null
      )
        this.patch({
          testResult:
            result.transport === "push"
              ? "Sent to the browser push service. Check your system notifications."
              : "Sent to this page for display.",
        });
    } catch (error) {
      if (current())
        this.patch({
          error:
            error instanceof Error ? error.message : "Test notification failed",
        });
    } finally {
      if (current()) this.finishUpdate();
    }
  }
}
