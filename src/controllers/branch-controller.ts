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
  SessionReadOnlyReason,
} from "../../shared/contracts";
import { MAX_COMPOSER_HISTORY_ENTRIES } from "../../shared/contracts";
import type { SessionHistoryQuery } from "../../shared/history-query";
import { type Api, ApiError } from "../api";
import type { AppState } from "../app-state";
import type { ComposerHistoryScope } from "../composer-history";
import type { CopyContent } from "../content-copy";
import { RecoveryBackoff, readScope } from "../recovery-backoff";
import { shellCopyText } from "../shell-record";

export type BranchControllerState = Pick<
  AppState,
  "sessionId" | "view" | "branchTreeError" | "branchActionId"
> & { readOnlyReason?: SessionReadOnlyReason | null };

/** Independent copies need a readable source, not control of its writer. */
function branchCopyBlockReason(
  state: BranchControllerState,
  recoverWorkspace = false,
): string | null {
  if (!recoverWorkspace && state.readOnlyReason === "workspace-unavailable")
    return "The project folder is unavailable";
  if (state.branchActionId) return "A history action is in progress";
  if (state.view.health.status === "error" || state.view.conflict)
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

  retireReads(): void {
    this.inspection.abort();
    this.inspection = new AbortController();
  }

  retireAction(): void {
    this.actionRequest += 1;
  }

  invalidate(): void {
    this.retireReads();
    this.retireAction();
    this.host.patch({ branchActionId: null, branchTreeError: null });
  }

  history<Q extends SessionHistoryQuery>(
    sessionId: string,
    viewId: string,
    query: Q,
    signal?: AbortSignal,
  ) {
    const current = this.host.state();
    if (current.sessionId !== sessionId || current.view.viewId !== viewId)
      return Promise.resolve(null);
    return this.read(
      (api, signal) => api.sessionHistory(sessionId, viewId, query, signal),
      signal,
      query.kind === "entry" || query.kind === "outline",
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
        state.view.viewId === viewId &&
        state.view.incarnation === incarnation &&
        state.view.composerHistoryVersion === historyVersion
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

  readImage(targetId: string, index: number, signal?: AbortSignal) {
    const {
      sessionId,
      view: { viewId: transcriptViewId },
    } = this.host.state();
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
    const {
      sessionId,
      view: { viewId },
    } = this.host.state();
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
    const scope = readScope(
      () => this.host.api() === api && this.ownsView(ticket, "view"),
      signal,
    );
    try {
      return await scope.read(
        (signal) => perform(api, signal),
        retry ? new RecoveryBackoff() : undefined,
      );
    } catch (error) {
      if (!scope.current()) return null;
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      this.host.handleAuthFailure();
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
    revision = this.host.state().view.branchRevision,
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
        api.json("navigateBranch", {
          body: {
            sessionId,
            revision,
            targetId,
            mode,
            ...(mode !== "watch" ? options : {}),
          },
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

  fork(targetId: string): Promise<boolean> {
    return this.copyBranch({ kind: "fork", targetId });
  }

  clone(
    targetId?: string,
    onFailure?: (message: string) => void,
  ): Promise<boolean> {
    return this.copyBranch({ kind: "clone", targetId }, onFailure);
  }

  prepareWorkspaceFork() {
    const state = this.host.state();
    const api = this.host.api();
    if (
      !api ||
      !state.sessionId ||
      !state.view.viewId ||
      state.readOnlyReason !== "workspace-unavailable"
    )
      return null;
    const ticket = this.viewTicket(state);
    return (cwd: string) => {
      if (this.host.api() !== api || !this.ownsView(ticket, "view"))
        return Promise.resolve(false);
      return this.copyBranch({ kind: "recover", cwd }, (message) =>
        this.host.notify("warning", message),
      );
    };
  }

  private async copyBranch(
    copy:
      | { kind: "fork"; targetId: string }
      | { kind: "clone"; targetId?: string }
      | { kind: "recover"; cwd: string },
    onFailure?: (message: string) => void,
  ): Promise<boolean> {
    const api = this.host.api();
    const state = this.host.state();
    const sessionId = state.sessionId;
    const viewId = state.view.viewId;
    if (!api || !sessionId || !viewId) return false;
    if (
      copy.kind === "recover" &&
      state.readOnlyReason !== "workspace-unavailable"
    )
      return false;
    const blocked = branchCopyBlockReason(state, copy.kind === "recover");
    if (blocked) {
      onFailure?.(blocked);
      return false;
    }
    const address = { sessionId, viewId };
    const selectionRequest = this.host.beginForkSelection();
    const perform = () => {
      switch (copy.kind) {
        case "fork":
          return api.json("forkBranch", {
            body: { ...address, targetId: copy.targetId },
          });
        case "clone":
          return api.json("cloneBranch", {
            body: {
              ...address,
              targetId: copy.targetId ?? state.view.effectiveLeafId,
            },
          });
        case "recover":
          return api.json("recoverWorkspaceFork", {
            body: { ...address, cwd: copy.cwd },
          });
      }
    };
    return this.runAction(
      copy.kind === "recover"
        ? copy.kind
        : `${copy.kind}:${copy.targetId ?? "current"}`,
      api,
      { ...this.viewTicket(state), selectionRequest },
      perform,
      (response) => {
        this.host.applyFork(response);
        this.host.refreshSessionCatalog();
      },
      copy.kind === "clone" ? "Clone failed" : "Fork failed",
      "view",
      async (response) => {
        if (copy.kind === "fork")
          await Promise.allSettled(
            (response.editorAttachments ?? []).map(({ id }) =>
              api.deleteAttachment(id),
            ),
          );
      },
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
    ownership: "view" | "navigation",
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
        state.view.viewId === ticket.viewId &&
        state.view.effectiveLeafId === ticket.effectiveLeafId
      )
        return true;
      // The socket can publish this navigation before its HTTP response.
      const active = (response as BranchNavigateResponse | undefined)?.snapshot
        ?.active;
      return Boolean(
        active &&
          active.transcriptPage.viewId === state.view.viewId &&
          active.effectiveLeafId === state.view.effectiveLeafId,
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
    const target = this.host.state().view.restoreSavedLeafId;
    return target ? this.navigate(target, "switch") : Promise.resolve(false);
  }

  private viewTicket(state: BranchControllerState): BranchViewTicket {
    const sessionId = state.sessionId;
    if (!sessionId) throw new Error("A branch request requires a session");
    return {
      sessionId,
      selectionGeneration: this.host.selectionGeneration(),
      viewId: state.view.viewId,
      effectiveLeafId: state.view.effectiveLeafId,
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
      state.view.viewId === ticket.viewId &&
      (ownership === "view" ||
        state.view.effectiveLeafId === ticket.effectiveLeafId) &&
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
