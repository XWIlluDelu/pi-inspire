import {
  COMPOSER_HISTORY_FILE_REFERENCE,
  COMPOSER_HISTORY_IMAGE_REFERENCE,
} from "../../shared/composer-artifact-references";
import type {
  BranchEntryResponse,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  ComposerHistoryEntry,
  ProjectionConflict,
  ProjectionHealth,
  SessionReadOnlyReason,
} from "../../shared/contracts";
import { MAX_COMPOSER_HISTORY_ENTRIES } from "../../shared/contracts";
import type { SessionHistoryQuery } from "../../shared/history-query";
import { type Api, ApiError } from "../api";
import type { ComposerHistoryScope } from "../composer-history";
import type { CopyContent } from "../content-copy";
import { RecoveryBackoff } from "../recovery-backoff";
import { shellCopyText } from "../shell-record";

export interface BranchControllerState {
  sessionId: string | null;
  transcriptViewId: string | null;
  transcriptIncarnation: string | null;
  composerHistoryVersion: string | null;
  transcriptDurableLeafId: string | null;
  transcriptEffectiveLeafId: string | null;
  transcriptNavigationLeased: boolean;
  branchRevision: number | null;
  branchTreeError: string | null;
  branchActionId: string | null;
  projectionHealth: ProjectionHealth;
  projectionConflict: ProjectionConflict | null;
  readOnlyReason?: SessionReadOnlyReason | null;
}

export function hasEarlierContinuation(
  state: Pick<
    BranchControllerState,
    | "transcriptDurableLeafId"
    | "transcriptEffectiveLeafId"
    | "transcriptNavigationLeased"
  >,
): boolean {
  return (
    state.transcriptNavigationLeased &&
    state.transcriptDurableLeafId !== null &&
    state.transcriptDurableLeafId !== state.transcriptEffectiveLeafId
  );
}

/** Independent copies need a readable source, not control of its writer. */
function branchCopyBlockReason(state: BranchControllerState): string | null {
  if (state.readOnlyReason === "workspace-unavailable")
    return "The project folder is unavailable";
  if (state.branchActionId) return "A history action is in progress";
  if (state.projectionHealth.status === "error" || state.projectionConflict)
    return "Recover this session before continuing";
  return null;
}

export function branchCopiesBlocked(state: BranchControllerState): boolean {
  return branchCopyBlockReason(state) !== null;
}

export interface BranchControllerPatch {
  branchTreeError?: string | null;
  branchActionId?: string | null;
}

interface BranchViewTicket {
  sessionId: string;
  selectionGeneration: number;
  viewId: string | null;
  effectiveLeafId: string | null;
  selectionRequest: number;
}

interface BranchControllerHost {
  state(): BranchControllerState;
  patch(patch: BranchControllerPatch): void;
  api(): Api | null;
  selectionGeneration(): number;
  selectionRequest(): number;
  beginForkSelection(): number;
  handleAuthFailure(): void;
  draftRevision(): number;
  applyNavigation(
    response: BranchNavigateResponse,
    draftRevision: number,
  ): void;
  applyFork(response: BranchForkResponse): void;
  refreshSessionCatalog(): void;
  notify(kind: "warning", text: string): void;
}

/** Fences native branch actions and saved-entry reads to their original view. */
export class BranchController {
  private actionRequest = 0;
  private inspection = new AbortController();

  constructor(private readonly host: BranchControllerHost) {}

  invalidate({ preserveError = false, preserveAction = false } = {}): void {
    this.inspection.abort();
    this.inspection = new AbortController();
    if (!preserveAction) this.actionRequest += 1;
    this.host.patch({
      ...(!preserveAction ? { branchActionId: null } : {}),
      ...(!preserveError ? { branchTreeError: null } : {}),
    });
  }

  history<Q extends SessionHistoryQuery>(
    sessionId: string,
    viewId: string,
    query: Q,
    signal?: AbortSignal,
    retry = false,
  ) {
    const current = this.host.state();
    if (current.sessionId !== sessionId || current.transcriptViewId !== viewId)
      return Promise.resolve(null);
    return this.read(
      (api, signal) => api.sessionHistory(sessionId, viewId, query, signal),
      signal,
      retry,
    );
  }

  async composerHistory(
    {
      sessionId,
      viewId,
      incarnation,
      historyVersion,
    }: Omit<ComposerHistoryScope, "effectiveLeafId">,
    signal: AbortSignal,
  ): Promise<ComposerHistoryEntry[] | null> {
    const matches = () => {
      const state = this.host.state();
      return (
        state.sessionId === sessionId &&
        state.transcriptViewId === viewId &&
        state.transcriptIncarnation === incarnation &&
        state.composerHistoryVersion === historyVersion
      );
    };
    if (!matches()) return null;
    try {
      return await this.read(async (api, signal) => {
        // User appends can shift newest-first offsets. Restart the read once
        // when the complete input history identity changes between pages.
        for (let pass = 0; pass < 2; pass += 1) {
          const entries: ComposerHistoryEntry[] = [];
          let identity: string | undefined;
          while (matches()) {
            const start = entries.length;
            const page = await api.sessionHistory(
              sessionId,
              viewId,
              { kind: "composer", start },
              signal,
            );
            if (
              !matches() ||
              page.sessionId !== sessionId ||
              page.viewId !== viewId ||
              (page.incarnation ?? null) !== incarnation ||
              page.composerHistoryVersion !== historyVersion
            )
              return null;
            if (
              page.start !== start ||
              !Number.isSafeInteger(page.total) ||
              page.total < 0 ||
              page.total > MAX_COMPOSER_HISTORY_ENTRIES ||
              !Array.isArray(page.entries) ||
              start + page.entries.length > page.total ||
              !page.entries.every(validComposerEntry)
            )
              throw new Error("The Host returned invalid composer history");
            const stamp = JSON.stringify([page.historyId, page.total]);
            if (identity !== undefined && identity !== stamp) break;
            identity = stamp;
            entries.push(...page.entries);
            if (page.nextStart === null) {
              if (entries.length !== page.total)
                throw new Error(
                  "The Host returned incomplete composer history",
                );
              return entries;
            }
            if (page.nextStart !== entries.length || page.nextStart <= start)
              throw new Error(
                "The Host returned invalid composer history paging",
              );
          }
        }
        return null;
      }, signal);
    } catch (error) {
      if (matches() && !(error instanceof ApiError && error.status === 409))
        this.host.notify(
          "warning",
          error instanceof Error
            ? `Prompt history could not be loaded: ${error.message}`
            : "Prompt history could not be loaded",
        );
      return null;
    }
  }

  readEntry(targetId: string, offset = 0, signal?: AbortSignal) {
    const { sessionId, transcriptViewId } = this.host.state();
    return sessionId && transcriptViewId
      ? this.history(
          sessionId,
          transcriptViewId,
          { kind: "entry", targetId, offset },
          signal,
          true,
        )
      : Promise.resolve(null);
  }

  readImage(targetId: string, index: number, signal?: AbortSignal) {
    const { sessionId, transcriptViewId } = this.host.state();
    return sessionId && transcriptViewId
      ? this.read(
          (api, signal) =>
            api.branchImage(
              { sessionId, viewId: transcriptViewId, targetId },
              index,
              signal,
            ),
          signal,
          true,
        )
      : Promise.resolve(null);
  }

  async copyContent(
    targetId: string,
    signal: AbortSignal,
    format?: "message",
  ): Promise<CopyContent | null> {
    const { sessionId, transcriptViewId: viewId } = this.host.state();
    if (!sessionId || !viewId) return null;
    return this.read(async (api, signal) => {
      let offset = 0;
      const chunks: string[] = [];
      let shell: BranchEntryResponse["shell"];
      let imageEntries: NonNullable<BranchEntryResponse["images"]> = [];
      do {
        signal.throwIfAborted();
        const page = await api.sessionHistory(
          sessionId,
          viewId,
          { kind: "entry", targetId, offset, format },
          signal,
        );
        shell ??= page.shell;
        chunks.push(page.text);
        imageEntries = page.images ?? imageEntries;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
      const images: Blob[] = [];
      for (const image of imageEntries) {
        signal.throwIfAborted();
        images.push(
          await api.branchImage(
            { sessionId, viewId, targetId },
            image.index,
            signal,
          ),
        );
      }
      const text = chunks.join("");
      return { text: shell ? shellCopyText(shell, text) : text, images };
    }, signal);
  }

  private async read<T>(
    perform: (api: Api, signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
    retry = false,
  ): Promise<T | null> {
    const api = this.host.api();
    const state = this.host.state();
    if (!api || !state.sessionId) return null;
    const ticket = this.viewTicket(state);
    const signal = external
      ? AbortSignal.any([this.inspection.signal, external])
      : this.inspection.signal;
    const owns = () =>
      !signal.aborted &&
      this.host.api() === api &&
      this.ownsView(ticket, "view");
    if (!owns()) return null;
    try {
      const result = retry
        ? await new RecoveryBackoff().read(
            () => perform(api, signal),
            signal,
            owns,
          )
        : await perform(api, signal);
      return owns() ? result : null;
    } catch (error) {
      if (
        this.host.api() === api &&
        error instanceof ApiError &&
        error.status === 401
      )
        this.host.handleAuthFailure();
      else if (owns()) throw error;
      return null;
    }
  }

  async navigate(
    targetId: string,
    mode: BranchNavigateRequest["mode"],
    options: Pick<
      Exclude<BranchNavigateRequest, { mode: "watch" }>,
      "summarize" | "customInstructions"
    > = {},
    revision = this.host.state().branchRevision,
  ): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    if (
      !api ||
      !sessionId ||
      revision === null ||
      (state.readOnlyReason && mode !== "watch") ||
      branchCopiesBlocked(state)
    )
      return false;
    const draftRevision = this.host.draftRevision();
    return this.runAction(
      `${mode}:${targetId}`,
      api,
      this.viewTicket(state),
      () =>
        api.navigateBranch({
          sessionId,
          revision,
          targetId,
          mode,
          ...(mode !== "watch" ? options : {}),
        }),
      (response) => {
        if (response.cancelled) {
          this.host.notify("warning", "Conversation change cancelled");
          return false;
        }
        this.host.applyNavigation(response, draftRevision);
      },
      "Branch navigation failed",
      "navigation",
    );
  }

  /** The server validates this retained target in the captured source view;
   * no preparatory tree refresh is needed. */
  async forkFromEntry(targetId: string): Promise<boolean> {
    const sessionId = this.host.state().sessionId;
    if (!sessionId || !targetId) return false;
    const pending = this.fork(targetId);
    const ticket = this.viewTicket(this.host.state());
    const api = this.host.api();
    const forked = await pending;
    if (!forked && this.host.api() === api && this.ownsView(ticket, "view")) {
      this.host.notify(
        "warning",
        this.host.state().branchTreeError ?? "Fork failed",
      );
    }
    return forked;
  }

  async fork(targetId: string): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const viewId = state.transcriptViewId;
    if (!api || !sessionId || !viewId || branchCopiesBlocked(state))
      return false;
    const selectionRequest = this.host.beginForkSelection();
    return this.runAction(
      `fork:${targetId}`,
      api,
      { ...this.viewTicket(state), selectionRequest },
      () =>
        api.forkBranch({
          sessionId,
          viewId,
          targetId,
        }),
      (response) => {
        this.host.applyFork(response);
        this.host.refreshSessionCatalog();
      },
      "Fork failed",
      "view",
      async (response) => {
        await Promise.allSettled(
          (response.editorAttachments ?? []).map((item) =>
            api.deleteAttachment(item.id),
          ),
        );
      },
    );
  }

  async clone(
    targetId?: string,
    onFailure?: (message: string) => void,
  ): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const viewId = state.transcriptViewId;
    if (!api || !sessionId || !viewId) return false;
    const blocked = branchCopyBlockReason(state);
    if (blocked) {
      onFailure?.(blocked);
      return false;
    }
    const endpoint = targetId ?? state.transcriptEffectiveLeafId;
    const selectionRequest = this.host.beginForkSelection();
    return this.runAction(
      `clone:${targetId ?? "current"}`,
      api,
      { ...this.viewTicket(state), selectionRequest },
      () =>
        api.cloneBranch({
          sessionId,
          viewId,
          targetId: endpoint,
        }),
      (response) => {
        this.host.applyFork(response);
        this.host.refreshSessionCatalog();
      },
      "Clone failed",
      "view",
      undefined,
      onFailure,
    );
  }

  private async runAction<T>(
    actionId: string,
    api: Api,
    ticket: BranchViewTicket,
    perform: () => Promise<T>,
    commit: (response: T) => boolean | void | Promise<boolean | void>,
    fallbackError: string,
    ownership: "position" | "view" | "navigation" = "position",
    discard?: (response: T) => Promise<void>,
    onFailure?: (message: string) => void,
  ): Promise<boolean> {
    const actionRequest = ++this.actionRequest;
    const ownsRequest = (): boolean =>
      actionRequest === this.actionRequest && this.host.api() === api;
    // Independent copies capture their prefix at admission. Source progress may
    // continue while publishing; only a replaced view/selection invalidates opening it.
    const owns = (response?: T): boolean => {
      if (!ownsRequest()) return false;
      if (ownership !== "navigation") return this.ownsView(ticket, ownership);
      const state = this.host.state();
      if (
        state.sessionId !== ticket.sessionId ||
        this.host.selectionRequest() !== ticket.selectionRequest
      )
        return false;
      if (
        state.transcriptViewId === ticket.viewId &&
        state.transcriptEffectiveLeafId === ticket.effectiveLeafId
      )
        return true;
      // The socket can publish this navigation before its HTTP response.
      const active = (response as BranchNavigateResponse | undefined)?.snapshot
        ?.active;
      return Boolean(
        active &&
          active.transcriptPage.viewId === state.transcriptViewId &&
          active.effectiveLeafId === state.transcriptEffectiveLeafId,
      );
    };
    this.host.patch({ branchActionId: actionId, branchTreeError: null });
    try {
      const response = await perform();
      if (!owns(response)) {
        await discard?.(response);
        return false;
      }
      return (await commit(response)) !== false;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (this.host.api() === api) this.host.handleAuthFailure();
        return false;
      }
      if (!owns()) return false;
      const message = error instanceof Error ? error.message : fallbackError;
      this.host.patch({ branchTreeError: message });
      onFailure?.(message);
      return false;
    } finally {
      if (ownsRequest() && this.host.state().branchActionId === actionId) {
        this.host.patch({ branchActionId: null });
      }
    }
  }

  returnToLatest(): Promise<boolean> {
    const state = this.host.state();
    if (!state.transcriptDurableLeafId || !hasEarlierContinuation(state))
      return Promise.resolve(false);
    return this.navigate(state.transcriptDurableLeafId, "switch");
  }

  private viewTicket(state: BranchControllerState): BranchViewTicket {
    const sessionId = state.sessionId;
    if (!sessionId) throw new Error("A branch request requires a session");
    return {
      sessionId,
      selectionGeneration: this.host.selectionGeneration(),
      viewId: state.transcriptViewId,
      effectiveLeafId: state.transcriptEffectiveLeafId,
      selectionRequest: this.host.selectionRequest(),
    };
  }

  private ownsView(
    ticket: BranchViewTicket,
    ownership: "position" | "view" = "position",
  ): boolean {
    const state = this.host.state();
    return (
      state.sessionId === ticket.sessionId &&
      this.host.selectionGeneration() === ticket.selectionGeneration &&
      state.transcriptViewId === ticket.viewId &&
      (ownership === "view" ||
        state.transcriptEffectiveLeafId === ticket.effectiveLeafId) &&
      this.host.selectionRequest() === ticket.selectionRequest
    );
  }
}

function validComposerEntry(entry: ComposerHistoryEntry): boolean {
  return (
    !!entry &&
    typeof entry.text === "string" &&
    Array.isArray(entry.images) &&
    entry.images.every(
      (image) =>
        !!image &&
        COMPOSER_HISTORY_IMAGE_REFERENCE.test(image.reference) &&
        typeof image.mimeType === "string" &&
        Number.isSafeInteger(image.size) &&
        image.size >= 0,
    ) &&
    Array.isArray(entry.files) &&
    entry.files.every(
      (file) =>
        !!file &&
        COMPOSER_HISTORY_FILE_REFERENCE.test(file.reference) &&
        typeof file.fileName === "string" &&
        file.fileName.length > 0 &&
        (file.kind === "attachment" || file.kind === "project"),
    )
  );
}
