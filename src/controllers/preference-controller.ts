import {
  type ActivityFoldVisibilityPreference,
  type AssistantRoundDisplayPreference,
  type CompletionAttentionPreference,
  type ContentTextSizePreference,
  type DesktopSendKeyPreference,
  type InspirePreferences,
  type LaunchPreference,
  type ModelIdentity,
  modelIdentityKey,
  type PalettePreference,
  type ProjectDisplayPreference,
  type ReadingWidthPreference,
  type ThemePreference,
  type ToolVisibilityPreference,
  type VisibilityPreference,
  defaultInterfaceSettings,
  defaultPreferences,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";
import type { AppState } from "../app-state";

interface PreferenceControllerHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  api(): Api | null;
  transportGeneration(): number;
  notify(kind: "info" | "warning" | "error", text: string): void;
  handleAuthFailure(): void;
  curationChanged(hydrate: boolean): void;
  clearCompletionAttention(): void;
}

/** Owns field-scoped optimistic preference writes and their confirmed host
 * baseline. AppStore remains the publisher; this controller keeps write
 * ordering and stale-response ownership out of unrelated session logic. */
export class PreferenceController {
  private writes: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  /** Newest local intent, retained after settlement so stale operations can
   * distinguish a later ABA edit from an unchanged value. */
  private fieldOwners = new Map<keyof InspirePreferences, number>();
  private pendingFieldOwners = new Map<keyof InspirePreferences, number>();
  private confirmedFieldOwners = new Map<keyof InspirePreferences, number>();
  private completionAttentionRequest = 0;
  private confirmedPrefs: InspirePreferences = defaultPreferences;

  constructor(private readonly host: PreferenceControllerHost) {}

  flush(): Promise<unknown> {
    return this.writes;
  }

  confirmed(): InspirePreferences {
    return this.confirmedPrefs;
  }

  captureOwners(): ReadonlyMap<keyof InspirePreferences, number> {
    return new Map(this.fieldOwners);
  }

  /** A write already pending when bootstrap starts may settle on either side
   * of that snapshot. Omitting its field makes reconciliation preserve the
   * visible intent while adopting authority as its rollback baseline. */
  captureBootstrapOwners(): ReadonlyMap<keyof InspirePreferences, number> {
    const owners = new Map(this.fieldOwners);
    for (const field of this.pendingFieldOwners.keys()) owners.delete(field);
    return owners;
  }

  reconcile(
    authoritative: InspirePreferences,
    baselineOwners: ReadonlyMap<keyof InspirePreferences, number>,
  ): InspirePreferences {
    const visible = { ...authoritative };
    const confirmed = { ...authoritative };
    for (const field of Object.keys(authoritative) as Array<
      keyof InspirePreferences
    >) {
      const baselineOwner = baselineOwners.get(field);
      if (this.fieldOwners.get(field) === baselineOwner) {
        this.confirmedFieldOwners.delete(field);
        continue;
      }
      Object.assign(visible, { [field]: this.host.state().prefs[field] });
      // Preserve a completed newer write. For a pending or refused newer
      // intent, this response is the newest confirmed baseline to roll back to.
      if (this.confirmedFieldOwners.get(field) === baselineOwner) {
        this.confirmedFieldOwners.delete(field);
      } else {
        Object.assign(confirmed, { [field]: this.confirmedPrefs[field] });
      }
    }
    this.confirmedPrefs = confirmed;
    return visible;
  }

  private curationMutationBlocked(): boolean {
    const state = this.host.state();
    return Boolean(state.deletingSessionId || state.clearingHidden);
  }

  private isCurationPatch(patch: Partial<InspirePreferences>): boolean {
    return (
      "pinnedSessionIds" in patch ||
      "hiddenSessionIds" in patch ||
      "pinnedProjectCwds" in patch ||
      "hiddenProjectCwds" in patch
    );
  }

  private curationIds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedSessionIds, ...prefs.hiddenSessionIds]);
  }

  private curationProjectCwds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedProjectCwds, ...prefs.hiddenProjectCwds]);
  }

  private curationDiffers(
    previous: InspirePreferences,
    next: InspirePreferences,
  ): boolean {
    const differs = (left: readonly string[], right: readonly string[]) =>
      left.length !== right.length ||
      left.some((value, index) => value !== right[index]);
    return (
      differs(previous.pinnedSessionIds, next.pinnedSessionIds) ||
      differs(previous.hiddenSessionIds, next.hiddenSessionIds) ||
      differs(previous.pinnedProjectCwds, next.pinnedProjectCwds) ||
      differs(previous.hiddenProjectCwds, next.hiddenProjectCwds)
    );
  }

  private curationNeedsHydration(
    previous: InspirePreferences,
    previousConfirmed: InspirePreferences,
    next: InspirePreferences,
    nextConfirmed: InspirePreferences,
  ): boolean {
    const previousIds = new Set([
      ...this.curationIds(previous),
      ...this.curationIds(previousConfirmed),
    ]);
    const nextIds = new Set([
      ...this.curationIds(next),
      ...this.curationIds(nextConfirmed),
    ]);
    const loadedIds = new Set(
      this.host.state().sessions.map((session) => session.id),
    );
    for (const id of nextIds) {
      if (!previousIds.has(id) && !loadedIds.has(id)) return true;
    }
    const previousCwds = new Set([
      ...this.curationProjectCwds(previous),
      ...this.curationProjectCwds(previousConfirmed),
    ]);
    const nextCwds = new Set([
      ...this.curationProjectCwds(next),
      ...this.curationProjectCwds(nextConfirmed),
    ]);
    for (const cwd of nextCwds) {
      if (!previousCwds.has(cwd)) return true;
    }
    return false;
  }

  private save(patch: Partial<InspirePreferences>): void {
    const fields = Object.keys(patch) as Array<keyof InspirePreferences>;
    const owner = ++this.sequence;
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    for (const field of fields) {
      this.fieldOwners.set(field, owner);
      this.pendingFieldOwners.set(field, owner);
    }
    const responseOwners = this.captureOwners();
    const curationPatch = this.isCurationPatch(patch);
    const previousPrefs = this.host.state().prefs;
    const nextPrefs = { ...previousPrefs, ...patch };
    const hydrateCuration =
      curationPatch &&
      this.curationNeedsHydration(
        previousPrefs,
        this.confirmedPrefs,
        nextPrefs,
        this.confirmedPrefs,
      );
    this.host.patch({ prefs: nextPrefs });
    if (curationPatch) this.host.curationChanged(hydrateCuration);

    this.writes = this.writes
      .then(async () => {
        if (!api) throw new Error("Not connected to the Inspire host");
        const authoritative = await api.savePreferences(patch);
        const previousPrefs = this.host.state().prefs;
        const previousConfirmed = this.confirmedPrefs;
        for (const field of fields) {
          this.confirmedFieldOwners.set(field, owner);
          if (this.pendingFieldOwners.get(field) === owner)
            this.pendingFieldOwners.delete(field);
        }
        let nextPrefs = previousPrefs;
        if (
          this.host.api() === api &&
          this.host.transportGeneration() === transportGeneration
        ) {
          nextPrefs = this.reconcile(authoritative, responseOwners);
          this.host.patch({ prefs: nextPrefs });
        } else {
          this.confirmedPrefs = { ...previousConfirmed, ...patch };
        }
        if (
          curationPatch ||
          this.curationDiffers(previousPrefs, nextPrefs) ||
          this.curationDiffers(previousConfirmed, this.confirmedPrefs)
        ) {
          this.host.curationChanged(
            this.curationNeedsHydration(
              previousPrefs,
              previousConfirmed,
              nextPrefs,
              this.confirmedPrefs,
            ),
          );
        }
      })
      .catch((error: unknown) => {
        // Only fields still owned by this write roll back. Equality is not an
        // ownership test because a newer edit may cycle back to the same value.
        const stale = fields.filter(
          (field) => this.fieldOwners.get(field) === owner,
        );
        const previousPrefs = this.host.state().prefs;
        if (stale.length > 0) {
          const restored = Object.fromEntries(
            stale.map((field) => [field, this.confirmedPrefs[field]]),
          ) as Partial<InspirePreferences>;
          this.host.patch({
            prefs: { ...this.host.state().prefs, ...restored },
          });
        }
        for (const field of fields) {
          if (this.pendingFieldOwners.get(field) === owner)
            this.pendingFieldOwners.delete(field);
          // A refused newest intent no longer needs to fence an authoritative
          // snapshot that was captured while this write was pending.
          if (this.fieldOwners.get(field) === owner)
            this.fieldOwners.delete(field);
        }
        if (curationPatch) {
          const hydrateRestoredCuration = this.curationNeedsHydration(
            previousPrefs,
            this.confirmedPrefs,
            this.host.state().prefs,
            this.confirmedPrefs,
          );
          this.host.curationChanged(hydrateRestoredCuration);
        }
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          this.host.api() === api &&
          this.host.transportGeneration() === transportGeneration
        ) {
          this.host.handleAuthFailure();
        } else {
          this.host.notify(
            "warning",
            error instanceof Error
              ? error.message
              : "Failed to save the preference",
          );
        }
      });
  }

  rememberModel(model: ModelIdentity): void {
    const recentModelIds = [
      model,
      ...this.host
        .state()
        .prefs.recentModelIds.filter(
          (candidate) =>
            modelIdentityKey(candidate) !== modelIdentityKey(model),
        ),
    ].slice(0, 8);
    this.save({ recentModelIds });
  }

  setTheme(theme: ThemePreference): void {
    this.save({ theme });
  }

  setPalette(palette: PalettePreference): void {
    this.save({ palette });
  }

  setContentTextSize(contentTextSize: ContentTextSizePreference): void {
    this.save({ contentTextSize });
  }

  setReadingWidth(readingWidth: ReadingWidthPreference): void {
    this.save({ readingWidth });
  }

  setLaunch(launch: LaunchPreference): void {
    this.save({ launch });
  }

  setDesktopSendKey(desktopSendKey: DesktopSendKeyPreference): void {
    this.save({ desktopSendKey });
  }

  async setCompletionAttention(
    completionAttention: CompletionAttentionPreference,
  ): Promise<boolean> {
    const request = ++this.completionAttentionRequest;
    if (completionAttention === "desktop") {
      const NotificationApi =
        typeof window !== "undefined" ? window.Notification : undefined;
      if (!NotificationApi) {
        this.host.notify(
          "warning",
          "Desktop notifications are not supported by this browser",
        );
        return false;
      }
      let permission = NotificationApi.permission;
      if (permission !== "granted") {
        try {
          permission = await NotificationApi.requestPermission();
        } catch {
          if (request !== this.completionAttentionRequest) return false;
          this.host.notify(
            "warning",
            "The browser could not request notification permission",
          );
          return false;
        }
      }
      if (request !== this.completionAttentionRequest) return false;
      if (permission !== "granted") {
        this.host.notify(
          "warning",
          permission === "denied"
            ? "Desktop notification permission was denied"
            : "Desktop notification permission was not granted",
        );
        return false;
      }
    }
    if (request !== this.completionAttentionRequest) return false;
    if (completionAttention === "off") this.host.clearCompletionAttention();
    this.save({ completionAttention });
    return true;
  }

  setProjectDisplay(projectDisplay: ProjectDisplayPreference): void {
    this.save({ projectDisplay });
  }

  setThinkingVisibility(thinkingVisibility: VisibilityPreference): void {
    this.save({ thinkingVisibility });
  }

  setToolVisibility(toolVisibility: ToolVisibilityPreference): void {
    this.save({ toolVisibility });
  }

  setActivityFoldVisibility(
    activityFoldVisibility: ActivityFoldVisibilityPreference,
  ): void {
    this.save({ activityFoldVisibility });
  }

  setAssistantRoundDisplay(
    assistantRoundDisplay: AssistantRoundDisplayPreference,
  ): void {
    this.save({ assistantRoundDisplay });
  }

  restoreDefaults(): void {
    this.completionAttentionRequest += 1;
    this.host.clearCompletionAttention();
    this.save({ ...defaultInterfaceSettings });
  }

  toggleNavGroup(cwd: string): void {
    if (this.curationMutationBlocked()) return;
    const current = this.host.state().prefs.navCollapsedGroups;
    this.save({
      navCollapsedGroups: current.includes(cwd)
        ? current.filter((item) => item !== cwd)
        : [...current, cwd],
    });
  }

  toggleSessionPin(id: string): void {
    if (this.curationMutationBlocked()) return;
    const { pinnedSessionIds, hiddenSessionIds } = this.host.state().prefs;
    const pinned = pinnedSessionIds.includes(id);
    this.save({
      pinnedSessionIds: pinned
        ? pinnedSessionIds.filter((candidate) => candidate !== id)
        : [id, ...pinnedSessionIds],
      ...(!pinned && hiddenSessionIds.includes(id)
        ? {
            hiddenSessionIds: hiddenSessionIds.filter(
              (candidate) => candidate !== id,
            ),
          }
        : {}),
    });
  }

  toggleSessionHidden(id: string): void {
    if (this.curationMutationBlocked()) return;
    const { pinnedSessionIds, hiddenSessionIds } = this.host.state().prefs;
    const hidden = hiddenSessionIds.includes(id);
    this.save({
      hiddenSessionIds: hidden
        ? hiddenSessionIds.filter((candidate) => candidate !== id)
        : [id, ...hiddenSessionIds],
      ...(!hidden && pinnedSessionIds.includes(id)
        ? {
            pinnedSessionIds: pinnedSessionIds.filter(
              (candidate) => candidate !== id,
            ),
          }
        : {}),
    });
  }

  toggleProjectPin(cwd: string): void {
    if (this.curationMutationBlocked()) return;
    const { pinnedProjectCwds, hiddenProjectCwds } = this.host.state().prefs;
    const pinned = pinnedProjectCwds.includes(cwd);
    this.save({
      pinnedProjectCwds: pinned
        ? pinnedProjectCwds.filter((item) => item !== cwd)
        : [cwd, ...pinnedProjectCwds],
      ...(!pinned && hiddenProjectCwds.includes(cwd)
        ? {
            hiddenProjectCwds: hiddenProjectCwds.filter((item) => item !== cwd),
          }
        : {}),
    });
  }

  toggleProjectHidden(cwd: string): void {
    if (this.curationMutationBlocked()) return;
    const { pinnedProjectCwds, hiddenProjectCwds } = this.host.state().prefs;
    const hidden = hiddenProjectCwds.includes(cwd);
    this.save({
      hiddenProjectCwds: hidden
        ? hiddenProjectCwds.filter((item) => item !== cwd)
        : [cwd, ...hiddenProjectCwds],
      ...(!hidden && pinnedProjectCwds.includes(cwd)
        ? {
            pinnedProjectCwds: pinnedProjectCwds.filter((item) => item !== cwd),
          }
        : {}),
    });
  }
}
