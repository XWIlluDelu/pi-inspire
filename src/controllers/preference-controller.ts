import {
  defaultInterfaceSettings,
  type InspirePreferences,
  type ModelIdentity,
  modelIdentityKey,
  type PreferencePublication,
} from "../../shared/contracts";
import { type Api, ApiError } from "../api";
import type { AppState } from "../app-state";
import { isTransientFailure } from "../recovery-backoff";
import { sessionCurationOwners } from "../session-curation";

type PreferenceKey = keyof InspirePreferences;
type PreferencePatch = Partial<InspirePreferences>;
type CurationKey =
  | "pinnedSessionIds"
  | "hiddenSessionIds"
  | "pinnedProjectCwds"
  | "hiddenProjectCwds";

const CURATION_FIELDS: CurationKey[] = [
  "pinnedSessionIds",
  "hiddenSessionIds",
  "pinnedProjectCwds",
  "hiddenProjectCwds",
];

interface PreferenceControllerHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  api(): Api | null;
  notify(kind: "info" | "warning" | "error", text: string): void;
  handleAuthFailure(): void;
  curationChanged(hydrate: boolean): void;
  clearCompletionAttention(): void;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function toggle(items: string[], value: string): string[] {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [value, ...items];
}

/** A Host publication owns confirmed state; the latest local intent owns only
 * its desired preview. A transport loss never repeats a PATCH. */
export class PreferenceController {
  private writes: Promise<void> = Promise.resolve();
  private readonly desired = new Map<PreferenceKey, PreferencePatch>();
  private authority: string | null = null;
  private readyApi: Api | null = null;
  private pendingObservation = false;
  private revision = -1;
  private curationRevision = 0;

  constructor(private readonly host: PreferenceControllerHost) {}

  private desiredState(): Pick<
    AppState,
    "desiredPreferences" | "curationPending"
  > {
    return {
      desiredPreferences: Object.fromEntries(
        [...this.desired].map(([field, intent]) => [field, intent[field]]),
      ),
      curationPending: CURATION_FIELDS.some((field) => this.desired.has(field)),
    };
  }

  private clear(intent: PreferencePatch): void {
    for (const [field, owner] of this.desired) {
      if (owner === intent) this.desired.delete(field);
    }
  }

  invalidateTransport(): void {
    this.readyApi = null;
    this.writes = Promise.resolve();
    if (this.desired.size === 0) return;
    this.desired.clear();
    this.host.patch(this.desiredState());
  }

  bootstrap(
    authority: string,
    publication: PreferencePublication,
  ): InspirePreferences {
    this.readyApi = this.host.api();
    if (authority !== this.authority) {
      this.authority = authority;
      this.revision = -1;
      this.pendingObservation = false;
    }
    if (this.pendingObservation && this.readyApi)
      void this.observeAfterReplacement(this.readyApi);
    return this.accept(publication) ?? this.host.state().prefs;
  }

  private accept({ preferences, revision }: PreferencePublication) {
    if (!Number.isSafeInteger(revision) || revision <= this.revision)
      return null;
    this.revision = revision;
    return preferences;
  }

  publish(publication: PreferencePublication): void {
    const preferences = this.accept(publication);
    const previous = this.host.state().prefs;
    this.host.patch({
      ...(preferences ? { prefs: preferences } : {}),
      ...this.desiredState(),
    });
    if (
      !preferences ||
      CURATION_FIELDS.every((field) =>
        sameList(previous[field], preferences[field]),
      )
    )
      return;
    this.curationRevision++;
    const before = sessionCurationOwners(previous);
    const after = sessionCurationOwners(preferences);
    const loaded = new Set(
      this.host.state().sessions.map((session) => session.id),
    );
    this.host.curationChanged(
      [...after.ids].some((id) => !before.ids.has(id) && !loaded.has(id)) ||
        [...after.cwds].some((cwd) => !before.cwds.has(cwd)),
    );
  }

  private save(patch: PreferencePatch): void {
    const api = this.host.api();
    if (!api || this.readyApi !== api) return;
    const intent = { ...patch };
    const authority = this.authority;
    for (const field of Object.keys(patch) as PreferenceKey[])
      this.desired.set(field, intent);
    this.host.patch(this.desiredState());
    this.writes = this.writes.then(async () => {
      if (this.host.api() !== api) return;
      try {
        const publication = await api.json("savePreferences", { body: intent });
        if (this.host.api() !== api) return;
        this.clear(intent);
        this.publish(publication);
      } catch (error) {
        if (this.host.api() !== api) return;
        if (error instanceof ApiError && error.status === 401) {
          this.host.handleAuthFailure();
          return;
        }
        if (isTransientFailure(error)) {
          try {
            const observation = await api.json("preferences", {});
            if (this.host.api() !== api) return;
            if (this.matches(intent, observation.preferences))
              this.clear(intent);
            this.publish(observation);
            this.host.notify(
              "warning",
              "Preference save was not confirmed. Showing the value currently saved by the Host.",
            );
            return;
          } catch {
            if (this.host.api() !== api) return;
            // Keep the outstanding intent available for read-only recheck.
            this.host.notify(
              "warning",
              "Preference save was not confirmed. Refresh the workbench to check the saved value.",
            );
            return;
          }
        } else {
          this.clear(intent);
          this.host.patch(this.desiredState());
        }
        this.host.notify(
          "warning",
          error instanceof Error
            ? error.message
            : "Failed to save the preference",
        );
      } finally {
        if (this.host.api() !== api && this.authority === authority) {
          this.pendingObservation = true;
          const current = this.readyApi;
          if (current && current === this.host.api())
            void this.observeAfterReplacement(current);
        }
      }
    });
  }

  private async observeAfterReplacement(api: Api): Promise<void> {
    this.pendingObservation = false;
    try {
      const publication = await api.json("preferences", {});
      if (this.host.api() === api) this.publish(publication);
    } catch {
      // The next bootstrap still supplies the latest confirmed preferences.
    }
  }

  private matches(
    intent: PreferencePatch,
    confirmed: InspirePreferences,
  ): boolean {
    return (Object.keys(intent) as PreferenceKey[]).every(
      (field) =>
        JSON.stringify(intent[field]) === JSON.stringify(confirmed[field]),
    );
  }

  set<Field extends keyof typeof defaultInterfaceSettings>(
    field: Field,
    value: InspirePreferences[Field],
  ): void {
    this.save({ [field]: value });
  }

  rememberModel(model: ModelIdentity): void {
    const current =
      this.desired.get("recentModelIds")?.recentModelIds ??
      this.host.state().prefs.recentModelIds;
    const key = modelIdentityKey(model);
    if (current[0] && modelIdentityKey(current[0]) === key) return;
    this.save({
      recentModelIds: [
        { provider: model.provider, id: model.id },
        ...current.filter((candidate) => modelIdentityKey(candidate) !== key),
      ].slice(0, 8),
    });
  }

  restoreDefaults(): void {
    this.host.clearCompletionAttention();
    this.save(defaultInterfaceSettings);
  }

  toggleNavGroup(cwd: string): void {
    const { prefs, desiredPreferences } = this.host.state();
    const items =
      desiredPreferences.navCollapsedGroups ?? prefs.navCollapsedGroups;
    this.save({ navCollapsedGroups: toggle(items, cwd) });
  }

  private curationBlocked(): boolean {
    const state = this.host.state();
    return Boolean(
      state.deletingSessionId || state.clearingHidden || state.curationPending,
    );
  }

  private curate(key: CurationKey, opposite: CurationKey, value: string): void {
    if (this.curationBlocked()) return;
    const prefs = this.host.state().prefs;
    this.save({
      [key]: toggle(prefs[key], value),
      ...(!prefs[key].includes(value) && prefs[opposite].includes(value)
        ? { [opposite]: prefs[opposite].filter((item) => item !== value) }
        : {}),
    });
  }

  toggleSessionPin(id: string): void {
    this.curate("pinnedSessionIds", "hiddenSessionIds", id);
  }

  toggleSessionHidden(id: string): void {
    if (this.curationBlocked()) return;
    const { sessions, prefs } = this.host.state();
    const session = sessions.find((candidate) => candidate.id === id);
    if (session && prefs.hiddenProjectCwds.includes(session.cwd))
      void this.restoreSessionFromHiddenFolder(id, session.cwd);
    else this.curate("hiddenSessionIds", "pinnedSessionIds", id);
  }

  toggleProjectPin(cwd: string): void {
    this.curate("pinnedProjectCwds", "hiddenProjectCwds", cwd);
  }

  toggleProjectHidden(cwd: string): void {
    this.curate("hiddenProjectCwds", "pinnedProjectCwds", cwd);
  }

  private async restoreSessionFromHiddenFolder(
    id: string,
    cwd: string,
  ): Promise<void> {
    const api = this.host.api();
    if (!api) return;
    const revision = this.curationRevision;
    try {
      const { sessions } = await api.json("sessionsByCwds", {
        body: { cwds: [cwd] },
      });
      if (this.host.api() !== api || this.curationBlocked()) return;
      const prefs = this.host.state().prefs;
      if (revision !== this.curationRevision) {
        this.host.notify(
          "info",
          "Hidden changed while loading this folder. Try restoring the session again.",
        );
        return;
      }
      const folder = sessions.filter((session) => session.cwd === cwd);
      if (!folder.some((session) => session.id === id)) {
        this.host.notify(
          "warning",
          "This session is no longer available in the folder. Refresh the session list.",
        );
        return;
      }
      this.save({
        hiddenProjectCwds: prefs.hiddenProjectCwds.filter(
          (item) => item !== cwd,
        ),
        hiddenSessionIds: [
          ...new Set([
            ...prefs.hiddenSessionIds,
            ...folder.map((session) => session.id),
          ]),
        ].filter((candidate) => candidate !== id),
      });
    } catch (error) {
      if (this.host.api() !== api) return;
      if (error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
      else
        this.host.notify(
          "error",
          error instanceof Error
            ? error.message
            : "Could not restore the session",
        );
    }
  }
}
