import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Circle,
  ClipboardPaste,
  Copy,
  Eraser,
  ExternalLink,
  Eye,
  FolderKanban,
  Keyboard,
  Maximize2,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  SquareTerminal,
  TextSelect,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  parentSegment,
  projectNameFromCwd as projectLabel,
} from "../../shared/contracts";
import {
  type TerminalCatalogResponse,
  type TerminalDescriptor,
  type TerminalProfile,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts";
import { createApi } from "../api";
import { showBrowserNotification } from "../browser-notifications";
import {
  TerminalChangePending,
  terminalOperations,
} from "../controllers/terminal-operation-controller";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  hasTerminalInsertion,
  subscribeTerminalActions,
  subscribeTerminalInsertion,
  type TerminalActionIntent,
} from "../terminal-actions";
import { TerminalCatalogController } from "../terminal-catalog";
import {
  isTerminalShortcutTarget,
  terminalShortcut,
} from "../terminal-keyboard";
import { dismissTerminalMenu, TERMINAL_MENU_SELECTOR } from "../terminal-menus";
import {
  loadTerminalUiSettings,
  type TerminalUiSettings,
} from "../terminal-settings";
import { recoverModalFocus } from "../use-modal-focus";
import { ButtonLabel } from "./ButtonLabel";
import { ContextPaneState } from "./ContextPaneState";
import {
  ContextTabStrip,
  type FileDockTab,
  type TerminalDockTab,
} from "./ContextTabStrip";
import { DetailSummary } from "./DetailSummary";
import { FloatingPaneActions } from "./FloatingPaneActions";
import { handleDockTabKey } from "./dock-tab-keyboard";
import { NoticeCard } from "./NoticeCard";
import { PiLoader } from "./PiLoader";
import { SearchField } from "./SearchField";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";
import type { TerminalViewActions } from "./TerminalView";

const TerminalView = lazy(() =>
  import("./TerminalView").then(({ TerminalView }) => ({
    default: TerminalView,
  })),
);
const TerminalSettingsDialog = lazy(() =>
  import("./TerminalSettingsDialog").then(({ TerminalSettingsDialog }) => ({
    default: TerminalSettingsDialog,
  })),
);
function TerminalStatusIcon({
  transport,
  exited,
}: Pick<TerminalViewActions, "transport" | "exited">) {
  if (exited) return <Square size={12} aria-hidden />;
  if (transport === "connected") return <Eye size={16} aria-hidden />;
  if (transport === "offline") return <Circle size={16} aria-hidden />;
  return <PiLoader size={16} aria-hidden />;
}

const TERMINAL_LOADING = (
  <ContextPaneState
    className="terminal-empty"
    icon={<PiLoader size={17} aria-hidden />}
    title="Loading terminal…"
  />
);

interface WorkspaceDockProps {
  cwd: string | null;
  active?: boolean;
  reloadKey?: number;
  context?: {
    files: readonly FileDockTab[];
    tools: ReactNode;
    body: ReactNode;
  };
  onActivate?(): void;
  onOpenFile?(reference: string): void;
  onSendToComposer?(text: string): void;
  onCommandComplete?(): void;
}

interface TerminalLaunchTarget {
  id: string;
  focus: boolean;
}

interface RecentlyClosed {
  terminal: TerminalDescriptor;
  closedAt: number;
}

const ACTIVE_KEY_PREFIX = "inspire:terminal-active:";
const EMPTY_TERMINALS: TerminalDescriptor[] = [];

function readTerminalLaunchTarget(): TerminalLaunchTarget | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("terminal")?.trim();
  if (!id) return null;
  return { id, focus: params.get("terminalFocus") === "1" };
}

function storedActiveTerminal(cwd: string): string | null {
  try {
    return sessionStorage.getItem(`${ACTIVE_KEY_PREFIX}${cwd}`);
  } catch {
    return null;
  }
}

function storeActiveTerminal(cwd: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(`${ACTIVE_KEY_PREFIX}${cwd}`, id);
    else sessionStorage.removeItem(`${ACTIVE_KEY_PREFIX}${cwd}`);
  } catch {
    // Selection persistence is a convenience; terminal authority is remote.
  }
}

function terminalLabel(terminal: TerminalDescriptor): string {
  const title = terminal.title.trim();
  return title || terminal.shellLabel || "Terminal";
}

function notificationTerminalLabel(terminal: TerminalDescriptor): string {
  return terminal.titleSource === "user"
    ? terminalLabel(terminal)
    : terminal.shellLabel || "Terminal";
}

export const WorkspaceDock = memo(function WorkspaceDock({
  cwd: sessionCwd,
  active = true,
  reloadKey = 0,
  context,
  onActivate,
  onOpenFile,
  onSendToComposer,
  onCommandComplete,
}: WorkspaceDockProps) {
  const api = useMemo(() => createApi(), []);
  const launchTarget = useMemo(readTerminalLaunchTarget, []);
  const lastSessionCwdRef = useRef(sessionCwd);
  const [cwd, setCwd] = useState(sessionCwd);
  const [catalogOwner, setCatalogOwner] = useState(() => ({
    controller: new TerminalCatalogController(cwd),
    reloadKey,
  }));
  if (
    catalogOwner.controller.cwd !== cwd ||
    catalogOwner.reloadKey !== reloadKey
  )
    setCatalogOwner({
      controller: new TerminalCatalogController(cwd, catalogOwner.controller),
      reloadKey,
    });
  const catalogController = catalogOwner.controller;
  const catalog = useSyncExternalStore(
    catalogController.subscribe,
    catalogController.snapshot,
  );
  const [globalCatalog, setGlobalCatalog] =
    useState<TerminalCatalogResponse | null>(null);
  const [activeId, setActiveId] = useState<string | null>(
    launchTarget?.id ?? null,
  );
  const [openedIds, setOpenedIds] = useState<Set<string>>(new Set());
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [bellIds, setBellIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(launchTarget?.focus ?? false);
  const showingContext = context && !focused;
  const visibleCatalog = Boolean(context || active);
  const [viewActions, setViewActions] = useState<TerminalViewActions | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiSettings, setUiSettings] = useState<TerminalUiSettings>(() =>
    loadTerminalUiSettings(),
  );
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [recentlyClosed, setRecentlyClosed] = useState<RecentlyClosed | null>(
    null,
  );
  const [terminalFilter, setTerminalFilter] = useState("");
  const [globalLoading, setGlobalLoading] = useState(false);
  const [insertionRevision, setInsertionRevision] = useState(0);
  const requestGeneration = useRef(0);
  const foregroundCatalog = useRef(false);
  const knownOutputOffsetsRef = useRef(new Map<string, number>());
  const autoCreateInsertionRef = useRef<string | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const profileMenuRef = useRef<HTMLDetailsElement>(null);
  const menuGroupName = useId();
  const renamePendingRef = useRef(false);
  const terminalActionHandlerRef = useRef<
    (intent: TerminalActionIntent) => boolean
  >(() => false);

  useLayoutEffect(() => {
    catalogController.active = true;
    foregroundCatalog.current = false;
    setLoading(false);
    setCreating(false);
    setError(null);
    setRenameId(null);
    renamePendingRef.current = false;
    return () => {
      catalogController.active = false;
    };
  }, [catalogController]);

  const terminals = catalog?.terminals ?? EMPTY_TERMINALS;
  const activeTerminal = terminals.find((terminal) => terminal.id === activeId);

  useEffect(() => {
    if (launchTarget || lastSessionCwdRef.current === sessionCwd) return;
    lastSessionCwdRef.current = sessionCwd;
    setActiveId(null);
    setCwd(sessionCwd);
  }, [launchTarget, sessionCwd]);

  useEffect(() => {
    if (!launchTarget) return;
    let cancelled = false;
    void api
      .json("terminals", { query: {} })
      .then((next) => {
        if (cancelled) return;
        const target = next.terminals.find(
          (terminal) => terminal.id === launchTarget.id,
        );
        if (!target) throw new Error("The requested terminal no longer exists");
        setCwd(target.projectCwd);
        setActiveId(target.id);
      })
      .catch((launchError: unknown) => {
        if (!cancelled)
          setError(
            launchError instanceof Error
              ? launchError.message
              : "Terminal could not be opened",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [api, launchTarget]);

  const load = useCallback(
    async (poll = false) => {
      if (
        !cwd ||
        !catalogController.active ||
        (poll && foregroundCatalog.current)
      )
        return;
      const generation = ++requestGeneration.current;
      const current = () =>
        generation === requestGeneration.current && catalogController.active;
      if (!poll) {
        foregroundCatalog.current = true;
        setLoading(true);
        setError(null);
      }
      void terminalOperations.resume();
      try {
        const next = await api.json("terminals", { query: { cwd } });
        if (!current() || !catalogController.replace(next)) return;
        setActiveId((id) => {
          const preferred = id ?? storedActiveTerminal(cwd);
          return next.terminals.some((terminal) => terminal.id === preferred)
            ? preferred
            : (next.terminals[0]?.id ?? null);
        });
      } catch (error) {
        if (!poll && current())
          setError(
            error instanceof Error ? error.message : "Terminals failed to load",
          );
      } finally {
        if (!poll && current()) {
          foregroundCatalog.current = false;
          setLoading(false);
        }
      }
    },
    [api, cwd, catalogController],
  );

  const loadGlobal = useCallback(async () => {
    if (globalLoading) return;
    setGlobalLoading(true);
    try {
      setGlobalCatalog(await api.json("terminals", { query: {} }));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Terminal list failed to load",
      );
    } finally {
      setGlobalLoading(false);
    }
  }, [api, globalLoading]);

  useEffect(() => {
    if (!visibleCatalog) return;
    void load();
    let polling = false;
    const timer =
      active && cwd
        ? window.setInterval(async () => {
            if (polling || !catalogController.snapshot()) return;
            polling = true;
            try {
              await load(true);
            } finally {
              polling = false;
            }
          }, 5_000)
        : undefined;
    return () => {
      window.clearInterval(timer);
      requestGeneration.current += 1;
      foregroundCatalog.current = false;
    };
  }, [active, cwd, load, visibleCatalog, catalogController]);

  useEffect(
    () =>
      subscribeTerminalInsertion(() => {
        if (!sessionCwd || !hasTerminalInsertion(sessionCwd)) return;
        if (cwd !== sessionCwd) {
          setActiveId(null);
          setCwd(sessionCwd);
        }
        setInsertionRevision((revision) => revision + 1);
      }),
    [cwd, sessionCwd],
  );

  useEffect(() => {
    if (active && cwd && catalog) storeActiveTerminal(cwd, activeId);
    const ids = new Set(terminals.map((terminal) => terminal.id));
    const selected = active ? activeId : null;
    setOpenedIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      if (selected && ids.has(selected)) next.add(selected);
      return next;
    });
    const keepBackground = (current: Set<string>) =>
      new Set([...current].filter((id) => ids.has(id) && id !== selected));
    setUnreadIds(keepBackground);
    setBellIds(keepBackground);
    if (catalog && activeId && !ids.has(activeId))
      setActiveId(terminals[0]?.id ?? null);
  }, [active, activeId, catalog, cwd, terminals]);

  useEffect(() => {
    const knownOffsets = knownOutputOffsetsRef.current;
    const nextIds = new Set(terminals.map((terminal) => terminal.id));
    const newlyUnread = terminals
      .filter((terminal) => {
        const previous = knownOffsets.get(terminal.id);
        knownOffsets.set(terminal.id, terminal.nextOutputOffset);
        return (
          previous !== undefined &&
          terminal.nextOutputOffset > previous &&
          (!active || terminal.id !== activeId)
        );
      })
      .map((terminal) => terminal.id);
    for (const id of [...knownOffsets.keys()]) {
      if (!nextIds.has(id)) knownOffsets.delete(id);
    }
    if (newlyUnread.length > 0)
      setUnreadIds((current) => new Set([...current, ...newlyUnread]));
  }, [active, activeId, terminals]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const openMenus = () =>
      pane.querySelectorAll<HTMLDetailsElement>(
        `${TERMINAL_MENU_SELECTOR}[open]`,
      );
    const dismissMenus = (event: PointerEvent) => {
      for (const menu of openMenus()) {
        if (!menu.contains(event.target as Node)) menu.open = false;
      }
    };
    document.addEventListener("pointerdown", dismissMenus, true);
    return () => {
      document.removeEventListener("pointerdown", dismissMenus, true);
    };
  }, [cwd]);

  const onMenuKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKeyboardEvent(event.nativeEvent)) return;
    if (
      event.key === "Escape" &&
      dismissTerminalMenu(paneRef.current, event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  useEffect(() => {
    if (!recentlyClosed) return;
    const remaining = 30_000 - (Date.now() - recentlyClosed.closedAt);
    if (remaining <= 0) {
      setRecentlyClosed(null);
      return;
    }
    const timer = window.setTimeout(() => setRecentlyClosed(null), remaining);
    return () => window.clearTimeout(timer);
  }, [recentlyClosed]);

  const runControl = useCallback(
    async (fallback: string, perform: () => Promise<void>) => {
      try {
        await perform();
      } catch (error) {
        if (
          catalogController.active &&
          !(error instanceof TerminalChangePending)
        )
          setError(error instanceof Error ? error.message : fallback);
      }
    },
    [catalogController],
  );

  const commitDescriptor = useCallback(
    async (terminal: TerminalDescriptor, select = false) => {
      const result = catalogController.upsert(terminal);
      if (result === "refresh") await load();
      if (
        select &&
        catalogController.active &&
        catalogController
          .snapshot()
          ?.terminals.some(
            (candidate) =>
              candidate.id === terminal.id &&
              candidate.catalogEpoch === terminal.catalogEpoch,
          )
      )
        setActiveId(terminal.id);
    },
    [catalogController, load],
  );

  const createTerminal = useCallback(
    async (profile?: TerminalProfile) => {
      if (!cwd || creating) return;
      setCreating(true);
      setError(null);
      await runControl("Terminal could not be created", async () => {
        const terminal = await api.terminalOperation({
          command: "create",
          params: {
            request: profile ? { cwd, profileId: profile.id } : { cwd },
          },
        });
        await commitDescriptor(terminal, true);
      });
      if (catalogController.active) setCreating(false);
    },
    [api, creating, cwd, catalogController, commitDescriptor, runControl],
  );

  const availableProfiles =
    catalog?.profiles.filter((profile) => profile.available) ?? [];
  const hasProfileChoice = availableProfiles.length > 1;
  const createFromControl = () => {
    if (
      hasProfileChoice &&
      window.matchMedia("(hover: none), (pointer: coarse), (max-width: 720px)")
        .matches
    ) {
      const menu = profileMenuRef.current;
      if (menu) {
        menu.open = true;
        menu.querySelector("summary")?.focus();
      }
    } else {
      void createTerminal();
    }
  };

  useEffect(() => {
    if (
      !active ||
      !cwd ||
      !catalog ||
      loading ||
      creating ||
      !hasTerminalInsertion(cwd)
    )
      return;
    const running =
      terminals.find(
        (terminal) => terminal.id === activeId && terminal.status === "running",
      ) ?? terminals.find((terminal) => terminal.status === "running");
    if (running) {
      if (activeId !== running.id) setActiveId(running.id);
      return;
    }
    const attemptKey = `${cwd}\0${insertionRevision}`;
    if (autoCreateInsertionRef.current === attemptKey) return;
    autoCreateInsertionRef.current = attemptKey;
    void createTerminal();
  }, [
    active,
    activeId,
    catalog,
    createTerminal,
    creating,
    cwd,
    insertionRevision,
    loading,
    terminals,
  ]);

  const applyDescriptor = useCallback(
    (terminal: TerminalDescriptor) => {
      void commitDescriptor(terminal);
    },
    [commitDescriptor],
  );

  const markBackgroundOutput = useCallback((id: string) => {
    setUnreadIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const markBell = useCallback(
    (terminal: TerminalDescriptor) => {
      if (uiSettings.bell === "off") return;
      const background = !active || terminal.id !== activeId || document.hidden;
      if (background)
        setBellIds((current) => new Set(current).add(terminal.id));
      if (background && uiSettings.bell === "desktop")
        void showBrowserNotification(
          `Terminal · ${notificationTerminalLabel(terminal)}`,
          {
            body: "Terminal bell",
            tag: `inspire-terminal-${terminal.id}`,
          },
        );
    },
    [active, activeId, uiSettings.bell],
  );

  const handleCommandComplete = useCallback(
    (
      terminal: TerminalDescriptor,
      message: Extract<
        TerminalServerControlMessage,
        { type: "command_complete" }
      >,
    ) => {
      onCommandComplete?.();
      if (
        !uiSettings.longTaskNotifications ||
        message.durationMs === null ||
        message.durationMs < uiSettings.longTaskThresholdSeconds * 1_000 ||
        (active && terminal.id === activeId && !document.hidden)
      )
        return;
      setBellIds((current) => new Set(current).add(terminal.id));
      const seconds = Math.max(1, Math.round(message.durationMs / 1_000));
      void showBrowserNotification(
        `Terminal finished · ${notificationTerminalLabel(terminal)}`,
        {
          body: `${seconds}s · ${message.exitCode === 0 ? "Succeeded" : `Exit ${message.exitCode ?? "unknown"}`}`,
          tag: `inspire-terminal-command-${terminal.id}`,
        },
      );
    },
    [
      active,
      activeId,
      onCommandComplete,
      uiSettings.longTaskNotifications,
      uiSettings.longTaskThresholdSeconds,
    ],
  );

  const openInWindow = useCallback((terminal: TerminalDescriptor) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    url.searchParams.set("terminal", terminal.id);
    url.searchParams.delete("terminalCwd");
    url.searchParams.set("terminalFocus", "1");
    url.hash = "";
    window.open(
      url,
      `inspire-terminal-${terminal.id}`,
      "popup,width=1080,height=720,noopener,noreferrer",
    );
  }, []);

  const closeTerminal = async (terminal: TerminalDescriptor, force = false) => {
    if (
      terminal.status === "running" &&
      (force || terminal.commandRunning) &&
      !window.confirm(
        force
          ? `Force terminate “${terminalLabel(terminal)}” immediately?`
          : `Close “${terminalLabel(terminal)}” and terminate its running process?`,
      )
    )
      return;
    setError(null);
    await runControl("Terminal could not be closed", async () => {
      const removed = await api.terminalOperation({
        command: "remove",
        params: { id: terminal.id, force },
      });
      if (!catalogController.active) return;
      setRecentlyClosed({ terminal, closedAt: Date.now() });
      const before = catalogController.snapshot()?.terminals ?? [];
      const result = catalogController.remove(terminal.id, removed);
      if (result === "refresh") await load();
      else if (result === "applied") {
        const index = before.findIndex(
          (candidate) => candidate.id === terminal.id,
        );
        setActiveId((current) =>
          current === terminal.id
            ? (before[index + 1]?.id ?? before[index - 1]?.id ?? null)
            : current,
        );
      }
    });
  };

  const restartTerminal = async (terminal: TerminalDescriptor) => {
    if (
      terminal.status === "running" &&
      terminal.commandRunning &&
      !window.confirm(
        `Restart “${terminalLabel(terminal)}” and terminate its running process?`,
      )
    )
      return;
    await runControl("Terminal could not be restarted", async () => {
      await commitDescriptor(
        await api.terminalOperation({
          command: "restart",
          params: { id: terminal.id },
        }),
      );
    });
  };

  const beginRename = (terminal: TerminalDescriptor) => {
    renamePendingRef.current = true;
    setRenameId(terminal.id);
    setRenameValue(terminalLabel(terminal));
  };

  const commitRename = async () => {
    if (!renameId || !renamePendingRef.current) return;
    renamePendingRef.current = false;
    const id = renameId;
    setRenameId(null);
    await runControl("Terminal could not be renamed", async () => {
      const renamed = await api.terminalOperation({
        command: "rename",
        params: { id, title: renameValue.trim() || null },
      });
      await commitDescriptor(renamed);
    });
  };

  const reopenClosed = async () => {
    const closed = recentlyClosed;
    if (!closed) return;
    const targetCwd = closed.terminal.projectCwd;
    setRecentlyClosed(null);
    await runControl("Terminal could not be reopened", async () => {
      const terminal = await api.terminalOperation({
        command: "create",
        params: {
          request: {
            cwd: targetCwd,
            profileId: closed.terminal.profileId,
            cols: closed.terminal.cols,
            rows: closed.terminal.rows,
          },
        },
      });
      await commitDescriptor(terminal, true);
      const restored =
        closed.terminal.titleSource === "user"
          ? await api.terminalOperation({
              command: "rename",
              params: { id: terminal.id, title: closed.terminal.title },
            })
          : terminal;
      if (!catalogController.active) return;
      if (cwd === targetCwd) await commitDescriptor(restored, true);
      else {
        setCwd(targetCwd);
        setActiveId(restored.id);
      }
    });
  };

  const reorderTerminal = (
    fromId: string,
    targetId: string,
    after: boolean,
  ) => {
    if (
      !cwd ||
      fromId === targetId ||
      !terminals.some(({ id }) => id === fromId)
    )
      return;
    const ids = terminals.map(({ id }) => id).filter((id) => id !== fromId);
    const index = ids.indexOf(targetId);
    if (index < 0) return;
    ids.splice(index + (after ? 1 : 0), 0, fromId);
    void runControl("Terminal order could not be saved", async () => {
      catalogController.replace(
        await api.terminalOperation({
          command: "reorder",
          params: { projectCwd: cwd, ids },
        }),
      );
    });
  };

  const moveTerminal = (terminal: TerminalDescriptor, direction: -1 | 1) => {
    const target = terminals[terminals.indexOf(terminal) + direction];
    if (target) reorderTerminal(terminal.id, target.id, direction > 0);
  };

  const switchTerminal = useCallback(
    (action: "next" | "previous" | number) => {
      const current = terminals.findIndex(({ id }) => id === activeId);
      const index =
        typeof action === "number"
          ? action
          : current + (action === "next" ? 1 : -1);
      const target =
        terminals[
          ((index % terminals.length) + terminals.length) % terminals.length
        ];
      if (target) setActiveId(target.id);
    },
    [activeId, terminals],
  );

  const currentView =
    active &&
    activeTerminal &&
    viewActions?.owner === `${activeTerminal.id}:${activeTerminal.outputEpoch}`
      ? viewActions
      : null;
  const dispatchTerminalAction = (action: TerminalActionIntent["action"]) => {
    if (!catalogController.active) return false;
    if (action === "take-control") {
      if (!currentView?.ready || activeTerminal?.status !== "running")
        return false;
      currentView.invoke(action);
      return true;
    }
    if (action === "new") {
      if (!cwd) return false;
      void createTerminal();
      return true;
    }
    if (action === "focus") {
      setFocused((value) => !value);
      return true;
    }
    if (action === "settings") {
      setSettingsOpen(true);
      return true;
    }
    if (!activeTerminal) return false;
    if (action === "close") void closeTerminal(activeTerminal);
    else if (action === "restart") void restartTerminal(activeTerminal);
    else switchTerminal(action);
    return true;
  };
  terminalActionHandlerRef.current = ({ action, projectCwd }) =>
    active &&
    projectCwd === cwd &&
    (Boolean(launchTarget) || sessionCwd === lastSessionCwdRef.current) &&
    dispatchTerminalAction(action);

  useEffect(
    () =>
      subscribeTerminalActions((action) =>
        terminalActionHandlerRef.current(action),
      ),
    [active, activeId, cwd, terminals],
  );

  useEffect(() => {
    if (!active) return;
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        uiSettings.shortcutMode !== "workbench" ||
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        !paneRef.current?.contains(event.target) ||
        !event.target.closest('.terminal-pane, [data-dock-tab^="terminal:"]') ||
        !isTerminalShortcutTarget(event.target)
      )
        return;
      const shortcut = terminalShortcut(event);
      if (shortcut === null) return;
      if (typeof shortcut === "number") {
        if (!terminals.length) return;
        switchTerminal(shortcut);
      } else if (
        !cwd ||
        !terminalActionHandlerRef.current({ action: shortcut, projectCwd: cwd })
      )
        return;
      event.preventDefault();
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [active, cwd, switchTerminal, terminals.length, uiSettings.shortcutMode]);

  const tabs: TerminalDockTab[] = terminals.map((terminal) => ({
    kind: "terminal",
    id: terminal.id,
    status: terminal.status,
    panel: "context-terminal-content",
    label: terminalLabel(terminal),
    title: terminal.currentCwd,
    selected: terminal.id === activeId && (!showingContext || active),
    unread: unreadIds.has(terminal.id),
    bell: bellIds.has(terminal.id),
    rename:
      renameId === terminal.id
        ? {
            value: renameValue,
            change: setRenameValue,
            commit: () => void commitRename(),
            cancel: () => {
              renamePendingRef.current = false;
              setRenameId(null);
            },
          }
        : undefined,
    select: () => {
      setActiveId(terminal.id);
      onActivate?.();
    },
    beginRename: () => beginRename(terminal),
    close: () => void closeTerminal(terminal),
    move: (direction) => moveTerminal(terminal, direction),
    drop: (fromId, after) => reorderTerminal(fromId, terminal.id, after),
  }));

  const terminalMatches = (text: string) =>
    searchMatchRanges(text, [terminalFilter], (value) => value.toLowerCase());
  const allTerminals = globalCatalog?.terminals ?? EMPTY_TERMINALS;
  const projectNameCounts = new Map<string, number>();
  for (const projectCwd of new Set(allTerminals.map((t) => t.projectCwd))) {
    const name = projectLabel(projectCwd);
    projectNameCounts.set(name, (projectNameCounts.get(name) ?? 0) + 1);
  }
  const globalGroups = new Map<string, TerminalDescriptor[]>();
  for (const terminal of allTerminals) {
    if (
      terminalFilter &&
      !`${terminal.title} ${terminal.currentCommand} ${terminal.projectCwd}`
        .toLowerCase()
        .includes(terminalFilter.toLowerCase())
    )
      continue;
    const group = globalGroups.get(terminal.projectCwd) ?? [];
    group.push(terminal);
    globalGroups.set(terminal.projectCwd, group);
  }

  const toolbar = (
    <FloatingPaneActions
      className="terminal-toolbar"
      label="terminal controls"
      owner={activeId ?? cwd}
      onKeyDown={onMenuKeyDown}
    >
      {!showingContext && terminals.length > 0 && (
        <button
          type="button"
          className="icon-button"
          data-terminal-focus-trigger
          onClick={() => void createTerminal()}
          disabled={creating}
          aria-label="New terminal"
          title="New terminal"
        >
          <Plus size={15} aria-hidden />
        </button>
      )}
      {hasProfileChoice ? (
        <details
          ref={profileMenuRef}
          name={menuGroupName}
          className="terminal-menu"
          data-terminal-menu
        >
          <summary
            className="icon-button"
            aria-label="Choose terminal profile"
            title="Choose terminal profile"
            aria-disabled={creating}
            onClick={(event) => {
              if (creating) event.preventDefault();
            }}
          >
            <ChevronDown size={14} aria-hidden />
          </summary>
          <div className="terminal-menu__popover terminal-menu__popover--profiles">
            {availableProfiles.map((profile) => (
              <button
                type="button"
                key={profile.id}
                data-terminal-focus-trigger
                disabled={creating}
                onClick={() => void createTerminal(profile)}
              >
                <span>{profile.label}</span>
                {profile.isDefault ? <small>Default</small> : null}
              </button>
            ))}
          </div>
        </details>
      ) : null}
      {currentView && (
        <>
          <span
            className="terminal-view__status"
            data-transport={currentView.transport}
            role="status"
            aria-label={currentView.statusLabel}
            title={currentView.statusLabel}
          >
            {currentView.transport === "connected" &&
            currentView.writable &&
            !currentView.exited ? (
              <button
                type="button"
                className="icon-button"
                aria-label="Focus terminal input"
                disabled={!currentView.ready}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => currentView.invoke("focus")}
              >
                <Keyboard size={16} aria-hidden />
              </button>
            ) : (
              <TerminalStatusIcon
                transport={currentView.transport}
                exited={currentView.exited}
              />
            )}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Search terminal output"
            aria-expanded={currentView.searchOpen}
            onClick={() => currentView.invoke("search")}
          >
            <Search size={16} aria-hidden />
          </button>
        </>
      )}
      <button
        type="button"
        className="icon-button terminal-toolbar__focus"
        onClick={() => dispatchTerminalAction("focus")}
        aria-label={focused ? "Exit focused terminal" : "Focus terminal"}
        title={focused ? "Exit focus" : "Focus terminal"}
      >
        {focused ? (
          <Minimize2 size={16} aria-hidden />
        ) : (
          <Maximize2 size={16} aria-hidden />
        )}
      </button>
      <details
        className="terminal-menu"
        name={menuGroupName}
        data-terminal-menu
        onToggle={(event) => {
          if (event.target !== event.currentTarget || event.currentTarget.open)
            return;
          for (const group of event.currentTarget.querySelectorAll<HTMLDetailsElement>(
            "details[open]",
          ))
            group.open = false;
        }}
      >
        <summary
          className="icon-button"
          aria-label="Terminal actions"
          title="Terminal actions"
        >
          <MoreHorizontal size={16} aria-hidden />
        </summary>
        <div className="terminal-menu__popover">
          {currentView && (
            <div className="terminal-menu__view" key={currentView.owner}>
              {(
                [
                  [
                    "paste",
                    "Paste",
                    ClipboardPaste,
                    !currentView.writable ||
                      !currentView.ready ||
                      currentView.exited,
                  ],
                  ["copy", "Copy all", Copy, false],
                  ["select", "Select text", TextSelect, false],
                  [
                    "copy-last",
                    "Copy last output",
                    Copy,
                    !currentView.hasLastOutput,
                  ],
                ] as const
              ).map(([action, label, Icon, disabled]) => (
                <button
                  key={action}
                  type="button"
                  disabled={disabled}
                  aria-label={
                    action === "paste" ? "Paste into terminal" : undefined
                  }
                  onClick={(event) =>
                    currentView.invoke(action, event.currentTarget)
                  }
                >
                  <Icon size={14} aria-hidden /> {label}
                </button>
              ))}
              <details className="terminal-menu__group" data-terminal-menu-group>
                <DetailSummary><Monitor size={14} aria-hidden /> Display</DetailSummary>
                <div>
                  {([
                    ["clear", "Clear local scrollback", Eraser],
                    ["reset", "Reset terminal display", RotateCcw],
                  ] as const).map(([action, label, Icon]) => (
                    <button key={action} type="button" onClick={(event) => currentView.invoke(action, event.currentTarget)}>
                      <Icon size={14} aria-hidden /> {label}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          )}
          <button type="button" className="terminal-menu__focus" onClick={() => dispatchTerminalAction("focus")}>
            {focused ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
            {focused ? "Exit focused terminal" : "Focus terminal"}
          </button>
          {activeTerminal ? (
            <>
              <button type="button" onClick={() => beginRename(activeTerminal)}>
                <Pencil size={14} aria-hidden /> Rename
              </button>
              <button
                type="button"
                onClick={() => openInWindow(activeTerminal)}
              >
                <ExternalLink size={14} aria-hidden /> Open in window
              </button>
              <details className="terminal-menu__group" data-terminal-menu-group>
                <DetailSummary><SquareTerminal size={14} aria-hidden /> Manage terminal</DetailSummary>
                <div>
              {([-1, 1] as const).map((step) => {
                const target =
                  terminals[terminals.indexOf(activeTerminal) + step];
                if (!target) return null;
                const Icon = step < 0 ? ArrowLeft : ArrowRight;
                return (
                  <button
                    key={step}
                    type="button"
                    onClick={() => moveTerminal(activeTerminal, step)}
                  >
                    <Icon size={14} aria-hidden />{" "}
                    {step < 0 ? "Move tab left" : "Move tab right"}
                  </button>
                );
              })}
              <button
                type="button"
                data-terminal-focus-trigger
                onClick={() => dispatchTerminalAction("restart")}
              >
                <RotateCcw size={14} aria-hidden /> Restart
              </button>
              <button
                type="button"
                className="terminal-menu__danger"
                onClick={() => dispatchTerminalAction("close")}
              >
                <Trash2 size={14} aria-hidden /> Close
              </button>
              {activeTerminal.status === "running" ? (
                <button
                  type="button"
                  className="terminal-menu__danger"
                  onClick={() => void closeTerminal(activeTerminal, true)}
                >
                  <X size={14} aria-hidden /> Force terminate
                </button>
              ) : null}
                </div>
              </details>
            </>
          ) : null}
          <details
            className="terminal-menu__projects"
            data-terminal-menu-group
            onToggle={(event) => {
              if (
                event.target === event.currentTarget &&
                event.currentTarget.open
              )
                void loadGlobal();
            }}
          >
            <DetailSummary aria-label="Terminals in all projects">
              <FolderKanban size={14} aria-hidden /> All terminals
            </DetailSummary>
            <div>
              <SearchField
                className="terminal-menu__search"
                value={terminalFilter}
                onValueChange={setTerminalFilter}
                placeholder="Find terminal or project"
                aria-label="Find terminal or project"
                iconSize={13}
              />
              {globalLoading && !globalCatalog ? (
                <div className="terminal-menu__message">Loading…</div>
              ) : globalGroups.size === 0 ? (
                <div className="terminal-menu__message">
                  {terminalFilter ? "No matching terminals" : "No terminals"}
                </div>
              ) : (
                [...globalGroups].map(([projectCwd, projectTerminals]) => {
                  const name = projectLabel(projectCwd);
                  const parent = parentSegment(projectCwd);
                  const showParent =
                    parent &&
                    ((projectNameCounts.get(name) ?? 0) > 1 ||
                      (terminalMatches(parent).length > 0 &&
                        terminalMatches(name).length === 0));
                  return (
                    <div className="terminal-menu__project" key={projectCwd}>
                      <div title={projectCwd}>
                        <span className="terminal-menu__project-identity">
                          <span className="terminal-menu__project-name">
                            <SearchMatchText
                              text={name}
                              ranges={terminalMatches(name)}
                            />
                          </span>
                          {showParent ? (
                            <span className="terminal-menu__project-context">
                              @
                              <SearchMatchText
                                text={parent}
                                ranges={terminalMatches(parent)}
                              />
                            </span>
                          ) : null}
                        </span>
                        {projectCwd === cwd ? <small>Current</small> : null}
                      </div>
                      {projectTerminals.map((terminal) => (
                        <button
                          type="button"
                          key={terminal.id}
                          onClick={() => {
                            setActiveId(terminal.id);
                            setCwd(projectCwd);
                          }}
                        >
                          <span
                            className={`terminal-tab__status terminal-tab__status--${terminal.status}`}
                            aria-hidden
                          />
                          <span>
                            <SearchMatchText
                              text={terminalLabel(terminal)}
                              ranges={terminalMatches(terminalLabel(terminal))}
                            />
                          </span>
                          <small>
                            <SearchMatchText
                              text={terminal.currentCommand}
                              ranges={terminalMatches(terminal.currentCommand)}
                            />
                          </small>
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </details>
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget
                .closest("details")
                ?.querySelector("summary")
                ?.focus();
              dispatchTerminalAction("settings");
            }}
          >
            <Settings2 size={14} aria-hidden /> Settings
          </button>
        </div>
      </details>
    </FloatingPaneActions>
  );

  return (
    <section
      ref={paneRef}
      className={`workspace-dock${focused ? " terminal-pane--focused" : ""}`}
      onKeyDown={onMenuKeyDown}
      onClickCapture={(event) => {
        const button = (event.target as Element).closest("button");
        button?.closest(TERMINAL_MENU_SELECTOR)?.removeAttribute("open");
      }}
    >
      <div
        className="pane-toolbar ctx__header"
        ref={recoverModalFocus}
        role="tablist"
        aria-label={showingContext ? "Context tabs" : "Project terminals"}
        onKeyDown={handleDockTabKey}
      >
        <ContextTabStrip
          tabs={showingContext ? [...context.files, ...tabs] : tabs}
          collapseOverflow={Boolean(showingContext)}
        />
        {showingContext ? context.tools : null}
      </div>
      {showingContext ? context.body : null}
      <section
        className="terminal-pane"
        id="context-terminal-content"
        role="tabpanel"
        aria-label="Terminal"
        hidden={Boolean(context && !active)}
      >
        {cwd && sessionCwd && cwd !== sessionCwd ? (
          <div className="pane-toolbar terminal-project-context">
            <span>
              Viewing <strong>{projectLabel(cwd)}</strong>
            </span>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setActiveId(null);
                setCwd(sessionCwd);
              }}
            >
              Back to current project
            </button>
          </div>
        ) : null}
        {cwd && toolbar}

        {!cwd ? (
          <ContextPaneState
            className="terminal-empty"
            icon={<SquareTerminal size={24} aria-hidden />}
            title="No project selected"
            hint="Open a session to use project terminals."
          />
        ) : loading && !catalog ? (
          TERMINAL_LOADING
        ) : terminals.length === 0 ? (
          <ContextPaneState
            className="terminal-empty"
            icon={<SquareTerminal size={28} aria-hidden />}
            title="Project terminal"
            hint="Terminals keep running after you disconnect."
          >
            <button
              type="button"
              className="button button--primary"
              data-terminal-focus-trigger
              onClick={createFromControl}
              disabled={creating}
            >
              <Plus size={14} aria-hidden />
              <ButtonLabel reserve="New terminal">
                {creating ? "Starting…" : "New terminal"}
              </ButtonLabel>
            </button>
          </ContextPaneState>
        ) : (
          terminals
            .filter(
              (terminal) =>
                openedIds.has(terminal.id) ||
                (active && terminal.id === activeId),
            )
            .map((terminal) => (
              <div
                id={`terminal-view-${terminal.id}`}
                key={`${terminal.id}:${terminal.outputEpoch}`}
                className="terminal-views__item"
                role="region"
                aria-label={`${terminalLabel(terminal)} terminal`}
                hidden={terminal.id !== activeId}
              >
                <Suspense fallback={TERMINAL_LOADING}>
                  <TerminalView
                    api={api}
                    terminal={terminal}
                    active={active && terminal.id === activeId}
                    settings={uiSettings}
                    publishActions={setViewActions}
                    onDescriptor={applyDescriptor}
                    onBackgroundOutput={markBackgroundOutput}
                    onBell={markBell}
                    onOpenFile={cwd === sessionCwd ? onOpenFile : undefined}
                    onSendToComposer={
                      cwd === sessionCwd ? onSendToComposer : undefined
                    }
                    onCommandComplete={handleCommandComplete}
                  />
                </Suspense>
              </div>
            ))
        )}

        {active && settingsOpen && (
          <Suspense fallback={null}>
            <TerminalSettingsDialog
              api={api}
              settings={uiSettings}
              onSettingsChange={setUiSettings}
              onClose={() => setSettingsOpen(false)}
            />
          </Suspense>
        )}

        {recentlyClosed && Date.now() - recentlyClosed.closedAt < 30_000 ? (
          <div className="pane-toolbar terminal-undo" role="status">
            <span>Terminal closed</span>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => void reopenClosed()}
            >
              <Undo2 size={13} aria-hidden /> Reopen
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setRecentlyClosed(null)}
              aria-label="Dismiss"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
        ) : null}
        {error ? (
          <NoticeCard
            kind="error"
            text={error}
            className="terminal-pane__error"
            onDismiss={() => setError(null)}
            dismissLabel="Dismiss terminal error"
          />
        ) : null}
      </section>
    </section>
  );
});
