import {
  type ComposerHistoryEntry,
  MAX_COMPOSER_HISTORY_ENTRIES,
  type UserTurnAnchor,
  type UserTurnTranscriptPage,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";
import {
  type ActivityMaterializationMode,
  type AppState,
  type TranscriptActivityRangeState,
  transcriptRevisionContains,
} from "../app-state";
import { asMessage, type ChatMessage, messageKey } from "../events";

const PROMPT_MAP_PAGE_SIZE = 100;

interface TranscriptDataControllerHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  api(): Api | null;
  selectionGeneration(): number;
  transportGeneration(): number;
  markSettled(key: string): void;
  resync(
    expectedSessionId?: string | null,
    expectedGeneration?: number,
    minimumRevision?: number,
    preserveAppendHistory?: boolean,
  ): Promise<void>;
  handleAuthFailure(): void;
  fail(message: string, severity?: "error" | "warning"): void;
}

/** Owns branch-bound transcript pagination, Prompt Map reads, composer-history
 * paging, and deferred activity materialization. */
export class TranscriptDataController {
  private olderTranscriptRequest: AbortController | null = null;
  private activityTranscriptRequests = new Map<string, AbortController>();
  private userTurnIndexRequests = new Map<string, AbortController>();
  private userTurnIndexPromises = new Map<string, Promise<UserTurnAnchor[]>>();
  private userTurnTranscriptRequest: AbortController | null = null;

  constructor(private readonly host: TranscriptDataControllerHost) {}

  invalidate(): void {
    this.olderTranscriptRequest?.abort();
    this.olderTranscriptRequest = null;
    for (const request of this.activityTranscriptRequests.values())
      request.abort();
    this.activityTranscriptRequests.clear();
    for (const request of this.userTurnIndexRequests.values()) request.abort();
    this.userTurnIndexRequests.clear();
    this.userTurnIndexPromises.clear();
    this.userTurnTranscriptRequest?.abort();
    this.userTurnTranscriptRequest = null;
  }

  loadOlderMessages = async (): Promise<boolean> => {
    const sessionId = this.host.state().sessionId;
    const cursor = this.host.state().olderMessagesCursor;
    const revision = this.host.state().transcriptRevision;
    const viewId = this.host.state().transcriptViewId;
    const incarnation = this.host.state().transcriptIncarnation;
    const generation = this.host.selectionGeneration();
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    if (
      !api ||
      !sessionId ||
      !cursor ||
      !viewId ||
      this.host.state().loadingOlderMessages
    )
      return false;
    const request = new AbortController();
    this.olderTranscriptRequest = request;
    this.host.patch({ loadingOlderMessages: true, olderMessagesError: null });
    try {
      const page = await api.olderTranscript(sessionId, cursor, request.signal);
      const pageLineageCompatible = transcriptRevisionContains(
        page.revision,
        page.appendFromRevision ?? page.revision,
        revision,
      );
      const currentLineageCompatible = transcriptRevisionContains(
        this.host.state().transcriptRevision,
        this.host.state().transcriptAppendFromRevision,
        revision,
      );
      if (
        !ownsTransport() ||
        this.host.state().sessionId !== sessionId ||
        this.host.selectionGeneration() !== generation ||
        !currentLineageCompatible ||
        this.host.state().transcriptViewId !== viewId ||
        this.host.state().transcriptIncarnation !== incarnation ||
        page.sessionId !== sessionId ||
        !pageLineageCompatible ||
        (page.viewId ?? viewId) !== viewId ||
        (page.incarnation ?? incarnation) !== incarnation
      )
        return false;
      const existing = new Set(
        this.host
          .state()
          .messages.map(
            (message) => messageKey(message) ?? JSON.stringify(message),
          ),
      );
      const older = page.messages.map(asMessage).filter((message) => {
        const key = messageKey(message) ?? JSON.stringify(message);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      for (const message of older) {
        const key = messageKey(message);
        if (key) this.host.markSettled(key);
      }
      const existingRanges = new Set(
        this.host.state().transcriptActivityRanges.map((range) => range.cursor),
      );
      const activityRanges = (page.activityRanges ?? [])
        .filter((range) => {
          if (existingRanges.has(range.cursor)) return false;
          existingRanges.add(range.cursor);
          return true;
        })
        .map((range) => ({
          ...range,
          status: "idle" as const,
          error: null,
        }));
      this.host.patch({
        messages: [...older, ...this.host.state().messages],
        transcriptActivityRanges: [
          ...activityRanges,
          ...this.host.state().transcriptActivityRanges,
        ],
        hasOlderMessages: page.hasOlder,
        olderMessagesCursor: page.olderCursor,
        olderMessagesError: null,
      });
      return true;
    } catch (error) {
      if (
        request.signal.aborted ||
        !ownsTransport() ||
        this.host.selectionGeneration() !== generation ||
        this.host.state().transcriptViewId !== viewId
      ) {
        return false;
      }
      if (error instanceof ApiError && error.status === 409) {
        await this.host.resync(sessionId, generation, undefined, false);
      } else if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else {
        this.host.patch({
          olderMessagesError:
            error instanceof Error
              ? error.message
              : "Failed to load earlier messages",
          ...(this.host.state().projectionError
            ? { error: this.host.state().projectionError }
            : {}),
        });
      }
      return false;
    } finally {
      if (this.olderTranscriptRequest === request)
        this.olderTranscriptRequest = null;
      if (
        ownsTransport() &&
        this.host.state().sessionId === sessionId &&
        this.host.selectionGeneration() === generation &&
        this.host.state().transcriptViewId === viewId
      )
        this.host.patch({ loadingOlderMessages: false });
    }
  };

  loadComposerHistory = async (
    sessionId: string,
    viewId: string,
    incarnation: string | null,
    effectiveLeafId: string | null,
  ): Promise<ComposerHistoryEntry[] | null> => {
    const api = this.host.api();
    const generation = this.host.selectionGeneration();
    const transportGeneration = this.host.transportGeneration();
    const ownsScope = () =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration &&
      this.host.selectionGeneration() === generation &&
      this.host.state().sessionId === sessionId &&
      this.host.state().transcriptViewId === viewId &&
      this.host.state().transcriptIncarnation === incarnation &&
      this.host.state().transcriptEffectiveLeafId === effectiveLeafId;
    if (!api || !ownsScope()) return null;

    try {
      // A user append can shift newest-first offsets between bounded pages.
      // Restart one read-only pass when its content identity changes.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let start = 0;
        let historyId: string | null = null;
        let total: number | null = null;
        const entries: ComposerHistoryEntry[] = [];
        let changed = false;
        while (true) {
          const page = await api.composerHistory(sessionId, start);
          if (
            !ownsScope() ||
            page.sessionId !== sessionId ||
            page.viewId !== viewId ||
            (page.incarnation ?? null) !== incarnation ||
            (page.effectiveLeafId ?? null) !== effectiveLeafId
          )
            return null;
          if (
            page.entries.some(
              (entry) =>
                typeof entry === "string" ||
                (entry &&
                  typeof entry === "object" &&
                  typeof entry.text === "string" &&
                  Array.isArray(entry.images) &&
                  !Array.isArray(entry.files)),
            )
          ) {
            throw new Error(
              "The Host is still running the previous prompt-history interface; restart INSΠRE",
            );
          }
          if (
            page.start !== start ||
            !Number.isSafeInteger(page.total) ||
            page.total < 0 ||
            page.total > MAX_COMPOSER_HISTORY_ENTRIES ||
            entries.length + page.entries.length > page.total ||
            page.entries.some(
              (entry) =>
                !entry ||
                typeof entry !== "object" ||
                typeof entry.text !== "string" ||
                !Array.isArray(entry.images) ||
                entry.images.some(
                  (image) =>
                    !image ||
                    typeof image !== "object" ||
                    !/^pi-embedded:\/\/\d+\/\d+$/.test(image.reference) ||
                    typeof image.mimeType !== "string" ||
                    !Number.isSafeInteger(image.size) ||
                    image.size < 0,
                ) ||
                !Array.isArray(entry.files) ||
                entry.files.some(
                  (file) =>
                    !file ||
                    typeof file !== "object" ||
                    !/^pi-file:\/\/\d+\/\d+$/.test(file.reference) ||
                    typeof file.fileName !== "string" ||
                    file.fileName.length === 0 ||
                    (file.kind !== "attachment" && file.kind !== "project"),
                ),
            )
          )
            throw new Error("The Host returned invalid composer history");
          if (historyId === null) {
            historyId = page.historyId;
            total = page.total;
          } else if (page.historyId !== historyId || page.total !== total) {
            changed = true;
            break;
          }
          entries.push(...page.entries);
          if (page.nextStart === null) {
            if (entries.length !== page.total)
              throw new Error("The Host returned incomplete composer history");
            return entries;
          }
          if (
            page.nextStart !== start + page.entries.length ||
            page.nextStart <= start
          )
            throw new Error(
              "The Host returned invalid composer history paging",
            );
          start = page.nextStart;
        }
        if (!changed) break;
      }
      return null;
    } catch (error) {
      if (!ownsScope()) return null;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else if (!(error instanceof ApiError && error.status === 409)) {
        this.host.fail(
          error instanceof Error
            ? `Prompt history could not be loaded: ${error.message}`
            : "Prompt history could not be loaded",
          "warning",
        );
      }
      return null;
    }
  };

  loadPromptMapTurns = async (start?: number): Promise<UserTurnAnchor[]> => {
    const sessionId = this.host.state().sessionId;
    const revision = this.host.state().transcriptRevision;
    const viewId = this.host.state().transcriptViewId;
    const incarnation = this.host.state().transcriptIncarnation;
    const generation = this.host.selectionGeneration();
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    if (!api || !sessionId || !viewId) return [];
    if (start !== undefined) {
      const cached = this.host
        .state()
        .promptMapTurns.filter(
          (turn) =>
            turn.ordinal >= start &&
            turn.ordinal < start + PROMPT_MAP_PAGE_SIZE,
        );
      if (
        this.host.state().promptMapLoadedStarts.includes(start) &&
        (cached.length === PROMPT_MAP_PAGE_SIZE ||
          start + cached.length >= this.host.state().promptMapTotal)
      )
        return cached;
    }
    const requestKey = start === undefined ? "latest" : String(start);
    const existingRequest = this.userTurnIndexPromises.get(requestKey);
    if (existingRequest) return existingRequest;
    const request = new AbortController();
    this.userTurnIndexRequests.set(requestKey, request);
    const loadingKey = start ?? -1;
    if (!this.host.state().promptMapLoadingStarts.includes(loadingKey))
      this.host.patch({
        promptMapLoadingStarts: [
          ...this.host.state().promptMapLoadingStarts,
          loadingKey,
        ],
        promptMapError: null,
      });
    let pending!: Promise<UserTurnAnchor[]>;
    pending = (async (): Promise<UserTurnAnchor[]> => {
      try {
        const page = await api.transcriptUserTurns(
          sessionId,
          start,
          request.signal,
        );
        const pageLineageCompatible = transcriptRevisionContains(
          page.revision,
          page.appendFromRevision ?? page.revision,
          revision,
        );
        const currentLineageCompatible = transcriptRevisionContains(
          this.host.state().transcriptRevision,
          this.host.state().transcriptAppendFromRevision,
          revision,
        );
        if (
          request.signal.aborted ||
          !ownsTransport() ||
          this.host.state().sessionId !== sessionId ||
          this.host.selectionGeneration() !== generation ||
          !currentLineageCompatible ||
          this.host.state().transcriptViewId !== viewId ||
          this.host.state().transcriptIncarnation !== incarnation ||
          page.sessionId !== sessionId ||
          !pageLineageCompatible ||
          page.viewId !== viewId ||
          (page.incarnation ?? incarnation) !== incarnation
        )
          return [];
        const currentRevision = this.host.state().transcriptRevision;
        const staleAppendPage = page.revision < currentRevision;
        const promptMapTotal = staleAppendPage
          ? Math.max(this.host.state().promptMapTotal, page.total)
          : page.total;
        const byOrdinal = new Map(
          this.host.state().promptMapTurns.map((turn) => [turn.ordinal, turn]),
        );
        for (const turn of page.turns) byOrdinal.set(turn.ordinal, turn);
        const turns = [...byOrdinal.values()]
          .filter((turn) => turn.ordinal < promptMapTotal)
          .sort((left, right) => left.ordinal - right.ordinal);
        this.host.patch({
          promptMapTurns: turns,
          promptMapTotal,
          // An older append-compatible page is useful partial data but cannot
          // prove the current outline complete: the append may itself contain
          // a new user turn. Leave it eligible for an immediate current read.
          promptMapLoadedStarts: staleAppendPage
            ? this.host.state().promptMapLoadedStarts
            : [
                ...new Set([
                  ...this.host.state().promptMapLoadedStarts,
                  page.start,
                ]),
              ].sort((left, right) => left - right),
          promptMapError: null,
        });
        return page.turns;
      } catch (error) {
        if (
          request.signal.aborted ||
          !ownsTransport() ||
          this.host.selectionGeneration() !== generation ||
          this.host.state().transcriptViewId !== viewId
        )
          return [];
        if (error instanceof ApiError && error.status === 409) {
          await this.host.resync(sessionId, generation, undefined, false);
        } else if (error instanceof ApiError && error.status === 401) {
          this.host.handleAuthFailure();
        } else {
          this.host.patch({
            promptMapError:
              error instanceof Error
                ? error.message
                : "Failed to load the user-turn outline",
          });
        }
        return [];
      } finally {
        if (this.userTurnIndexRequests.get(requestKey) === request)
          this.userTurnIndexRequests.delete(requestKey);
        if (this.userTurnIndexPromises.get(requestKey) === pending)
          this.userTurnIndexPromises.delete(requestKey);
        if (
          ownsTransport() &&
          this.host.state().sessionId === sessionId &&
          this.host.selectionGeneration() === generation &&
          this.host.state().transcriptViewId === viewId
        )
          this.host.patch({
            promptMapLoadingStarts: this.host
              .state()
              .promptMapLoadingStarts.filter((value) => value !== loadingKey),
          });
      }
    })();
    this.userTurnIndexPromises.set(requestKey, pending);
    return pending;
  };

  navigatePromptMapTurn = async (ordinal: number): Promise<boolean> => {
    const sessionId = this.host.state().sessionId;
    const revision = this.host.state().transcriptRevision;
    const viewId = this.host.state().transcriptViewId;
    const incarnation = this.host.state().transcriptIncarnation;
    const generation = this.host.selectionGeneration();
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    if (
      !api ||
      !sessionId ||
      !viewId ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= this.host.state().promptMapTotal ||
      this.host.state().promptMapNavigatingOrdinal !== null
    )
      return false;
    this.host.patch({
      promptMapNavigatingOrdinal: ordinal,
      promptMapError: null,
    });
    let request: AbortController | null = null;
    try {
      let turn = this.host
        .state()
        .promptMapTurns.find((candidate) => candidate.ordinal === ordinal);
      if (!turn) {
        const start =
          Math.floor(ordinal / PROMPT_MAP_PAGE_SIZE) * PROMPT_MAP_PAGE_SIZE;
        const page = await this.loadPromptMapTurns(start);
        turn =
          page.find((candidate) => candidate.ordinal === ordinal) ??
          this.host
            .state()
            .promptMapTurns.find((candidate) => candidate.ordinal === ordinal);
      }
      if (!ownsTransport()) return false;
      if (!turn) throw new Error("That user turn is no longer available");
      if (
        this.host
          .state()
          .messages.some(
            (message) =>
              message.role === "user" &&
              message.__inspireMessageId === turn!.id,
          )
      )
        return true;

      request = new AbortController();
      this.userTurnTranscriptRequest?.abort();
      this.userTurnTranscriptRequest = request;
      const pages: UserTurnTranscriptPage[] = [];
      const seenCursors = new Set<string>();
      let continuationCursor: string | undefined;
      do {
        const page = await api.transcriptUserTurn(
          sessionId,
          turn.id,
          continuationCursor,
          request.signal,
        );
        const pageLineageCompatible = transcriptRevisionContains(
          page.revision,
          page.appendFromRevision ?? page.revision,
          revision,
        );
        const currentLineageCompatible = transcriptRevisionContains(
          this.host.state().transcriptRevision,
          this.host.state().transcriptAppendFromRevision,
          revision,
        );
        if (
          request.signal.aborted ||
          !ownsTransport() ||
          this.host.state().sessionId !== sessionId ||
          this.host.selectionGeneration() !== generation ||
          !currentLineageCompatible ||
          this.host.state().transcriptViewId !== viewId ||
          this.host.state().transcriptIncarnation !== incarnation ||
          page.sessionId !== sessionId ||
          !pageLineageCompatible ||
          page.viewId !== viewId ||
          (page.incarnation ?? incarnation) !== incarnation ||
          page.targetMessageId !== turn.id
        )
          return false;
        pages.push(page);
        continuationCursor = page.continuationCursor ?? undefined;
        if (continuationCursor) {
          if (seenCursors.has(continuationCursor))
            throw new Error("User-turn transcript cursor did not advance");
          seenCursors.add(continuationCursor);
        }
      } while (continuationCursor);

      const existing = new Set(
        this.host
          .state()
          .messages.map(
            (message) => messageKey(message) ?? JSON.stringify(message),
          ),
      );
      const incoming = pages
        .flatMap((page) => page.messages)
        .map(asMessage)
        .filter((message) => {
          const key = messageKey(message) ?? JSON.stringify(message);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        });
      const messages = [...this.host.state().messages, ...incoming].sort(
        (left, right) => {
          const leftIndex = left.__inspireMessageIndex;
          const rightIndex = right.__inspireMessageIndex;
          if (leftIndex === undefined) return rightIndex === undefined ? 0 : 1;
          if (rightIndex === undefined) return -1;
          return leftIndex - rightIndex;
        },
      );
      for (const message of incoming) {
        const key = messageKey(message);
        if (key) this.host.markSettled(key);
      }
      const existingRanges = new Set(
        this.host.state().transcriptActivityRanges.map((range) => range.cursor),
      );
      const activityRanges = pages
        .flatMap((page) => page.activityRanges ?? [])
        .filter((range) => {
          if (existingRanges.has(range.cursor)) return false;
          existingRanges.add(range.cursor);
          return true;
        })
        .map((range) => ({
          ...range,
          status: "idle" as const,
          error: null,
        }));
      const firstPage = pages[0]!;
      const currentEarliest = this.host
        .state()
        .messages.reduce(
          (minimum, message) =>
            message.__inspireMessageIndex === undefined
              ? minimum
              : Math.min(minimum, message.__inspireMessageIndex),
          Number.POSITIVE_INFINITY,
        );
      const extendsEarlier = firstPage.rangeStart < currentEarliest;
      this.host.patch({
        messages,
        transcriptActivityRanges: [
          ...this.host.state().transcriptActivityRanges,
          ...activityRanges,
        ],
        ...(extendsEarlier
          ? {
              hasOlderMessages: firstPage.hasOlder,
              olderMessagesCursor: firstPage.olderCursor,
              olderMessagesError: null,
            }
          : {}),
      });
      return true;
    } catch (error) {
      if (
        request?.signal.aborted ||
        !ownsTransport() ||
        this.host.selectionGeneration() !== generation ||
        this.host.state().transcriptViewId !== viewId
      )
        return false;
      if (error instanceof ApiError && error.status === 409) {
        await this.host.resync(sessionId, generation, undefined, false);
      } else if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else {
        this.host.patch({
          promptMapError:
            error instanceof Error
              ? error.message
              : "Failed to load that user turn",
        });
      }
      return false;
    } finally {
      const ownsNavigation = request
        ? this.userTurnTranscriptRequest === request
        : this.host.state().promptMapNavigatingOrdinal === ordinal;
      if (ownsNavigation) {
        if (request) this.userTurnTranscriptRequest = null;
        if (
          ownsTransport() &&
          this.host.state().sessionId === sessionId &&
          this.host.selectionGeneration() === generation &&
          this.host.state().transcriptViewId === viewId
        )
          this.host.patch({ promptMapNavigatingOrdinal: null });
      }
    }
  };

  materializeActivityRanges = async (
    cursors: readonly string[],
    beforeCommit?: () => void,
    mode: ActivityMaterializationMode = "all",
  ): Promise<void> => {
    const sessionId = this.host.state().sessionId;
    const viewId = this.host.state().transcriptViewId;
    const incarnation = this.host.state().transcriptIncarnation;
    const generation = this.host.selectionGeneration();
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    if (!api || !sessionId || !viewId) return;
    const requested = this.host
      .state()
      .transcriptActivityRanges.filter(
        (range) => cursors.includes(range.cursor) && range.status !== "loading",
      );
    if (requested.length === 0) return;
    this.host.patch({
      transcriptActivityRanges: this.host
        .state()
        .transcriptActivityRanges.map((range) =>
          requested.some((candidate) => candidate.cursor === range.cursor)
            ? { ...range, status: "loading", error: null }
            : range,
        ),
    });

    const results = await Promise.all(
      requested.map(async (range) => {
        const request = new AbortController();
        this.activityTranscriptRequests.set(range.cursor, request);
        const pages: ChatMessage[][] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = range.cursor;
        let received = 0;
        let hasMore = false;
        try {
          while (cursor) {
            if (seenCursors.has(cursor))
              throw new Error("Deferred activity cursor did not advance");
            seenCursors.add(cursor);
            const page = await api.transcriptActivity(
              sessionId,
              cursor,
              request.signal,
            );
            if (
              page.sessionId !== sessionId ||
              page.viewId !== viewId ||
              (page.incarnation !== undefined &&
                page.incarnation !== incarnation)
            )
              throw new Error("Deferred activity belongs to another view");
            const messages = page.messages.map(asMessage);
            if (messages.length === 0 && page.hasMore)
              throw new Error("Deferred activity page made no progress");
            received += messages.length;
            if (received > range.messageCount)
              throw new Error("Deferred activity exceeded its declared range");
            pages.unshift(messages);
            hasMore = page.hasMore;
            cursor = page.hasMore ? page.cursor : null;
            if (page.hasMore && !cursor)
              throw new Error("Deferred activity continuation is missing");
            if (mode === "tail") break;
          }
          const remaining = range.messageCount - received;
          if (mode === "all" && remaining !== 0)
            throw new Error("Deferred activity range is incomplete");
          if (mode === "tail" && hasMore !== remaining > 0)
            throw new Error("Deferred activity continuation is inconsistent");
          const remainder =
            mode === "tail" && hasMore && cursor
              ? {
                  ...range,
                  cursor,
                  messageCount: remaining,
                  status: "idle" as const,
                  error: null,
                }
              : null;
          return {
            range,
            messages: pages.flat(),
            remainder,
            error: null,
          };
        } catch (error) {
          return {
            range,
            messages: [] as ChatMessage[],
            remainder: null,
            error,
          };
        } finally {
          if (this.activityTranscriptRequests.get(range.cursor) === request)
            this.activityTranscriptRequests.delete(range.cursor);
        }
      }),
    );

    if (
      !ownsTransport() ||
      this.host.state().sessionId !== sessionId ||
      this.host.selectionGeneration() !== generation ||
      this.host.state().transcriptIncarnation !== incarnation ||
      this.host.state().transcriptViewId !== viewId
    )
      return;
    const conflict = results.find(
      (result) =>
        result.error instanceof ApiError && result.error.status === 409,
    );
    if (conflict) {
      const message =
        conflict.error instanceof Error
          ? conflict.error.message
          : "Deferred activity became stale";
      this.host.patch({
        transcriptActivityRanges: this.host
          .state()
          .transcriptActivityRanges.map((range) =>
            requested.some((candidate) => candidate.cursor === range.cursor)
              ? { ...range, status: "error", error: message }
              : range,
          ),
      });
      await this.host.resync(sessionId, generation, undefined, false);
      return;
    }
    if (
      results.some(
        (result) =>
          result.error instanceof ApiError && result.error.status === 401,
      )
    ) {
      this.host.patch({
        transcriptActivityRanges: this.host
          .state()
          .transcriptActivityRanges.map((range) =>
            requested.some((candidate) => candidate.cursor === range.cursor)
              ? { ...range, status: "idle", error: null }
              : range,
          ),
      });
      this.host.handleAuthFailure();
      return;
    }

    const nextMessages = [...this.host.state().messages];
    const completed = new Set<string>();
    const remainders = new Map<string, TranscriptActivityRangeState>();
    const failures = new Map<string, string>();
    const existing = new Set(
      nextMessages.map(
        (message) => messageKey(message) ?? JSON.stringify(message),
      ),
    );
    for (const result of results) {
      if (result.error) {
        if (
          !(
            result.error instanceof DOMException &&
            result.error.name === "AbortError"
          )
        )
          failures.set(
            result.range.cursor,
            result.error instanceof Error
              ? result.error.message
              : "Failed to load deferred activity",
          );
        continue;
      }
      const insertAt =
        result.range.afterMessageId === null
          ? 0
          : nextMessages.findIndex(
              (message) =>
                message.__inspireMessageId === result.range.afterMessageId,
            ) + 1;
      if (insertAt === 0 && result.range.afterMessageId !== null) {
        failures.set(
          result.range.cursor,
          "Deferred activity anchor is no longer available",
        );
        continue;
      }
      const materialized = result.messages
        .filter((message) => {
          const key = messageKey(message) ?? JSON.stringify(message);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        })
        .map((message) => ({
          ...message,
          __inspireActivityRangeCursor: result.range.cursor,
        }));
      nextMessages.splice(insertAt, 0, ...materialized);
      for (const message of materialized) {
        const key = messageKey(message);
        if (key) this.host.markSettled(key);
      }
      completed.add(result.range.cursor);
      if (result.remainder)
        remainders.set(result.range.cursor, result.remainder);
    }
    beforeCommit?.();
    this.host.patch({
      messages: nextMessages,
      transcriptActivityRanges: this.host
        .state()
        .transcriptActivityRanges.flatMap((range) => {
          const remainder = remainders.get(range.cursor);
          if (remainder) return [remainder];
          if (completed.has(range.cursor)) return [];
          const error = failures.get(range.cursor);
          if (error) return [{ ...range, status: "error" as const, error }];
          if (requested.some((candidate) => candidate.cursor === range.cursor))
            return [{ ...range, status: "idle" as const, error: null }];
          return [range];
        }),
    });
  };
}
