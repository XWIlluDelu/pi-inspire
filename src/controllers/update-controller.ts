import {
  type AvailableUpdate,
  type PiUpdateCheckResponse,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SNOOZE_MS,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import type { Api } from "../api";

const UPDATE_SNOOZE_STORAGE_KEY = "inspire.update-snooze";

interface UpdateControllerState {
  version: string;
  piVersion: string;
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
  inspireUpdateChecking: boolean;
  piUpdateChecking: boolean;
  availableUpdate: AvailableUpdate | null;
  updateSnoozedUntil: number | null;
}

interface UpdateControllerHost {
  state(): UpdateControllerState;
  patch(patch: Partial<UpdateControllerState>): void;
  api(): Pick<Api, "update" | "piUpdate"> | null;
  transportGeneration(): number;
}

interface SavedUpdateSnooze {
  version: string;
  dismissedAt: number;
}

function updateStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function removeSavedSnooze(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(UPDATE_SNOOZE_STORAGE_KEY);
  } catch {
    // The status remains usable when browser storage is unavailable.
  }
}

function savedSnoozeUntil(version: string, now: number): number | null {
  const storage = updateStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(UPDATE_SNOOZE_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedUpdateSnooze>;
    const elapsed = now - Number(saved.dismissedAt);
    if (
      saved.version !== version ||
      !Number.isFinite(saved.dismissedAt) ||
      elapsed < 0 ||
      elapsed >= UPDATE_SNOOZE_MS
    ) {
      removeSavedSnooze(storage);
      return null;
    }
    return Number(saved.dismissedAt) + UPDATE_SNOOZE_MS;
  } catch {
    removeSavedSnooze(storage);
    return null;
  }
}

function saveSnooze(version: string, dismissedAt: number): void {
  const storage = updateStorage();
  if (!storage) return;
  try {
    storage.setItem(
      UPDATE_SNOOZE_STORAGE_KEY,
      JSON.stringify({ version, dismissedAt } satisfies SavedUpdateSnooze),
    );
  } catch {
    // In-memory snoozing still lasts for this page lifetime.
  }
}

/** Owns update observations and the browser-local Inspire-release snooze. */
export class UpdateController {
  private requestGeneration = 0;
  private inspireRequest = 0;
  private piRequest = 0;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: UpdateControllerHost) {}

  invalidateForTransportReplacement(): void {
    this.requestGeneration += 1;
    this.inspireRequest += 1;
    this.piRequest += 1;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    const state = this.host.state();
    if (state.inspireUpdateChecking || state.piUpdateChecking) {
      this.host.patch({
        inspireUpdateChecking: false,
        piUpdateChecking: false,
      });
    }
  }

  start(): void {
    this.invalidateForTransportReplacement();
    const api = this.host.api();
    if (!api) return;
    const requestGeneration = this.requestGeneration;
    const transportGeneration = this.host.transportGeneration();
    void this.inspect(api, requestGeneration, transportGeneration);
  }

  refreshInspire(): void {
    const api = this.host.api();
    if (!api || this.host.state().inspireUpdateChecking) return;
    void this.requestInspire(
      api,
      true,
      this.requestGeneration,
      this.host.transportGeneration(),
    );
  }

  refreshPi(): void {
    const api = this.host.api();
    if (!api || this.host.state().piUpdateChecking) return;
    const request = ++this.piRequest;
    const requestGeneration = this.requestGeneration;
    const transportGeneration = this.host.transportGeneration();
    this.host.patch({ piUpdateChecking: true });
    void api
      .piUpdate(true)
      .then((piUpdateCheck) => {
        if (
          request !== this.piRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.host.patch({ piUpdateCheck });
      })
      .catch(() => {
        if (
          request !== this.piRequest ||
          !this.owns(api, requestGeneration, transportGeneration)
        )
          return;
        this.host.patch({
          piUpdateCheck: {
            currentVersion: this.host.state().piVersion,
            pi: { kind: "unavailable" },
            extensions: { kind: "unavailable" },
          },
        });
      })
      .finally(() => {
        if (
          request === this.piRequest &&
          this.owns(api, requestGeneration, transportGeneration)
        )
          this.host.patch({ piUpdateChecking: false });
      });
  }

  snooze(): void {
    const update = this.host.state().availableUpdate;
    if (!update) return;
    const dismissedAt = Date.now();
    const until = dismissedAt + UPDATE_SNOOZE_MS;
    saveSnooze(update.latestVersion, dismissedAt);
    this.host.patch({ updateSnoozedUntil: until });
    this.scheduleSnoozeEnd(update.latestVersion, until);
  }

  private owns(
    api: Pick<Api, "update" | "piUpdate">,
    requestGeneration: number,
    transportGeneration: number,
  ): boolean {
    return (
      requestGeneration === this.requestGeneration &&
      transportGeneration === this.host.transportGeneration() &&
      api === this.host.api()
    );
  }

  private async inspect(
    api: Pick<Api, "update" | "piUpdate">,
    requestGeneration: number,
    transportGeneration: number,
  ): Promise<void> {
    await this.requestInspire(
      api,
      false,
      requestGeneration,
      transportGeneration,
    );
    if (this.owns(api, requestGeneration, transportGeneration)) {
      this.checkTimer = setTimeout(() => {
        this.checkTimer = null;
        void this.inspect(api, requestGeneration, transportGeneration);
      }, UPDATE_CHECK_INTERVAL_MS);
    }
  }

  private async requestInspire(
    api: Pick<Api, "update" | "piUpdate">,
    force: boolean,
    requestGeneration: number,
    transportGeneration: number,
  ): Promise<void> {
    const request = ++this.inspireRequest;
    this.host.patch({ inspireUpdateChecking: true });
    try {
      const response = await api.update(force);
      if (
        request !== this.inspireRequest ||
        !this.owns(api, requestGeneration, transportGeneration)
      )
        return;
      this.apply(response);
    } catch {
      if (
        request !== this.inspireRequest ||
        !this.owns(api, requestGeneration, transportGeneration)
      )
        return;
      if (!this.host.state().inspireUpdateCheck)
        this.host.patch({ inspireUpdateCheck: { kind: "unavailable" } });
    } finally {
      if (
        request === this.inspireRequest &&
        this.owns(api, requestGeneration, transportGeneration)
      )
        this.host.patch({ inspireUpdateChecking: false });
    }
  }

  private apply(response: UpdateCheckResponse): void {
    this.host.patch({ inspireUpdateCheck: response });
    if (response.kind === "unavailable") return;
    if (response.kind === "current" || response.kind === "unreleased") {
      removeSavedSnooze(updateStorage());
      if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
      this.snoozeTimer = null;
      this.host.patch({ availableUpdate: null, updateSnoozedUntil: null });
      return;
    }

    const until = savedSnoozeUntil(response.update.latestVersion, Date.now());
    this.host.patch({
      availableUpdate: response.update,
      updateSnoozedUntil: until,
    });
    if (until) this.scheduleSnoozeEnd(response.update.latestVersion, until);
    else if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer);
      this.snoozeTimer = null;
    }
  }

  private scheduleSnoozeEnd(version: string, until: number): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = setTimeout(
      () => {
        this.snoozeTimer = null;
        const state = this.host.state();
        if (
          state.availableUpdate?.latestVersion !== version ||
          state.updateSnoozedUntil !== until
        )
          return;
        removeSavedSnooze(updateStorage());
        this.host.patch({ updateSnoozedUntil: null });
      },
      Math.max(0, until - Date.now()),
    );
  }
}
