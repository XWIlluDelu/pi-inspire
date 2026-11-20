import { AlertTriangle } from "lucide-react";
import {
  lazy,
  memo,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ThemePreference } from "../shared/contracts";
import type { ModelSettingsDestination } from "../shared/model-settings";
import { selectedRunState } from "./app-state";
import { pairBrowser } from "./browser-auth";
import { ActivityBar } from "./components/ActivityBar";
import { AppTopbar } from "./components/AppTopbar";
import { CommandActivity } from "./components/CommandActivity";
import { CommandHelp } from "./components/CommandHelp";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import {
  ContextPaneLoadingHeader,
  ContextPaneShell,
} from "./components/ContextPaneShell";
import { ContextPaneState } from "./components/ContextPaneState";
import { DirectoryPicker } from "./components/DirectoryPicker";
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
import type { SettingsCategoryId } from "./components/Settings";
import { SettingsDialog } from "./components/SettingsDialog";
import { StartupCard } from "./components/StartupCard";
import { ToolLoadoutDialog } from "./components/ToolLoadoutDialog";
import { Transcript, type TranscriptNavigation } from "./components/Transcript";
import { Welcome, type WelcomeInheritance } from "./components/Welcome";
import { isComposingKeyboardEvent, isEditableTarget } from "./keyboard-input";
import { thinkingLevelLabel } from "./model-options";
import {
  runStop,
  sessionActionAvailable,
  type SessionInspection,
  type WorkbenchDestinations,
} from "./session-actions";
import { shallowEqual, store, useAppState } from "./store";
import { useInspectionHistory } from "./use-inspection-history";
import { hasActiveModal, useModalDepth } from "./use-modal-focus";
import {
  applyBrowserTheme,
  cacheVisualPreferences,
} from "./visual-preferences";
import {
  modelCycleAction,
  runModelCycle,
  workbenchShortcut,
} from "./workbench-keyboard";
import { readNavCollapsed, saveNavCollapsed } from "./workbench-session";

const loadContextPane = () => import("./components/ContextPane");
const loadSettings = () => import("./components/Settings");
const DeferredContextSurface = lazy(() =>
  loadContextPane().then((module) => ({ default: module.ContextPane })),
);
const DeferredSettingsSurface = lazy(() =>
  loadSettings().then((module) => ({ default: module.SettingsContent })),
);

function DeferredPanel({
  surface,
  header,
  children,
}: {
  surface: "Settings" | "Context";
  header?: ReactNode;
  children: ReactNode;
}) {
  // Commit the loading panel immediately so focus can enter while code loads.
  const showContent = useDeferredValue(true, false);
  const fallback = (error: boolean) => (
    <>
      {header}
      <ContextPaneState
        className={error ? undefined : "deferred-loading"}
        icon={
          error ? (
            <AlertTriangle size={17} aria-hidden />
          ) : (
            <PiLoader size={17} aria-hidden />
          )
        }
        title={
          error
            ? `${surface} could not be opened.`
            : `Loading ${surface.toLowerCase()}`
        }
        role={error ? "alert" : "status"}
        action={error ? { label: "Refresh page", run: reloadPage } : undefined}
      />
    </>
  );
  const loading = fallback(false);
  return (
    <RenderErrorBoundary
      onError={(error) =>
        console.error("Deferred surface failed to load", error)
      }
      fallback={fallback(true)}
    >
      <Suspense fallback={loading}>{showContent ? children : loading}</Suspense>
    </RenderErrorBoundary>
  );
}

const reloadPage = () => window.location.reload();

function DeferredContextPane({
  isModal,
  onClose,
}: {
  isModal: boolean;
  onClose: () => void;
}) {
  return (
    <ContextPaneShell isModal={isModal} onClose={onClose}>
      <DeferredPanel
        surface="Context"
        header={<ContextPaneLoadingHeader onClose={onClose} />}
      >
        <DeferredContextSurface isModal={isModal} onClose={onClose} />
      </DeferredPanel>
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
  return (
    <SettingsDialog suspended={suspended} onClose={onClose}>
      <DeferredPanel surface="Settings">
        <DeferredSettingsSurface
          suspended={suspended}
          initialCategory={initialCategory}
          modelDestination={modelDestination}
          workspaceOwner={workspaceOwner}
        />
      </DeferredPanel>
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
    <StartupCard
      title="Pair this browser"
      hint="Open the link from the Inspire launcher or paste its access token. Pair only on a device you trust. This browser can control your sessions, files and terminals."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const token = value.trim();
          if (!token || pairing) return;
          setPairing(true);
          setError(null);
          void pairBrowser(token)
            .then(() => store.init())
            .catch((reason: unknown) => {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not reach the Host. Try pairing again.",
              );
            })
            .finally(() => setPairing(false));
        }}
      >
        <input
          type="password"
          className="text-field"
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
    </StartupCard>
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
        detail: "Reconnect to your network and try again.",
      };
    case "relay-unavailable":
      return {
        title: "Relay cannot reach the Host",
        detail: "Check that the Host and its tunnel are running.",
      };
    case "service-error":
      return {
        title: "Host needs attention",
        detail: problem.message,
      };
    case "stream-interrupted":
      return {
        title: "Live connection interrupted",
        detail: `Reconnecting to ${host}. Recent content stays visible.`,
      };
    default:
      return {
        title: "INSΠRE address not reachable",
        detail: `Could not connect to ${host}.`,
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
    <StartupCard title={copy.title} hint={copy.detail}>
      {localHost &&
      (problem.kind === "address-unreachable" ||
        problem.kind === "service-error") ? (
        <div className="token-gate__instruction">
          <span>Installed version</span>
          <code>inspire restart</code>
          <span>From the source folder</span>
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
    </StartupCard>
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

const ConversationStage = memo(function ConversationStage({
  transcriptRef,
}: {
  transcriptRef: RefObject<TranscriptNavigation | null>;
}) {
  const jumpToPending = useCallback(
    () => transcriptRef.current?.jumpToPending(),
    [transcriptRef],
  );
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      readOnlyReason: source.readOnlyReason,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      messages: source.live.messages,
      streaming: source.live.streaming,
      runState: selectedRunState(source),
      activeAssistantMessageKey: source.live.activeAssistantMessageKey,
      tools: source.live.tools,
      transcriptViewId: source.view.viewId,
      transcriptIncarnation: source.view.incarnation,
      transcriptHasOlder: source.view.hasOlder,
      historyVersion: source.view.composerHistoryVersion,
      queue: source.live.queue,
      pendingAction: source.pendingAction?.action ?? null,
      extensionDisplays: source.live.extensionDisplays,
      thinkingVisibility: source.prefs.thinkingVisibility,
      toolVisibility: source.prefs.toolVisibility,
      activityFoldVisibility: source.prefs.activityFoldVisibility,
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
      streaming={state.streaming}
      runState={state.runState}
      activeAssistantMessageKey={state.activeAssistantMessageKey}
      toolActivity={state.tools}
      sessionId={state.sessionId}
      viewId={state.transcriptViewId ?? ""}
      projectionIncarnation={state.transcriptIncarnation ?? ""}
      hasOlder={state.transcriptHasOlder}
      historyVersion={state.historyVersion ?? ""}
      queue={state.queue}
      pendingAction={state.pendingAction}
      extensionDisplays={state.extensionDisplays}
      thinkingVisibility={state.thinkingVisibility}
      toolVisibility={state.toolVisibility}
      activityFoldVisibility={state.activityFoldVisibility}
    />
  );
  const composer = (
    <div className="composer-dock">
      <ActivityBar onJumpToPending={jumpToPending} />
      <CommandActivity />
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
              <dd>{thinkingLevelLabel(state.thinkingLevel)}</dd>
            </div>
          </dl>
          {state.readOnlyReason === "external-active" && state.sessionId ? (
            <TakeOverNotice key={state.sessionId} sessionId={state.sessionId} />
          ) : state.readOnlyReason === "workspace-unavailable" ? (
            <WorkspaceRecoveryNotice
              key={`${state.sessionId}:${state.transcriptViewId}`}
            />
          ) : (
            <p role="status">
              Pi is unavailable. You can still read this session.
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

function WorkspaceRecoveryNotice() {
  const [fork, setFork] =
    useState<ReturnType<typeof store.prepareWorkspaceFork>>(null);
  const action = useAppState((state) => state.branchActionId);
  return (
    <div className="composer-readonly__notice">
      <p role="status">Project folder unavailable. This session is read-only.</p>
      <button
        type="button"
        className="button button--quiet"
        disabled={action !== null}
        onClick={() => {
          const prepared = store.prepareWorkspaceFork();
          if (prepared) setFork(() => prepared);
        }}
      >
        {action === "recover" ? "Forking…" : "Fork into another folder…"}
      </button>
      {fork ? (
        <DirectoryPicker
          title="Choose fork destination"
          actionLabel="Fork into this folder"
          onCancel={() => setFork(null)}
          onPick={(cwd) => {
            setFork(null);
            void fork(cwd);
          }}
        />
      ) : null}
    </div>
  );
}

/** Another Pi is running this branch: watch here, or take it over. Taking
 * over attaches to that Pi; its terminal keeps working alongside Inspire. */
function TakeOverNotice({ sessionId }: { sessionId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeOver = async () => {
    setPending(true);
    setError(null);
    try {
      await store.takeOverSession(sessionId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Take over failed");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="composer-readonly__notice" role="status">
      <p>Running in another Pi.</p>
      <button
        type="button"
        className="button button--quiet"
        disabled={pending}
        onClick={() => void takeOver()}
      >
        {pending ? "Taking over…" : "Take over"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function focusedTerminalLaunchRequested(): boolean {
  const params = new URLSearchParams(window.location.search);
  return Boolean(
    params.get("terminal")?.trim() && params.get("terminalFocus") === "1",
  );
}

type Inspection =
  | {
      kind: "settings";
      category: SettingsCategoryId;
      destination?: ModelSettingsDestination;
    }
  | { kind: "palette" }
  | { kind: "rename"; sessionId: string; name: string; fromPalette: boolean }
  | { kind: "export"; sessionId: string }
  | {
      kind: "tool-loadout";
      sessionId: string;
      viewId: string;
      transportGeneration: number;
    }
  | { kind: "help"; mode: "hotkeys" | "changelog" };

export function App() {
  const transcriptRef = useRef<TranscriptNavigation>(null);
  const state = useAppState(
    (source) => ({
      needsToken: source.needsToken,
      bootstrapped: source.bootstrapped,
      startupPending: source.startupPending,
      connection: source.connection,
      connectionProblem: source.connectionProblem,
      extensionOverlayOpen: source.live.extensionUiRequests.length > 0,
      resourcesOpen: source.resourcesOpen,
      contextMode: source.contextMode,
      prefs: source.prefs,
      windowTitle: source.live.windowTitle,
      sessionName: source.sessionName,
      attentionCount: source.attentionSessionIds.length,
      sessionId: source.sessionId,
      runState: selectedRunState(source),
      error: source.error,
      errorSeverity: source.errorSeverity,
      projectionConflict: source.view.conflict,
      nativeCommandUiRequest: source.nativeCommandUiRequest,
      readOnlyReason: source.readOnlyReason,
    }),
    shallowEqual,
  );
  const backdropDepth = useModalDepth();
  const [connectionDelayed, setConnectionDelayed] = useState(false);
  const connectionInterrupted = state.connection !== "open";
  useEffect(() => {
    if (!connectionInterrupted) {
      setConnectionDelayed(false);
      return;
    }
    const timer = window.setTimeout(() => setConnectionDelayed(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [connectionInterrupted]);
  const showConnectionBanner =
    connectionInterrupted &&
    (connectionDelayed ||
      (state.connectionProblem !== null &&
        state.connectionProblem.kind !== "stream-interrupted"));
  const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);
  useEffect(() => saveNavCollapsed(navCollapsed), [navCollapsed]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navSearchRef = useRef<HTMLInputElement>(null);
  const narrowViewport = useMediaQuery("(max-width: 900px)");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const settingsOpen = inspection?.kind === "settings";
  const closeInspection = useCallback(() => setInspection(null), []);
  const closeCommandPalette = useCallback(() => {
    setInspection((current) =>
      current?.kind === "palette" || current?.kind === "rename" ? null : current,
    );
  }, []);
  const openCommandHelp = useCallback((mode: "hotkeys" | "changelog") => {
    setInspection({ kind: "help", mode });
  }, []);
  const openSettings = useCallback(
    (category: SettingsCategoryId, destination?: ModelSettingsDestination) => {
      setInspection({ kind: "settings", category, destination });
    },
    [],
  );
  const openRename = useCallback((sessionId: string, name: string) => {
    setInspection((current) => ({
      kind: "rename",
      sessionId,
      name,
      fromPalette: current?.kind === "palette",
    }));
  }, []);
  const closeRename = useCallback(() => {
    setInspection((current) =>
      current?.kind === "rename"
        ? current.fromPalette
          ? { kind: "palette" }
          : null
        : current,
    );
  }, []);
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
    setInspection(null);
    setMobileNavOpen(false);
    void store.openSession(id);
  }, []);

  const newSession = useCallback(() => {
    setInspection(null);
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
    setInspection((current) =>
      (current?.kind === "export" || current?.kind === "rename" ||
        current?.kind === "tool-loadout") &&
      current.sessionId !== state.sessionId
        ? current.kind === "rename" && current.fromPalette
          ? { kind: "palette" }
          : null
        : current,
    );
  }, [state.sessionId]);

  const closeMobileNavigation = useCallback(() => {
    setMobileNavOpen(false);
  }, []);
  const closeResources = useCallback(() => {
    store.setResourcesOpen(false);
  }, []);
  const inspectionLayers = [
    ...(state.resourcesOpen ? ["context"] : []),
    ...(mobileNavOpen ? ["navigation"] : []),
    ...(inspection ? ["inspection"] : []),
    ...(inspection?.kind === "rename" && inspection.fromPalette
      ? ["rename"]
      : []),
    ...(extensionOverlayOpen ? ["extension"] : []),
  ];
  useInspectionHistory(
    narrowViewport ? inspectionLayers.length : 0,
    (depth) => {
      const remaining = inspectionLayers.slice(0, depth);
      if (!remaining.includes("extension"))
        extensionDialogRef.current?.cancel();
      if (!remaining.includes("inspection")) setInspection(null);
      else if (
        !remaining.includes("rename") &&
        inspection?.kind === "rename" &&
        inspection.fromPalette
      )
        closeRename();
      if (!remaining.includes("navigation")) setMobileNavOpen(false);
      if (!remaining.includes("context")) store.setResourcesOpen(false);
    },
    "__inspireWorkbench",
    { background: true },
  );
  const openSessionSearch = useCallback(() => {
    setInspection(null);
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
    setInspection((current) => (current?.kind === "help" ? null : current));
  }, [extensionOverlayOpen]);

  const showCommandPalette = useCallback(() => {
    setMobileNavOpen(false);
    setInspection({ kind: "palette" });
  }, []);
  const openCommandPalette = useCallback(() => {
    if (extensionOverlayOpen || hasActiveModal()) return;
    showCommandPalette();
  }, [extensionOverlayOpen, showCommandPalette]);
  const openSessionInspection = useCallback((kind: SessionInspection) => {
    const source = store.getState();
    const { sessionId, view: { viewId }, transportGeneration } = source;
    if (!sessionId || !sessionActionAvailable(kind, source)) return;
    const next: Inspection | null = kind === "export"
      ? { kind, sessionId }
      : viewId ? { kind, sessionId, viewId, transportGeneration } : null;
    if (!next) return;
    closeCommandPalette();
    // Let the invoking menu/palette restore focus before taking modal ownership.
    requestAnimationFrame(() => {
      if (store.getState().sessionId === sessionId)
        setInspection((previous) => previous ?? next);
    });
  }, [closeCommandPalette]);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setInspection(null);
      return;
    }
    if (extensionOverlayOpen || hasActiveModal()) return;
    openSettings("display");
  }, [extensionOverlayOpen, settingsOpen, openSettings]);

  const openUpdateSettings = useCallback(() => {
    if (extensionOverlayOpen || (hasActiveModal() && !settingsOpen)) return;
    openSettings("updates");
  }, [extensionOverlayOpen, settingsOpen, openSettings]);

  const destinations = useMemo<WorkbenchDestinations>(
    () => ({
      models: (request) =>
        openSettings("models", {
          query: request?.query,
          focus: request?.modelSettingsFocus,
          owner: request?.modelSettingsOwner,
        }),
      settings: () => openSettings("behavior"),
      updates: () => openSettings("updates"),
      hotkeys: () => openCommandHelp("hotkeys"),
      changelog: () => openCommandHelp("changelog"),
      sessions: openSessionSearch,
      new: newSession,
    }),
    [newSession, openCommandHelp, openSessionSearch, openSettings],
  );
  useEffect(() => {
    const request = state.nativeCommandUiRequest;
    if (!request) return;
    if (request.sessionId !== (store.getState().sessionId ?? "")) {
      store.consumeNativeCommandUiRequest(request.id);
      return;
    }
    if (
      request.action === "model" ||
      request.action === "thinking" ||
      request.action === "branches" ||
      extensionOverlayOpen
    )
      return;
    destinations[request.action](request);
    store.consumeNativeCommandUiRequest(request.id);
  }, [destinations, extensionOverlayOpen, state.nativeCommandUiRequest]);

  useLayoutEffect(() => {
    if (!state.bootstrapped || !focusedTerminalLaunchRequested()) return;
    if (state.contextMode !== "terminal" || !state.resourcesOpen)
      store.openContextMode("terminal");
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
        backdropDepth,
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
    backdropDepth,
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
        const draft = target?.matches("textarea.composer__input");
        const combobox = target?.closest("[role=combobox]");
        if (
          !store.getState().sessionId ||
          target?.closest(
            ".xterm, .choice-panel__body, [role=listbox], [role=menu]",
          ) ||
          (combobox &&
            (!draft || combobox.getAttribute("aria-expanded") !== "false")) ||
          (isEditableTarget(target) && !draft)
        )
          return;
        event.preventDefault();
        void runModelCycle(cycleAction);
        return;
      }
      const action = workbenchShortcut(event);
      if (action === "palette") {
        event.preventDefault();
        openCommandPalette();
      } else if (
        action === "find" &&
        transcriptRef.current &&
        target?.closest(".center") &&
        !target.closest(
          '[role=menu], [role=listbox], .model-picker__menu, [role=combobox][aria-expanded="true"]',
        )
      ) {
        event.preventDefault();
        transcriptRef.current.openSearch();
      } else if (action === "nav") {
        event.preventDefault();
        toggleNavigation();
      } else if (action === "ctx") {
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
      } else if (event.key === "Escape") {
        runStop(state.sessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    state.runState,
    state.sessionId,
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
          onInspectSession={openSessionInspection}
          onToggleSettings={toggleSettings}
          onToggleResources={toggleResources}
        />
        {state.error ? (
          <div
            className={`banner banner--${state.errorSeverity}`}
            role={state.errorSeverity === "warning" ? "status" : "alert"}
          >
            <span className="banner__message">{state.error}</span>
            <div className="banner__actions">
              {state.projectionConflict ? (
                <button type="button" onClick={() => void store.abort()}>
                  Reopen saved conversation
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
        {showConnectionBanner && !state.error ? (
          <div className="banner banner--warning" role="status">
            <span>
              {state.connectionProblem
                ? connectionProblemText(
                    state.connectionProblem,
                    window.location.host,
                  ).detail
                : "Connection lost. Recent content stays visible."}
            </span>
            <button type="button" onClick={() => store.retryConnection()}>
              Retry now
            </button>
          </div>
        ) : null}
        {state.sessionId ? (
          <ConversationStage transcriptRef={transcriptRef} />
        ) : !state.bootstrapped || state.startupPending ? (
          <ContextPaneState
            className="deferred-loading"
            icon={<PiLoader size={17} aria-hidden />}
            title="Loading workspace"
          />
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
              max={(viewportWidth) => viewportWidth}
              label="Resize files panel"
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
      {inspection?.kind === "settings" ? (
        <DeferredSettings
          suspended={extensionOverlayOpen}
          initialCategory={inspection.category}
          modelDestination={inspection.destination}
          workspaceOwner={settingsOwner}
          onClose={closeInspection}
        />
      ) : null}
      {inspection?.kind === "export" &&
      inspection.sessionId === state.sessionId ? (
        <ExportDialog
          key={inspection.sessionId}
          sessionId={inspection.sessionId}
          readOnly={Boolean(state.readOnlyReason)}
          active={!extensionOverlayOpen}
          onClose={closeInspection}
        />
      ) : null}
      {inspection?.kind === "tool-loadout" && inspection.sessionId === state.sessionId ? (
        <ToolLoadoutDialog
          sessionId={inspection.sessionId}
          viewId={inspection.viewId}
          transportGeneration={inspection.transportGeneration}
          active={!extensionOverlayOpen}
          onClose={closeInspection}
        />
      ) : null}
      {inspection?.kind === "palette" ||
      (inspection?.kind === "rename" && inspection.fromPalette) ? (
        <CommandPalette
          active={!extensionOverlayOpen}
          rename={inspection.kind === "rename" ? inspection : undefined}
          onRenameBack={closeRename}
          onClose={closeCommandPalette}
          onInspectSession={openSessionInspection}
          onRenameSession={openRename}
          onToggleNav={toggleNavigation}
          onToggleCtx={toggleResources}
          onOpenSession={openSession}
          destinations={destinations}
        />
      ) : null}
      {inspection?.kind === "help" && !extensionOverlayOpen ? (
        <CommandHelp
          key={inspection.mode}
          mode={inspection.mode}
          onClose={closeInspection}
        />
      ) : null}
      <ExtensionUiDialog ref={extensionDialogRef} />
      <Notices onViewUpdates={openUpdateSettings} />
    </div>
  );
}
