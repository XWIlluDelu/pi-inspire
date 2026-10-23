import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isAbortableRunState, type ThemePreference } from "../shared/contracts";
import type { ModelSettingsDestination } from "../shared/model-settings";
import { pairHost } from "./api";
import { ActivityBar } from "./components/ActivityBar";
import { AppTopbar } from "./components/AppTopbar";
import { CommandActivity } from "./components/CommandActivity";
import { CommandHelp } from "./components/CommandHelp";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import {
  ContextPaneLoading,
  ContextPaneShell,
} from "./components/ContextPaneShell";
import { ExportDialog } from "./components/ExportDialog";
import { ExtensionDisplayDock } from "./components/ExtensionDisplays";
import {
  ExtensionUiDialog,
  type ExtensionUiDialogHandle,
} from "./components/ExtensionUiDialog";
import { Nav } from "./components/Nav";
import { Notices } from "./components/Notices";
import { PaneResizeHandle } from "./components/PaneResizeHandle";
import { PiLoader } from "./components/PiLoader";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import {
  SessionTerminalDialog,
  TerminalSessionNotice,
} from "./components/SessionTerminalDialog";
import type { SettingsCategoryId } from "./components/Settings";
import { SettingsDialog, SettingsLoading } from "./components/SettingsDialog";
import { Transcript, type TranscriptNavigation } from "./components/Transcript";
import { Welcome, type WelcomeInheritance } from "./components/Welcome";
import { BrandLogo, Wordmark } from "./components/Wordmark";
import { isComposingKeyboardEvent } from "./keyboard-input";
import { shallowEqual, store, useAppState } from "./store";
import { useInspectionHistory } from "./use-inspection-history";
import { hasActiveModal } from "./use-modal-focus";
import {
  applyBrowserTheme,
  cacheVisualPreferences,
} from "./visual-preferences";
import { modelCycleAction } from "./workbench-keyboard";

const loadContextPane = () => import("./components/ContextPane");
const loadSettings = () => import("./components/Settings");
const DeferredContextSurface = lazy(() =>
  loadContextPane().then((module) => ({ default: module.ContextPane })),
);
const DeferredSettingsSurface = lazy(() =>
  loadSettings().then((module) => ({ default: module.SettingsContent })),
);

function reportDeferredSurfaceError(error: unknown): void {
  console.error("Deferred surface failed to load", error);
}

function DeferredContextPane({
  isModal,
  onClose,
}: {
  isModal: boolean;
  onClose: () => void;
}) {
  // Commit loading as ordinary content; suspended background work adds no fallback retry delay.
  const showContent = useDeferredValue(true, false);
  return (
    <ContextPaneShell isModal={isModal} onClose={onClose}>
      <RenderErrorBoundary
        onError={reportDeferredSurfaceError}
        fallback={
          <ContextPaneLoading
            onClose={onClose}
            onRetry={() => window.location.reload()}
          />
        }
      >
        <Suspense fallback={<ContextPaneLoading onClose={onClose} />}>
          {showContent ? (
            <DeferredContextSurface isModal={isModal} onClose={onClose} />
          ) : (
            <ContextPaneLoading onClose={onClose} />
          )}
        </Suspense>
      </RenderErrorBoundary>
    </ContextPaneShell>
  );
}

function DeferredSettings({
  suspended,
  initialCategory,
  modelDestination,
  workspaceOwner,
  onClose,
}: {
  suspended: boolean;
  initialCategory: SettingsCategoryId;
  modelDestination?: ModelSettingsDestination;
  workspaceOwner: { sessionId?: string; cwd?: string };
  onClose: () => void;
}) {
  const showContent = useDeferredValue(true, false);
  return (
    <SettingsDialog suspended={suspended} onClose={onClose}>
      <RenderErrorBoundary
        onError={reportDeferredSurfaceError}
        fallback={<SettingsLoading onRetry={() => window.location.reload()} />}
      >
        <Suspense fallback={<SettingsLoading />}>
          {showContent ? (
            <DeferredSettingsSurface
              suspended={suspended}
              initialCategory={initialCategory}
              modelDestination={modelDestination}
              workspaceOwner={workspaceOwner}
            />
          ) : (
            <SettingsLoading />
          )}
        </Suspense>
      </RenderErrorBoundary>
    </SettingsDialog>
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
  return attentionCount > 0 ? `• ${base}` : base;
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
            the URL printed by your Inspire launcher, or paste its access token
            once below. The pairing is remembered on this device. Pair only a
            device you trust: it can control Pi, project files, and terminals
            with your user account&apos;s permissions.
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
                  reason instanceof Error
                    ? reason.message
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
            <span>Start or restart the Host with the installed launcher:</span>
            <code>inspire restart</code>
            <span>Or, from a source checkout:</span>
            <code>npm run inspire -- restart</code>
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
            <PiLoader size={12} aria-hidden /> Reconnecting automatically
          </span>
        </div>
      </div>
    </div>
  );
}

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
  const transcriptRef = useRef<TranscriptNavigation>(null);
  const jumpToPending = useCallback(
    () => transcriptRef.current?.jumpToPending(),
    [],
  );
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      readOnlyReason: source.readOnlyReason,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
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
      hasOlderMessages: source.hasOlderMessages,
      loadingOlderMessages: source.loadingOlderMessages,
      olderMessagesError: source.olderMessagesError,
    }),
    shallowEqual,
  );
  if (!state.sessionId) return null;
  const modelIdentity = state.model
    ? `${state.model.provider}/${state.model.id}`
    : null;

  const transcript = (
    <Transcript
      ref={transcriptRef}
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
      extensionDisplays={state.extensionDisplays}
      thinkingVisibility={state.thinkingVisibility}
      toolVisibility={state.toolVisibility}
      activityFoldVisibility={state.activityFoldVisibility}
      hasOlder={state.hasOlderMessages}
      loadingOlder={state.loadingOlderMessages}
      olderError={state.olderMessagesError}
    />
  );
  const composer = (
    <div className="composer-dock">
      <CommandActivity />
      <ActivityBar onJumpToPending={jumpToPending} />
      <ExtensionDisplayDock
        displays={state.extensionDisplays}
        placement="aboveEditor"
      />
      {state.readOnlyReason ? (
        <div className="composer-readonly">
          <dl
            className="composer-readonly__settings"
            aria-label="Session settings"
          >
            <div>
              <dt>Model</dt>
              <dd
                title={
                  state.model?.name
                    ? `${state.model.name} — ${modelIdentity}`
                    : (modelIdentity ?? undefined)
                }
              >
                {modelIdentity ?? "Model unavailable"}
              </dd>
            </div>
            <div>
              <dt>Thinking</dt>
              <dd>{state.thinkingLevel}</dd>
            </div>
          </dl>
          {state.readOnlyReason === "terminal" ? (
            <TerminalSessionNotice
              key={state.sessionId}
              sessionId={state.sessionId}
            />
          ) : (
            <p role="status">
              {state.readOnlyReason === "workspace-unavailable"
                ? "Project folder unavailable. This session is read-only."
                : state.readOnlyReason === "external-active"
                  ? "Open in another Pi. Writing will resume automatically when it releases the session."
                  : "Pi connection unavailable. History remains readable while Inspire checks for recovery."}
            </p>
          )}
        </div>
      ) : (
        <Composer />
      )}
      <ExtensionDisplayDock
        displays={state.extensionDisplays}
        placement="belowEditor"
      />
    </div>
  );
  return (
    <section className="reading-stage">
      {transcript}
      {composer}
    </section>
  );
});

function focusedTerminalLaunchRequested(): boolean {
  const params = new URLSearchParams(window.location.search);
  return Boolean(
    params.get("terminal")?.trim() && params.get("terminalFocus") === "1",
  );
}

export function App() {
  const state = useAppState(
    (source) => ({
      needsToken: source.needsToken,
      bootstrapped: source.bootstrapped,
      connection: source.connection,
      connectionProblem: source.connectionProblem,
      extensionOverlayOpen: source.extensionUiRequests.length > 0,
      resourcesOpen: source.resourcesOpen,
      contextMode: source.contextMode,
      prefs: source.prefs,
      windowTitle: source.windowTitle,
      sessionName: source.sessionName,
      attentionCount: source.attentionSessionIds.length,
      sessionId: source.sessionId,
      runState: source.runState,
      bashRunning: source.bashRunning,
      error: source.error,
      errorSeverity: source.errorSeverity,
      projectionConflict: source.projectionConflict,
      nativeCommandUiRequest: source.nativeCommandUiRequest,
      readOnlyReason: source.readOnlyReason,
      fileBrowserView: source.fileBrowserView,
    }),
    shallowEqual,
  );
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navSearchRef = useRef<HTMLInputElement>(null);
  const narrowViewport = useMediaQuery("(max-width: 900px)");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(
    null,
  );
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandHelp, setCommandHelp] = useState<
    "hotkeys" | "changelog" | null
  >(null);
  const openCommandHelp = useCallback((mode: "hotkeys" | "changelog") => {
    setPaletteOpen(false);
    setSettingsOpen(false);
    setCommandHelp(mode);
  }, []);
  const closeCommandHelp = useCallback(() => setCommandHelp(null), []);
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategoryId>("display");
  const [modelDestination, setModelDestination] =
    useState<ModelSettingsDestination>();
  const openSettings = useCallback(
    (category: SettingsCategoryId, destination?: ModelSettingsDestination) => {
      setPaletteOpen(false);
      setSettingsCategory(category);
      setModelDestination(destination);
      setSettingsOpen(true);
    },
    [],
  );
  const openPaletteSettings = useCallback(
    () => openSettings("behavior"),
    [openSettings],
  );
  const extensionOverlayOpen = state.extensionOverlayOpen;
  const extensionDialogRef = useRef<ExtensionUiDialogHandle>(null);
  const [welcomeInheritance, setWelcomeInheritance] =
    useState<WelcomeInheritance | null>(null);
  const [prospectiveDirectory, setProspectiveDirectory] = useState("");
  const settingsOwner = useMemo(
    () =>
      state.sessionId
        ? { sessionId: state.sessionId }
        : { cwd: prospectiveDirectory || undefined },
    [state.sessionId, prospectiveDirectory],
  );

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
        sessionId: current.sessionId,
        cwd: current.cwd,
        model: current.model,
        modelDiscovery: current.modelDiscovery,
        readOnlyReason: current.readOnlyReason,
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
    setExportSessionId(null);
    setTerminalSessionId(null);
  }, [state.sessionId]);

  const closeMobileNavigation = useCallback(() => {
    setMobileNavOpen(false);
  }, []);
  const closeResources = useCallback(() => {
    store.setResourcesOpen(false);
  }, []);
  const closeCommandPalette = useCallback(() => setPaletteOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const inspectionLayers = [
    ...(state.resourcesOpen
      ? [
          "context",
          ...(state.contextMode === "files" &&
          state.fileBrowserView === "preview"
            ? ["file"]
            : []),
        ]
      : []),
    ...(mobileNavOpen ? ["navigation"] : []),
    ...(settingsOpen ? ["settings"] : []),
    ...(paletteOpen ? ["palette"] : []),
    ...(exportSessionId ? ["export"] : []),
    ...(terminalSessionId ? ["terminal-handoff"] : []),
    ...(extensionOverlayOpen ? ["extension"] : []),
  ];
  useInspectionHistory(
    narrowViewport ? inspectionLayers.length : 0,
    (depth) => {
      const remaining = inspectionLayers.slice(0, depth);
      if (!remaining.includes("extension"))
        extensionDialogRef.current?.cancel();
      if (!remaining.includes("terminal-handoff")) setTerminalSessionId(null);
      if (!remaining.includes("export")) setExportSessionId(null);
      if (!remaining.includes("palette")) setPaletteOpen(false);
      if (!remaining.includes("settings")) setSettingsOpen(false);
      if (!remaining.includes("navigation")) setMobileNavOpen(false);
      if (!remaining.includes("context")) store.setResourcesOpen(false);
      else if (!remaining.includes("file") && state.contextMode === "files")
        store.showFileBrowser();
    },
    "__inspireWorkbench",
  );
  const openSessionSearch = useCallback(() => {
    setPaletteOpen(false);
    setSettingsOpen(false);
    setCommandHelp(null);
    if (narrowViewport) {
      store.setResourcesOpen(false);
      setMobileNavOpen(true);
    } else setNavCollapsed(false);
    // Let the old modal release focus and the existing navigation mount first.
    requestAnimationFrame(() => {
      navSearchRef.current?.focus();
      navSearchRef.current?.select();
    });
  }, [narrowViewport]);

  const toggleNavigation = useCallback(() => {
    if (narrowViewport) {
      if (!mobileNavOpen) store.setResourcesOpen(false);
      setMobileNavOpen(!mobileNavOpen);
    } else {
      const focusWasInNav = Boolean(document.activeElement?.closest(".nav"));
      setNavCollapsed((value) => !value);
      // The desktop toggle moves with the sidebar. Keep its keyboard position
      // when collapsing/remounting nav content, but never take focus from the editor.
      if (focusWasInNav)
        requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>(".nav__toggle")?.focus(),
        );
    }
  }, [mobileNavOpen, narrowViewport]);

  const toggleResources = useCallback(() => {
    if (narrowViewport) setMobileNavOpen(false);
    store.setResourcesOpen(!store.getState().resourcesOpen);
  }, [narrowViewport]);

  useEffect(() => {
    if (!narrowViewport) setMobileNavOpen(false);
  }, [narrowViewport]);

  // Resource opens close navigation before paint so the narrow layout never
  // mounts two modal drawers.
  useLayoutEffect(() => {
    if (narrowViewport && mobileNavOpen && state.resourcesOpen)
      setMobileNavOpen(false);
  }, [mobileNavOpen, narrowViewport, state.resourcesOpen]);

  // Native questions take priority without discarding Settings, palette or
  // export drafts. Read-only command help can close instead of resuming.
  useEffect(() => {
    if (!extensionOverlayOpen) return;
    setCommandHelp(null);
  }, [extensionOverlayOpen]);

  const showCommandPalette = useCallback(() => {
    setSettingsOpen(false);
    setMobileNavOpen(false);
    setPaletteOpen(true);
  }, []);
  const openCommandPalette = useCallback(() => {
    if (extensionOverlayOpen || hasActiveModal()) return;
    showCommandPalette();
  }, [extensionOverlayOpen, showCommandPalette]);
  const openExport = useCallback(() => {
    const sessionId = store.getState().sessionId;
    setPaletteOpen(false);
    // Let the invoking menu/palette restore focus before taking modal ownership.
    requestAnimationFrame(() => {
      if (store.getState().sessionId === sessionId)
        setExportSessionId(sessionId);
    });
  }, []);
  const closeExport = useCallback(() => setExportSessionId(null), []);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (extensionOverlayOpen || hasActiveModal()) return;
    openSettings("display");
  }, [extensionOverlayOpen, settingsOpen, openSettings]);

  const openUpdateSettings = useCallback(() => {
    if (extensionOverlayOpen || (hasActiveModal() && !settingsOpen)) return;
    openSettings("updates");
  }, [extensionOverlayOpen, settingsOpen, openSettings]);

  useEffect(() => {
    const request = state.nativeCommandUiRequest;
    if (!request) return;
    if (request.sessionId !== (store.getState().sessionId ?? "")) {
      store.consumeNativeCommandUiRequest(request.id);
      return;
    }
    if (request.action === "model" || request.action === "thinking") return;
    if (extensionOverlayOpen) return;
    if (request.action === "models") {
      openSettings("models", {
        query: request.query,
        focus: request.modelSettingsFocus,
        owner: request.modelSettingsOwner,
      });
    } else if (request.action === "settings") {
      openSettings("behavior");
    } else if (request.action === "updates") {
      openSettings("updates");
    } else if (request.action === "hotkeys" || request.action === "changelog") {
      openCommandHelp(request.action);
    } else if (request.action === "sessions") {
      openSessionSearch();
    } else if (request.action === "new") {
      newSession();
    }
    store.consumeNativeCommandUiRequest(request.id);
  }, [
    extensionOverlayOpen,
    newSession,
    openCommandHelp,
    openSessionSearch,
    openSettings,
    state.nativeCommandUiRequest,
  ]);

  useLayoutEffect(() => {
    if (!state.bootstrapped || !focusedTerminalLaunchRequested()) return;
    if (state.contextMode !== "terminal") store.setContextMode("terminal");
    if (!state.resourcesOpen) store.setResourcesOpen(true);
  }, [state.bootstrapped, state.contextMode, state.resourcesOpen]);

  useEffect(() => {
    // theme-init.js owns the pre-bootstrap frame. Once the host has supplied
    // authoritative preferences, keep both the DOM and the small local cache
    // in sync for subsequent first paints.
    if (!state.bootstrapped) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const overlay = window.matchMedia(
      "(display-mode: window-controls-overlay)",
    );
    const apply = () => {
      document.documentElement.dataset.palette = state.prefs.palette;
      applyBrowserTheme(
        resolveTheme(state.prefs.theme, media.matches),
        overlay.matches,
      );
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
    overlay.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      overlay.removeEventListener("change", apply);
    };
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
      if (
        event.defaultPrevented ||
        isComposingKeyboardEvent(event) ||
        event.getModifierState("AltGraph")
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      const cycleAction = modelCycleAction(event);
      if (cycleAction) {
        const editable = target?.closest(
          "input,textarea,[contenteditable=true]",
        );
        const draft = editable && target?.closest(".composer");
        const combobox = target?.closest("[role=combobox]");
        if (
          !store.getState().sessionId ||
          target?.closest(
            ".xterm, .dropdown__menu, .model-picker__menu, [role=listbox], [role=menu]",
          ) ||
          (combobox &&
            (!draft || combobox.getAttribute("aria-expanded") !== "false")) ||
          (editable && !draft)
        )
          return;
        event.preventDefault();
        if (cycleAction === "thinking") void store.cycleThinking();
        else void store.cycleModel(cycleAction === "next-model" ? 1 : -1);
        return;
      }
      const mod =
        event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey;
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
        (isAbortableRunState(state.runState) || state.bashRunning)
      ) {
        void store.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    state.runState,
    state.bashRunning,
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
        onToggleNavigation={toggleNavigation}
        selectedSessionId={state.sessionId}
        searchInputRef={navSearchRef}
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
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}
      {navigationContent}
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
          layoutKey={String(state.resourcesOpen)}
          peerPane={{ cssVar: "--ctx-w", paneSelector: ".ctx" }}
        />
      ) : null}
      <main className="center" inert={isAnyDrawerModal ? true : undefined}>
        <AppTopbar
          narrowViewport={narrowViewport}
          mobileNavOpen={mobileNavOpen}
          settingsOpen={settingsOpen}
          onToggleNavigation={toggleNavigation}
          onOpenCommandPalette={openCommandPalette}
          onExportSession={openExport}
          onTerminalSession={() => setTerminalSessionId(state.sessionId)}
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
            <div className="banner__actions">
              {state.projectionConflict ? (
                <button type="button" onClick={() => void store.abort()}>
                  Recover
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void store.refreshSession()}
                  >
                    Retry
                  </button>
                  <button type="button" onClick={() => store.dismissError()}>
                    Dismiss
                  </button>
                </>
              )}
            </div>
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
        {state.sessionId ? (
          <ConversationStage />
        ) : (
          <Welcome
            showRecent={narrowViewport ? !mobileNavOpen : navCollapsed}
            inherited={welcomeInheritance}
            onDirectoryChange={setProspectiveDirectory}
          />
        )}
      </main>
      {state.resourcesOpen ? (
        <>
          {!narrowViewport ? (
            <PaneResizeHandle
              cssVar="--ctx-w"
              storageKey="inspire.ctx-width"
              paneSelector=".ctx"
              edge="start"
              min={320}
              max={() => 920}
              label="Resize files panel"
              variant="ctx"
              layoutKey={String(navCollapsed)}
              peerPane={{
                cssVar: "--nav-w",
                paneSelector: ".nav:not(.nav--rail)",
              }}
              wheelTargetSelector="#context-pane [data-pane-scroll-active='true']"
            />
          ) : null}
          {resourcesContent}
        </>
      ) : null}
      {settingsOpen ? (
        <DeferredSettings
          suspended={extensionOverlayOpen}
          initialCategory={settingsCategory}
          modelDestination={modelDestination}
          workspaceOwner={settingsOwner}
          onClose={closeSettings}
        />
      ) : null}
      {terminalSessionId ? (
        <SessionTerminalDialog
          key={terminalSessionId}
          sessionId={terminalSessionId}
          active={!extensionOverlayOpen}
          onClose={() => setTerminalSessionId(null)}
        />
      ) : null}
      {exportSessionId && exportSessionId === state.sessionId ? (
        <ExportDialog
          key={exportSessionId}
          sessionId={exportSessionId}
          readOnly={Boolean(state.readOnlyReason)}
          active={!extensionOverlayOpen}
          onClose={closeExport}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          onExportSession={openExport}
          active={!extensionOverlayOpen}
          onClose={closeCommandPalette}
          onToggleNav={toggleNavigation}
          onToggleCtx={toggleResources}
          onNewSession={newSession}
          onOpenSession={openSession}
          onFindSession={openSessionSearch}
          onOpenSettings={openPaletteSettings}
          onOpenHelp={openCommandHelp}
        />
      ) : null}
      {commandHelp && !extensionOverlayOpen ? (
        <CommandHelp
          key={commandHelp}
          mode={commandHelp}
          onClose={closeCommandHelp}
        />
      ) : null}
      <ExtensionUiDialog ref={extensionDialogRef} />
      <Notices onViewUpdates={openUpdateSettings} />
    </div>
  );
}
