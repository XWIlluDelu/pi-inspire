import {
  COMPOSER_HISTORY_FILE_REFERENCE,
  COMPOSER_HISTORY_IMAGE_REFERENCE,
} from "../../shared/composer-artifact-references";
import {
  type ComposerHistoryEntry,
  MAX_COMPOSER_HISTORY_ENTRIES,
} from "../../shared/contracts";
import { type Api, ApiError } from "../api";
import { type AppState } from "../app-state";

interface TranscriptDataControllerHost {
  state(): AppState;
  api(): Api | null;
  selectionGeneration(): number;
  handleAuthFailure(): void;
  notify(kind: "warning", message: string): void;
}

interface TranscriptScope {
  api: Api;
  sessionId: string;
  viewId: string;
  incarnation: string | null;
  selectionGeneration: number;
}

/** Loads saved Composer input against its current view. */
export class TranscriptDataController {
  constructor(private readonly host: TranscriptDataControllerHost) {}

  private captureScope(): TranscriptScope | null {
    const state = this.host.state();
    const api = this.host.api();
    if (!api || !state.sessionId || !state.transcriptViewId) return null;
    return {
      api,
      sessionId: state.sessionId,
      viewId: state.transcriptViewId,
      incarnation: state.transcriptIncarnation,
      selectionGeneration: this.host.selectionGeneration(),
    };
  }

  private ownsScope(scope: TranscriptScope): boolean {
    const state = this.host.state();
    return (
      this.host.api() === scope.api &&
      this.host.selectionGeneration() === scope.selectionGeneration &&
      state.sessionId === scope.sessionId &&
      state.transcriptViewId === scope.viewId &&
      state.transcriptIncarnation === scope.incarnation
    );
  }

  loadComposerHistory = async (
    sessionId: string,
    viewId: string,
    incarnation: string | null,
    historyVersion: string,
  ): Promise<ComposerHistoryEntry[] | null> => {
    const scope = this.captureScope();
    const ownsHistory = () =>
      scope !== null &&
      this.ownsScope(scope) &&
      scope.sessionId === sessionId &&
      scope.viewId === viewId &&
      scope.incarnation === incarnation &&
      this.host.state().composerHistoryVersion === historyVersion;
    if (!scope || !ownsHistory()) return null;
    const { api } = scope;

    try {
      // A user append can shift newest-first offsets between bounded pages.
      // Restart one read-only pass when its content identity changes.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let start = 0;
        let historyId: string | null = null;
        let total: number | null = null;
        const entries: ComposerHistoryEntry[] = [];
        while (true) {
          const page = await api.sessionHistory(sessionId, viewId, {
            kind: "composer",
            start,
          });
          if (
            !ownsHistory() ||
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
                    !COMPOSER_HISTORY_IMAGE_REFERENCE.test(image.reference) ||
                    typeof image.mimeType !== "string" ||
                    !Number.isSafeInteger(image.size) ||
                    image.size < 0,
                ) ||
                !Array.isArray(entry.files) ||
                entry.files.some(
                  (file) =>
                    !file ||
                    typeof file !== "object" ||
                    !COMPOSER_HISTORY_FILE_REFERENCE.test(file.reference) ||
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
      }
      return null;
    } catch (error) {
      if (!ownsHistory()) return null;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else if (!(error instanceof ApiError && error.status === 409)) {
        this.host.notify(
          "warning",
          error instanceof Error
            ? `Prompt history could not be loaded: ${error.message}`
            : "Prompt history could not be loaded",
        );
      }
      return null;
    }
  };
}
