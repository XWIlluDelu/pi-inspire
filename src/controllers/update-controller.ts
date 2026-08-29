import {
  type AvailableUpdate,
  type PiUpdateCheckResponse,
  UPDATE_SNOOZE_MS,
  type UpdateCheckResponse,
} from "../../shared/contracts";
import type { Api } from "../api";
import {
  availableUpdates,
  type AvailableUpdates,
} from "../update-availability";

const UPDATE_SNOOZE_STORAGE_KEY = "inspire.update-snooze";
const AUTOMATIC_UPDATE_CHECK_DAY_KEY = "inspire.update-check-day";
const AUTOMATIC_UPDATE_CHECK_HOUR = 8;

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
  identity?: string;
  /** Pre-combined-notice compatibility for an INSΠRE-only snooze. */
  version?: string;
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

function savedSnoozeUntil(
  updates: AvailableUpdates,
  now: number,
): number | null {
  const storage = updateStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(UPDATE_SNOOZE_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedUpdateSnooze>;
    const dismissedAt = Number(saved.dismissedAt);
    const elapsed = now - dismissedAt;
    const legacyInspireMatch =
      !saved.identity &&
      typeof saved.version === "string" &&
      !updates.pi &&
      updates.extensions.length === 0 &&
      updates.inspire?.latestVersion === saved.version;
    if (
      (saved.identity !== updates.identity && !legacyInspireMatch) ||
      !Number.isFinite(dismissedAt) ||
      elapsed < 0 ||
      elapsed >= UPDATE_SNOOZE_MS
    ) {
      removeSavedSnooze(storage);
      return null;
    }
    return dismissedAt + UPDATE_SNOOZE_MS;
  } catch {
    removeSavedSnooze(storage);
    return null;
  }
}

function saveSnooze(identity: string, dismissedAt: number): void {
  const storage = updateStorage();
  if (!storage) return;
  try {
    storage.setItem(
      UPDATE_SNOOZE_STORAGE_KEY,
      JSON.stringify({ identity, dismissedAt } satisfies SavedUpdateSnooze),
    );
  } catch {
    // In-memory snoozing still lasts for this page lifetime.
  }
}

function localCheckDay(now: Date): string | null {
  if (now.getHours() < AUTOMATIC_UPDATE_CHECK_HOUR) return null;
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function savedAutomaticCheckDay(storage: Storage | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(AUTOMATIC_UPDATE_CHECK_DAY_KEY);
  } catch {
    return null;
  }
}

function saveAutomaticCheckDay(storage: Storage | null, day: string): void {
  if (!storage) return;
  try {
    storage.setItem(AUTOMATIC_UPDATE_CHECK_DAY_KEY, day);
  } catch {
    // The in-memory owner still prevents repeats for this page lifetime.
  }
}

/** Owns update observations, daily prompt-triggering, and notice snoozing. */
export class UpdateController {
  private requestGeneration = 0;
  private inspireRequest = 0;
  private piRequest = 0;
  private automaticCheckDay: string | null = null;
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: UpdateControllerHost) {}

  invalidateForTransportReplacement(): void {
    this.requestGeneration += 1;
    this.inspireRequest += 1;
    this.piRequest += 1;
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
  }

  /** The first accepted prompt after 08:00 browser-local time owns today's
   * cache-aware automatic check. No clock or page lifecycle initiates one. */
  promptAccepted(): void {
    const day = localCheckDay(new Date());
    if (!day) return;
    const storage = updateStorage();
    if (
      this.automaticCheckDay === day ||
      savedAutomaticCheckDay(storage) === day
    )
      return;
    if (!this.host.api()) return;
    this.automaticCheckDay = day;
    saveAutomaticCheckDay(storage, day);
    this.checkAll(false);
  }

  refreshInspire(): void {
    this.checkInspire(true);
  }

  refreshPi(): void {
    this.checkPi(true);
  }

  snooze(): void {
    const updates = availableUpdates(this.host.state());
    if (!updates) return;
    const dismissedAt = Date.now();
    const until = dismissedAt + UPDATE_SNOOZE_MS;
    saveSnooze(updates.identity, dismissedAt);
    this.host.patch({ updateSnoozedUntil: until });
    this.scheduleSnoozeEnd(updates.identity, until);
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

  private checkAll(force: boolean): void {
    this.checkInspire(force);
    this.checkPi(force);
  }

  private checkInspire(force: boolean): void {
    const api = this.host.api();
    if (!api || this.host.state().inspireUpdateChecking) return;
    void this.requestInspire(
      api,
      force,
      this.requestGeneration,
      this.host.transportGeneration(),
    );
  }

  private checkPi(force: boolean): void {
    const api = this.host.api();
    if (!api || this.host.state().piUpdateChecking) return;
    void this.requestPi(
      api,
      force,
      this.requestGeneration,
      this.host.transportGeneration(),
    );
  }

  private async requestPi(
    api: Pick<Api, "update" | "piUpdate">,
    force: boolean,
    requestGeneration: number,
    transportGeneration: number,
  ): Promise<void> {
    const request = ++this.piRequest;
    this.host.patch({ piUpdateChecking: true });
    try {
      const piUpdateCheck = await api.piUpdate(force);
      if (
        request !== this.piRequest ||
        !this.owns(api, requestGeneration, transportGeneration)
      )
        return;
      this.host.patch({ piUpdateCheck });
    } catch {
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
    } finally {
      if (
        request === this.piRequest &&
        this.owns(api, requestGeneration, transportGeneration)
      ) {
        this.host.patch({ piUpdateChecking: false });
        this.syncNoticeSnooze();
      }
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
      ) {
        this.host.patch({ inspireUpdateChecking: false });
        this.syncNoticeSnooze();
      }
    }
  }

  private apply(response: UpdateCheckResponse): void {
    const patch: Partial<UpdateControllerState> = {
      inspireUpdateCheck: response,
    };
    if (response.kind === "current" || response.kind === "unreleased")
      patch.availableUpdate = null;
    else if (response.kind === "available")
      patch.availableUpdate = response.update;
    this.host.patch(patch);
  }

  private syncNoticeSnooze(): void {
    const state = this.host.state();
    if (state.inspireUpdateChecking || state.piUpdateChecking) return;
    const updates = availableUpdates(state);
    if (!updates) {
      removeSavedSnooze(updateStorage());
      if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
      this.snoozeTimer = null;
      if (state.updateSnoozedUntil !== null)
        this.host.patch({ updateSnoozedUntil: null });
      return;
    }

    const until = savedSnoozeUntil(updates, Date.now());
    if (state.updateSnoozedUntil !== until)
      this.host.patch({ updateSnoozedUntil: until });
    if (until) this.scheduleSnoozeEnd(updates.identity, until);
    else if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer);
      this.snoozeTimer = null;
    }
  }

  private scheduleSnoozeEnd(identity: string, until: number): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = setTimeout(
      () => {
        this.snoozeTimer = null;
        const state = this.host.state();
        if (
          availableUpdates(state)?.identity !== identity ||
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
