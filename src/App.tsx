import {
  AlertTriangle,
  Download,
  Info,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import {
  lazy,
  memo,
  Profiler,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { isAbortableRunState, type ThemePreference } from "../shared/contracts";
import { ApiError, pairHost } from "./api";
import { recordBenchmarkCommit } from "./benchmark-profiler";
import { ActivityBar } from "./components/ActivityBar";
import { AppTopbar } from "./components/AppTopbar";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { CopyAction } from "./components/CopyAction";
import { ExtensionDisplayDock } from "./components/ExtensionDisplays";
import { ExtensionUiDialog } from "./components/ExtensionUiDialog";
import { Nav } from "./components/Nav";
import { PaneResizeHandle } from "./components/PaneResizeHandle";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import type { SettingsCategoryId } from "./components/Settings";
import { Transcript } from "./components/Transcript";
import { Welcome, type WelcomeInheritance } from "./components/Welcome";
import { BrandLogo, Wordmark } from "./components/Wordmark";
import type { Notice } from "./events";
import { shallowEqual, store, useAppState } from "./store";
import { type AvailableUpdates, availableUpdates } from "./update-availability";
import { hasActiveModal, useModalFocus } from "./use-modal-focus";
import { cacheVisualPreferences } from "./visual-preferences";

// Vite replaces MODE at build time. The production false branches are folded
// before Rollup, leaving the ordinary elements directly in the component tree.
const MAINTENANCE_BENCHMARK = import.meta.env.MODE === "maintenance-benchmark";
const loadContextPane = () => import("./components/ContextPane");
const loadSettings = () => import("./components/Settings");
const DeferredContextSurface = lazy(() =>
  loadContextPane().then((module) => ({ default: module.ContextPane })),
);
const DeferredSettingsSurface = lazy(() =>
  loadSettings().then((module) => ({ default: module.Settings })),
);

function reportDeferredSurfaceError(error: unknown): void {
  console.error("Deferred surface failed to load", error);
}

function ContextPaneLoading({
  isModal,
  onClose,
  onRetry,
}: {
  isModal: boolean;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(isModal, "context-pane", onClose);
  const content = (
    <>
      <div className="ctx__header">
        <span className="ctx__title">Context</span>
        <button
          type="button"
          className="icon-button ctx__close"
          title="Close"
          aria-label="Close context pane"
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      <div className="res__empty" role={onRetry ? "alert" : "status"}>
        {onRetry ? (
          <>
            Context could not be opened.
            <button type="button" onClick={onRetry}>
              Reload
            </button>
          </>
        ) : (
          <>
            <Loader2 size={14} className="spin" aria-hidden /> Loading context
          </>
        )}
      </div>
    </>
  );
  return isModal ? (
    <div
      className="ctx res"
      id="context-pane"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Context panel"
      tabIndex={-1}
    >
      {content}
    </div>
  ) : (
    <aside className="ctx res" id="context-pane" aria-label="Context panel">
      {content}
    </aside>
  );
}

function SettingsLoading({
  onClose,
  onRetry,
}: {
  onClose: () => void;
  onRetry?: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "settings", onClose);
  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings__header">
          <h2 className="settings__title">Settings</h2>
          <button
            type="button"
            className="icon-button settings__close-btn"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        <div className="res__empty" role={onRetry ? "alert" : "status"}>
          {onRetry ? (
            <>
              Settings could not be opened.
              <button type="button" onClick={onRetry}>
                Reload
              </button>
            </>
          ) : (
            <>
              <Loader2 size={14} className="spin" aria-hidden /> Loading
              settings
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeferredContextPane({
  isModal,
  onClose,
}: {
  isModal: boolean;
  onClose: () => void;
}) {
  return (
    <RenderErrorBoundary
      onError={reportDeferredSurfaceError}
      fallback={
        <ContextPaneLoading
          isModal={isModal}
          onClose={onClose}
          onRetry={() => window.location.reload()}
        />
      }
    >
      <Suspense
        fallback={<ContextPaneLoading isModal={isModal} onClose={onClose} />}
      >
        <DeferredContextSurface isModal={isModal} onClose={onClose} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

function DeferredSettings({
  initialCategory,
  onClose,
}: {
  initialCategory: SettingsCategoryId;
  onClose: () => void;
}) {
  return (
    <RenderErrorBoundary
      onError={reportDeferredSurfaceError}
      fallback={
        <SettingsLoading
          onClose={onClose}
          onRetry={() => window.location.reload()}
        />
      }
    >
      <Suspense fallback={<SettingsLoading onClose={onClose} />}>
        <DeferredSettingsSurface
          initialCategory={initialCategory}
          onClose={onClose}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
}

function resolveTheme(
  pref: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

function composeDocumentTitle(
  windowTitle: string | null,
  sessionName: string,
  attentionCount: number,
): string {
  const base =
    windowTitle ?? (sessionName ? `${sessionName} · INSΠRE` : "INSΠRE");
  return attentionCount > 0 ? `● ${base}` : base;
}

function TokenGate() {
  const [value, setValue] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="token-gate">
      <div className="token-gate__card">
        <div className="token-gate__lockup">
          <BrandLogo size={28} />
          <Wordmark large />
        </div>
        <div>
          <h1 className="token-gate__title">Pair this browser</h1>
          <p className="token-gate__hint">
            The host is running, but this browser has not been paired yet. Open
            the URL printed by <code>./inspire</code>, or paste its access token
            once below. The pairing is remembered on this device.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const token = value.trim();
            if (!token || pairing) return;
            setPairing(true);
            setError(null);
            void pairHost(token)
              .then(() => store.init(null))
              .catch((reason: unknown) => {
                setError(
                  reason instanceof ApiError && reason.status === 401
                    ? "That access token does not match this host."
                    : "The host became unavailable before pairing completed.",
                );
              })
              .finally(() => setPairing(false));
          }}
        >
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Access token"
            aria-label="Access token"
            autoComplete="off"
          />
          <button
            type="submit"
            className="button button--primary"
            disabled={!value.trim() || pairing}
          >
            {pairing ? "Pairing…" : "Pair"}
          </button>
        </form>
        {error ? (
          <p className="token-gate__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function connectionProblemText(
  problem: NonNullable<ReturnType<typeof store.getState>["connectionProblem"]>,
  host: string,
): { title: string; detail: string } {
  switch (problem.kind) {
    case "device-offline":
      return {
        title: "This device is offline",
        detail: `The browser reports no network connection, so ${host} cannot be checked yet.`,
      };
    case "relay-unavailable":
      return {
        title: "Reverse tunnel unavailable",
        detail: `The public entry at ${host} answered, but its SSH reverse path to the INSΠRE Host is unavailable.`,
      };
    case "service-error":
      return {
        title: "Host needs attention",
        detail: `The address answered at ${host}, but INSΠRE could not initialize: ${problem.message}`,
      };
    case "stream-interrupted":
      return {
        title: "Live connection interrupted",
        detail: `The last confirmed state remains visible while INSΠRE reconnects to ${host}.`,
      };
    default:
      return {
        title: "INSΠRE address not reachable",
        detail: `No usable response arrived from ${host}. The device network, public entry, reverse tunnel, or local Host may be unavailable.`,
      };
  }
}

function HostUnavailable({
  problem,
}: {
  problem: NonNullable<ReturnType<typeof store.getState>["connectionProblem"]>;
}) {
  const host = window.location.host;
  const localHost = /^(localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?$/u.test(
    host,
  );
  const copy = connectionProblemText(problem, host);
  return (
    <div className="token-gate">
      <div className="token-gate__card">
        <div className="token-gate__lockup">
          <BrandLogo size={28} />
          <Wordmark large />
        </div>
        <div>
          <h1 className="token-gate__title">{copy.title}</h1>
          <p className="token-gate__hint">{copy.detail}</p>
        </div>
        {localHost &&
        (problem.kind === "address-unreachable" ||
          problem.kind === "service-error") ? (
          <div className="token-gate__instruction">
            <span>
              Start or restart the local Host from the project directory:
            </span>
            <code>./inspire</code>
          </div>
        ) : null}
        <div className="token-gate__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => store.retryConnection()}
          >
            Try again
          </button>
          <span>
            <Loader2 size={12} className="spin" aria-hidden /> Reconnecting
            automatically
          </span>
        </div>
      </div>
    </div>
  );
}

function parseNoticeText(text: string): { tag: string | null; body: string } {
  const match = /^\(([^)]+)\):\s*(.+)$/s.exec(text);
  if (match) {
    return { tag: match[1]!, body: match[2]! };
  }
  return { tag: null, body: text };
}

function NoticeIcon({ kind }: { kind: Notice["kind"] }) {
  switch (kind) {
    case "warning":
      return <AlertTriangle size={13} aria-hidden />;
    case "error":
      return <XCircle size={13} aria-hidden />;
    default:
      return <Info size={13} aria-hidden />;
  }
}

function noticeDefaultTitle(kind: Notice["kind"]): string {
  switch (kind) {
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Notice";
  }
}

function NoticeItem({ notice }: { notice: Notice }) {
  const { tag, body } = parseNoticeText(notice.text);
  const copyLabel =
    notice.kind === "warning"
      ? "Warning"
      : notice.kind === "error"
        ? "Error"
        : "Notice";
  const title = tag
    ? `${noticeDefaultTitle(notice.kind)} · ${tag}`
    : noticeDefaultTitle(notice.kind);

  return (
    <div className={`notice notice--${notice.kind}`} role="status">
      <div className="notice__head">
        <span className="notice__title">
          <NoticeIcon kind={notice.kind} />
          <span>{title}</span>
        </span>
        <div className="notice__actions">
          <CopyAction
            text={notice.text}
            label={copyLabel}
            className="notice__copy"
          />
          <button
            type="button"
            className="notice__dismiss"
            onClick={() => store.dismissNotice(notice.id)}
            aria-label="Dismiss notification"
            title="Dismiss"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
      <div className="notice__text">{body}</div>
    </div>
  );
}

function updateNoticeText(updates: AvailableUpdates): string {
  const items: string[] = [];
  if (updates.pi) items.push(`Pi ${updates.pi.latestVersion}`);
  if (updates.extensions.length > 0) {
    items.push(
      `${updates.extensions.length} extension${updates.extensions.length === 1 ? "" : "s"}`,
    );
  }
  if (updates.inspire) items.push(`INSΠRE ${updates.inspire.latestVersion}`);
  return `${items.join(" · ")} available.`;
}

function updateNoticeDetails(updates: AvailableUpdates): string {
  const lines: string[] = [];
  if (updates.pi) {
    lines.push(
      `Pi ${updates.pi.currentVersion} → ${updates.pi.latestVersion}`,
      "Run pi update",
      updates.pi.releaseUrl,
    );
  }
  if (updates.extensions.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "Extensions",
      ...updates.extensions.map((update) => `- ${update.displayName}`),
      "Run pi update --extensions",
    );
  }
  if (updates.inspire) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `INSΠRE ${updates.inspire.currentVersion} → ${updates.inspire.latestVersion}`,
      updates.inspire.releaseUrl,
    );
  }
  return lines.join("\n");
}

function UpdateNotice({
  updates,
  onViewUpdates,
}: {
  updates: AvailableUpdates;
  onViewUpdates: () => void;
}) {
  const message = updateNoticeText(updates);
  return (
    <div className="notice notice--info" role="status">
      <div className="notice__head">
        <span className="notice__title">
          <Download size={13} aria-hidden />
          <span>Updates available</span>
        </span>
        <div className="notice__actions">
          <CopyAction
            text={updateNoticeDetails(updates)}
            label="Update details"
            className="notice__copy"
          />
          <button
            type="button"
            className="notice__dismiss"
            onClick={store.snoozeUpdate}
            aria-label="Close updates for 24 hours"
            title="Close for 24 hours"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
      <div className="notice__text">
        <span>{message}</span>{" "}
        <a
          className="notice__link"
          href="#settings-updates"
          onClick={(event) => {
            event.preventDefault();
            onViewUpdates();
          }}
        >
          View updates
        </a>
      </div>
    </div>
  );
}

const Notices = memo(function Notices({
  onViewUpdates,
}: {
  onViewUpdates: () => void;
}) {
  const state = useAppState(
    (source) => ({
      notices: source.notices,
      inspireUpdateChecking: source.inspireUpdateChecking,
      piUpdateChecking: source.piUpdateChecking,
      updateSnoozedUntil: source.updateSnoozedUntil,
      inspireUpdateCheck: source.inspireUpdateCheck,
      piUpdateCheck: source.piUpdateCheck,
    }),
    shallowEqual,
  );
  const updates =
    !state.inspireUpdateChecking &&
    !state.piUpdateChecking &&
    state.updateSnoozedUntil === null
      ? availableUpdates(state)
      : null;
  if (state.notices.length === 0 && !updates) return null;
  return (
    <div className="notices" aria-live="polite">
      {state.notices.map((notice) => (
        <NoticeItem key={notice.id} notice={notice} />
      ))}
      {updates ? (
        <UpdateNotice updates={updates} onViewUpdates={onViewUpdates} />
      ) : null}
    </div>
  );
});

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const ConversationStage = memo(function ConversationStage() {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      messages: source.messages,
      transcriptActivityRanges: source.transcriptActivityRanges,
      promptMapTurns: source.promptMapTurns,
      promptMapTotal: source.promptMapTotal,
      promptMapLoadedStarts: source.promptMapLoadedStarts,
      promptMapLoadingStarts: source.promptMapLoadingStarts,
      promptMapError: source.promptMapError,
      promptMapNavigatingOrdinal: source.promptMapNavigatingOrdinal,
      streaming: source.streaming,
      runState: source.runState,
      activeAssistantMessageKey: source.activeAssistantMessageKey,
      tools: source.tools,
      transcriptViewId: source.transcriptViewId,
      transcriptIncarnation: source.transcriptIncarnation,
      transcriptDurableLeafId: source.transcriptDurableLeafId,
      transcriptEffectiveLeafId: source.transcriptEffectiveLeafId,
      queue: source.queue,
      pendingAction: source.pendingAction,
      extensionDisplays: source.extensionDisplays,
      thinkingVisibility: source.prefs.thinkingVisibility,
      toolVisibility: source.prefs.toolVisibility,
      activityFoldVisibility: source.prefs.activityFoldVisibility,
      assistantRoundDisplay: source.prefs.assistantRoundDisplay,
      hasOlderMessages: source.hasOlderMessages,
      loadingOlderMessages: source.loadingOlderMessages,
      olderMessagesError: source.olderMessagesError,
    }),
    shallowEqual,
  );
  if (!state.sessionId) return null;

  const transcript = (
    <Transcript
      messages={state.messages}
      activityRanges={state.transcriptActivityRanges}
      promptMapTurns={state.promptMapTurns}
      promptMapTotal={state.promptMapTotal}
      promptMapLoadedStarts={state.promptMapLoadedStarts}
      promptMapLoadingStarts={state.promptMapLoadingStarts}
      promptMapError={state.promptMapError}
      promptMapNavigatingOrdinal={state.promptMapNavigatingOrdinal}
      streaming={state.streaming}
      runState={state.runState}
      activeAssistantMessageKey={state.activeAssistantMessageKey}
      toolActivity={state.tools}
      sessionId={state.sessionId}
      viewId={state.transcriptViewId ?? ""}
      projectionIncarnation={state.transcriptIncarnation ?? ""}
      viewingEarlierBranch={Boolean(
        state.transcriptDurableLeafId &&
          state.transcriptEffectiveLeafId &&
          state.transcriptDurableLeafId !== state.transcriptEffectiveLeafId,
      )}
      queue={state.queue}
      pendingAction={state.pendingAction}
      onManagePending={store.managePending}
      onPendingMessageTexts={store.pendingMessageTexts}
      extensionDisplays={state.extensionDisplays}
      thinkingVisibility={state.thinkingVisibility}
      toolVisibility={state.toolVisibility}
      activityFoldVisibility={state.activityFoldVisibility}
      assistantRoundDisplay={state.assistantRoundDisplay}
      hasOlder={state.hasOlderMessages}
      loadingOlder={state.loadingOlderMessages}
      olderError={state.olderMessagesError}
    />
  );
  const composer = (
    <div className="composer-dock">
      <ActivityBar />
      <ExtensionDisplayDock
        displays={state.extensionDisplays}
        placement="aboveEditor"
      />
      <Composer />
      <ExtensionDisplayDock
        displays={state.extensionDisplays}
        placement="belowEditor"
      />
    </div>
  );
  return (
    <section className="reading-stage">
      {MAINTENANCE_BENCHMARK ? (
        <Profiler id="transcript" onRender={recordBenchmarkCommit}>
          {transcript}
        </Profiler>
      ) : (
        transcript
      )}
      {MAINTENANCE_BENCHMARK ? (
        <Profiler id="composer" onRender={recordBenchmarkCommit}>
          {composer}
        </Profiler>
      ) : (
        composer
      )}
    </section>
  );
});

export function App() {
  const state = useAppState(
    (source) => ({
      needsToken: source.needsToken,
      bootstrapped: source.bootstrapped,
      connection: source.connection,
      connectionProblem: source.connectionProblem,
      extensionOverlayOpen: source.extensionUiRequests.length > 0,
      resourcesOpen: source.resourcesOpen,
      prefs: source.prefs,
      windowTitle: source.windowTitle,
      sessionName: source.sessionName,
      attentionCount: source.attentionSessionIds.length,
      sessionId: source.sessionId,
      runState: source.runState,
      error: source.error,
      errorSeverity: source.errorSeverity,
      projectionConflict: source.projectionConflict,
    }),
    shallowEqual,
  );
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const narrowViewport = useMediaQuery("(max-width: 900px)");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategoryId>("display");
  const extensionOverlayOpen = state.extensionOverlayOpen;
  const [welcomeInheritance, setWelcomeInheritance] =
    useState<WelcomeInheritance | null>(null);

  const openSession = useCallback((id: string) => {
    setPaletteOpen(false);
    setSettingsOpen(false);
    setMobileNavOpen(false);
    void store.openSession(id);
  }, []);

  const newSession = useCallback(() => {
    setPaletteOpen(false);
    setSettingsOpen(false);
    setMobileNavOpen(false);
    const current = store.getState();
    if (current.sessionId && current.cwd) {
      // Host deselection must clear session ownership, but the start surface
      // still inherits the workspace choices visible at the user's gesture.
      setWelcomeInheritance({
        cwd: current.cwd,
        model: current.model,
        thinkingLevel: current.thinkingLevel,
        commands: [...current.commands],
      });
    }
    void store.deselectSession().then((deselected) => {
      if (!deselected) return;
      store.setResourcesOpen(false);
    });
  }, []);

  useEffect(() => {
    if (state.sessionId) setWelcomeInheritance(null);
  }, [state.sessionId]);

  const closeMobileNavigation = useCallback(() => {
    setMobileNavOpen(false);
  }, []);
  const closeResources = useCallback(() => {
    store.setResourcesOpen(false);
  }, []);
  const closeCommandPalette = useCallback(() => setPaletteOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const toggleNavigation = useCallback(() => {
    if (narrowViewport) {
      if (!mobileNavOpen) store.setResourcesOpen(false);
      setMobileNavOpen(!mobileNavOpen);
    } else {
      setNavCollapsed((value) => !value);
    }
  }, [mobileNavOpen, narrowViewport]);

  const toggleResources = useCallback(() => {
    if (narrowViewport) setMobileNavOpen(false);
    store.setResourcesOpen(!store.getState().resourcesOpen);
  }, [narrowViewport]);

  useEffect(() => {
    if (!narrowViewport) setMobileNavOpen(false);
  }, [narrowViewport]);

  // Resource opens can originate inside the navigation tree. Close the nav
  // before paint so the narrow layout never mounts two modal drawers.
  useLayoutEffect(() => {
    if (narrowViewport && mobileNavOpen && state.resourcesOpen)
      setMobileNavOpen(false);
  }, [mobileNavOpen, narrowViewport, state.resourcesOpen]);

  // An extension dialog is an attributed operation boundary, not background
  // chrome. It supersedes the two app-level overlays instead of competing for
  // focus or Escape ownership.
  useEffect(() => {
    if (!extensionOverlayOpen) return;
    setPaletteOpen(false);
    setSettingsOpen(false);
  }, [extensionOverlayOpen]);

  const openCommandPalette = useCallback(() => {
    if (extensionOverlayOpen || hasActiveModal()) return;
    setSettingsOpen(false);
    setPaletteOpen(true);
  }, [extensionOverlayOpen]);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (extensionOverlayOpen || hasActiveModal()) return;
    setPaletteOpen(false);
    setSettingsCategory("display");
    setSettingsOpen(true);
  }, [extensionOverlayOpen, settingsOpen]);

  const openUpdateSettings = useCallback(() => {
    if (extensionOverlayOpen || (hasActiveModal() && !settingsOpen)) return;
    setPaletteOpen(false);
    setSettingsCategory("updates");
    setSettingsOpen(true);
  }, [extensionOverlayOpen, settingsOpen]);

  useEffect(() => {
    // theme-init.js owns the pre-bootstrap frame. Once the host has supplied
    // authoritative preferences, keep both the DOM and the small local cache
    // in sync for subsequent first paints.
    if (!state.bootstrapped) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(
        state.prefs.theme,
        media.matches,
      );
      document.documentElement.dataset.palette = state.prefs.palette;
      document.documentElement.dataset.contentTextSize =
        state.prefs.contentTextSize;
      document.documentElement.dataset.readingWidth = state.prefs.readingWidth;
      cacheVisualPreferences({
        theme: state.prefs.theme,
        palette: state.prefs.palette,
        contentTextSize: state.prefs.contentTextSize,
        readingWidth: state.prefs.readingWidth,
      });
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [
    state.bootstrapped,
    state.prefs.theme,
    state.prefs.palette,
    state.prefs.contentTextSize,
    state.prefs.readingWidth,
  ]);

  useEffect(() => {
    // Attention composes with Pi's extension-set title instead of replacing
    // it; the marker clears only when its owning session is viewed/focused.
    document.title = composeDocumentTitle(
      state.windowTitle,
      state.sessionName,
      state.attentionCount,
    );
  }, [state.windowTitle, state.sessionName, state.attentionCount]);

  useEffect(() => {
    const acknowledge = () => store.acknowledgeVisibleSession();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    acknowledge();
    return () => {
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [state.sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A modal owns every keyboard interaction until it closes. The one
      // exception is a projection conflict: its host-level recovery Escape
      // remains available when an extension request is visible.
      if (
        hasActiveModal() &&
        !(event.key === "Escape" && state.runState === "conflict")
      )
        return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCommandPalette();
      } else if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleNavigation();
      } else if (mod && event.key === ".") {
        event.preventDefault();
        toggleResources();
      } else if (event.key === "Escape" && narrowViewport && mobileNavOpen) {
        event.preventDefault();
        setMobileNavOpen(false);
      } else if (
        event.key === "Escape" &&
        narrowViewport &&
        state.resourcesOpen
      ) {
        event.preventDefault();
        store.setResourcesOpen(false);
      } else if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        isAbortableRunState(state.runState)
      ) {
        void store.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    state.runState,
    state.resourcesOpen,
    narrowViewport,
    mobileNavOpen,
    openCommandPalette,
    toggleNavigation,
    toggleResources,
  ]);

  if (state.needsToken) return <TokenGate />;
  if (
    !state.bootstrapped &&
    state.connection === "offline" &&
    state.connectionProblem
  ) {
    return <HostUnavailable problem={state.connectionProblem} />;
  }

  const isNavModal = narrowViewport && mobileNavOpen;
  const isResourcesModal = narrowViewport && state.resourcesOpen;
  const isAnyDrawerModal = isNavModal || isResourcesModal;

  const navigationContent =
    narrowViewport && !mobileNavOpen ? null : (
      <Nav
        collapsed={narrowViewport ? false : navCollapsed}
        isModal={isNavModal}
        onClose={closeMobileNavigation}
        selectedSessionId={state.sessionId}
        onNewSession={newSession}
        onSelectSession={openSession}
      />
    );
  const resourcesContent = state.resourcesOpen ? (
    <DeferredContextPane isModal={isResourcesModal} onClose={closeResources} />
  ) : null;

  return (
    <div className={`app ${narrowViewport ? "app--narrow" : ""}`}>
      {narrowViewport && mobileNavOpen ? (
        <button
          type="button"
          className="pane-scrim pane-scrim--nav"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}
      {MAINTENANCE_BENCHMARK ? (
        <Profiler id="navigation" onRender={recordBenchmarkCommit}>
          {navigationContent}
        </Profiler>
      ) : (
        navigationContent
      )}
      {!narrowViewport && !navCollapsed ? (
        <PaneResizeHandle
          cssVar="--nav-w"
          storageKey="inspire.nav-width"
          paneSelector=".nav"
          edge="end"
          min={220}
          max={() => 460}
          label="Resize navigation"
          variant="nav"
        />
      ) : null}
      <main className="center" inert={isAnyDrawerModal ? true : undefined}>
        <AppTopbar
          narrowViewport={narrowViewport}
          mobileNavOpen={mobileNavOpen}
          settingsOpen={settingsOpen}
          onToggleNavigation={toggleNavigation}
          onOpenCommandPalette={openCommandPalette}
          onToggleSettings={toggleSettings}
          onToggleResources={toggleResources}
        />
        {state.error ? (
          <div
            className={`banner banner--${state.errorSeverity}`}
            role={state.errorSeverity === "warning" ? "status" : "alert"}
          >
            <span className="banner__message">
              {state.error}
              {state.projectionConflict?.incidentId ? (
                <span role="group" aria-label="Diagnostic incident">
                  <code
                    className="banner__incident"
                    title="Diagnostic incident ID"
                  >
                    {state.projectionConflict.incidentId}
                  </code>
                </span>
              ) : null}
            </span>
            {state.projectionConflict ? (
              <button type="button" onClick={() => void store.abort()}>
                Recover
              </button>
            ) : (
              <button type="button" onClick={() => store.dismissError()}>
                Dismiss
              </button>
            )}
          </div>
        ) : null}
        {state.connection !== "open" && !state.error ? (
          <div className="banner banner--warning" role="status">
            <span>
              {state.connectionProblem
                ? connectionProblemText(
                    state.connectionProblem,
                    window.location.host,
                  ).detail
                : "The live INSΠRE connection was interrupted. The last confirmed state remains visible."}
            </span>
            <button type="button" onClick={() => store.retryConnection()}>
              Retry now
            </button>
          </div>
        ) : null}
        {settingsOpen && !extensionOverlayOpen ? (
          <DeferredSettings
            initialCategory={settingsCategory}
            onClose={closeSettings}
          />
        ) : null}
        {state.sessionId ? (
          <ConversationStage />
        ) : (
          <Welcome
            showRecent={narrowViewport ? !mobileNavOpen : navCollapsed}
            inherited={welcomeInheritance}
          />
        )}
      </main>
      {state.resourcesOpen ? (
        <>
          {narrowViewport ? (
            <button
              type="button"
              className="pane-scrim pane-scrim--resources"
              onClick={() => store.setResourcesOpen(false)}
              aria-label="Dismiss resources panel"
            />
          ) : (
            <PaneResizeHandle
              cssVar="--ctx-w"
              storageKey="inspire.ctx-width"
              paneSelector=".ctx"
              edge="start"
              min={320}
              max={(viewport) => Math.min(920, viewport - 640)}
              label="Resize files panel"
              variant="ctx"
              wheelTargetSelector="#context-pane [data-pane-scroll-active='true']"
            />
          )}
          {MAINTENANCE_BENCHMARK ? (
            <Profiler id="resources" onRender={recordBenchmarkCommit}>
              {resourcesContent}
            </Profiler>
          ) : (
            resourcesContent
          )}
        </>
      ) : null}
      {paletteOpen && !extensionOverlayOpen ? (
        <CommandPalette
          onClose={closeCommandPalette}
          onToggleNav={toggleNavigation}
          onToggleCtx={toggleResources}
          onNewSession={newSession}
          onOpenSession={openSession}
        />
      ) : null}
      <ExtensionUiDialog />
      <Notices onViewUpdates={openUpdateSettings} />
    </div>
  );
}
