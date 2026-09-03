import {
  ArrowLeft,
  ArrowRight,
  Bell,
  ChevronDown,
  CopyPlus,
  ExternalLink,
  FolderKanban,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SquareTerminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MAX_TERMINAL_TITLE_CHARS,
  type TerminalCatalogResponse,
  type TerminalDescriptor,
  type TerminalProfile,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts";
import { createApi } from "../api";
import {
  hasTerminalInsertion,
  subscribeTerminalActions,
  subscribeTerminalInsertion,
  type TerminalUiAction,
} from "../terminal-actions";
import {
  loadTerminalUiSettings,
  type TerminalUiSettings,
} from "../terminal-settings";
import { TerminalSettingsDialog } from "./TerminalSettingsDialog";
import { TerminalView } from "./TerminalView";

interface TerminalPaneProps {
  cwd: string | null;
  reloadKey?: number;
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

function projectLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || cwd;
}

export const TerminalPane = memo(function TerminalPane({
  cwd: sessionCwd,
  reloadKey = 0,
  onOpenFile,
  onSendToComposer,
  onCommandComplete,
}: TerminalPaneProps) {
  const api = useMemo(() => createApi(), []);
  const launchTarget = useMemo(readTerminalLaunchTarget, []);
  const lastSessionCwdRef = useRef(sessionCwd);
  const [cwd, setCwd] = useState(sessionCwd);
  const [catalog, setCatalog] = useState<TerminalCatalogResponse | null>(null);
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
  const knownOutputOffsetsRef = useRef(new Map<string, number>());
  const autoCreateInsertionRef = useRef<string | null>(null);
  const draggedId = useRef<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const renamePendingRef = useRef(false);
  const terminalActionHandlerRef = useRef<
    (action: TerminalUiAction) => boolean
  >(() => false);

  const terminals = catalog?.terminals ?? EMPTY_TERMINALS;
  const activeTerminal = terminals.find((terminal) => terminal.id === activeId);

  useEffect(() => {
    if (launchTarget || lastSessionCwdRef.current === sessionCwd) return;
    lastSessionCwdRef.current = sessionCwd;
    setCatalog(null);
    setActiveId(null);
    setCwd(sessionCwd);
  }, [launchTarget, sessionCwd]);

  useEffect(() => {
    if (!launchTarget) return;
    let cancelled = false;
    void api
      .terminals()
      .then((next) => {
        if (cancelled) return;
        const target = next.terminals.find(
          (terminal) => terminal.id === launchTarget.id,
        );
        if (!target) throw new Error("The requested terminal no longer exists");
        setCatalog(null);
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

  const load = useCallback(async () => {
    if (!cwd) {
      setCatalog(null);
      setActiveId(null);
      return;
    }
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.terminals(cwd);
      if (generation !== requestGeneration.current) return;
      setCatalog(next);
      setActiveId((current) => {
        const preferred = current ?? storedActiveTerminal(cwd);
        return next.terminals.some((terminal) => terminal.id === preferred)
          ? preferred
          : (next.terminals[0]?.id ?? null);
      });
    } catch (loadError) {
      if (generation !== requestGeneration.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Terminals failed to load",
      );
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [api, cwd]);

  const loadGlobal = useCallback(async () => {
    if (globalLoading) return;
    setGlobalLoading(true);
    try {
      setGlobalCatalog(await api.terminals());
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
    void load();
    return () => {
      requestGeneration.current += 1;
    };
  }, [load, reloadKey]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api.terminals(cwd);
        if (!cancelled)
          setCatalog((current) =>
            !current ||
            next.catalogEpoch !== current.catalogEpoch ||
            next.revision > current.revision
              ? next
              : current,
          );
      } catch {
        // The attached terminal sockets expose transport failures directly;
        // catalog polling remains a quiet status refresh.
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, cwd]);

  useEffect(
    () =>
      subscribeTerminalInsertion(() => {
        if (!sessionCwd || !hasTerminalInsertion(sessionCwd)) return;
        if (cwd !== sessionCwd) {
          setCatalog(null);
          setActiveId(null);
          setCwd(sessionCwd);
        }
        setInsertionRevision((revision) => revision + 1);
      }),
    [cwd, sessionCwd],
  );

  useEffect(() => {
    if (!cwd) return;
    storeActiveTerminal(cwd, activeId);
    if (!activeId) return;
    setOpenedIds((current) => {
      if (current.has(activeId)) return current;
      const next = new Set(current);
      next.add(activeId);
      return next;
    });
    setUnreadIds((current) => {
      if (!current.has(activeId)) return current;
      const next = new Set(current);
      next.delete(activeId);
      return next;
    });
    setBellIds((current) => {
      if (!current.has(activeId)) return current;
      const next = new Set(current);
      next.delete(activeId);
      return next;
    });
  }, [activeId, cwd]);

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
          terminal.id !== activeId
        );
      })
      .map((terminal) => terminal.id);
    for (const id of [...knownOffsets.keys()]) {
      if (!nextIds.has(id)) knownOffsets.delete(id);
    }
    if (newlyUnread.length > 0)
      setUnreadIds((current) => new Set([...current, ...newlyUnread]));
  }, [activeId, terminals]);

  useEffect(() => {
    const ids = new Set(terminals.map((terminal) => terminal.id));
    setOpenedIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      if (activeId && ids.has(activeId)) next.add(activeId);
      return next;
    });
    setUnreadIds(
      (current) => new Set([...current].filter((id) => ids.has(id))),
    );
    setBellIds((current) => new Set([...current].filter((id) => ids.has(id))));
    if (catalog && activeId && !ids.has(activeId))
      setActiveId(terminals[0]?.id ?? null);
  }, [activeId, catalog, terminals]);

  useEffect(() => {
    const dismissMenus = (event: PointerEvent) => {
      for (const menu of paneRef.current?.querySelectorAll<HTMLDetailsElement>(
        "details[open]",
      ) ?? []) {
        if (!menu.contains(event.target as Node)) menu.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", dismissMenus, true);
    return () =>
      document.removeEventListener("pointerdown", dismissMenus, true);
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

  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        (!event.ctrlKey && !event.metaKey) ||
        !event.shiftKey ||
        event.defaultPrevented
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setFocused(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focused]);

  const createTerminal = useCallback(
    async (profile?: TerminalProfile) => {
      if (!cwd || creating) return;
      setCreating(true);
      setError(null);
      try {
        const terminal = await api.createTerminal({
          cwd,
          ...(profile ? { profileId: profile.id } : {}),
        });
        setCatalog((current) =>
          current
            ? {
                ...current,
                revision:
                  current.catalogEpoch === terminal.catalogEpoch
                    ? Math.max(current.revision, terminal.catalogRevision)
                    : current.revision,
                terminals: [...current.terminals, terminal],
              }
            : {
                catalogEpoch: terminal.catalogEpoch,
                revision: terminal.catalogRevision,
                profiles: [],
                terminals: [terminal],
              },
        );
        setActiveId(terminal.id);
      } catch (createError) {
        setError(
          createError instanceof Error
            ? createError.message
            : "Terminal could not be created",
        );
      } finally {
        setCreating(false);
      }
    },
    [api, creating, cwd],
  );

  useEffect(() => {
    if (!cwd || !catalog || loading || creating || !hasTerminalInsertion(cwd))
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
    activeId,
    catalog,
    createTerminal,
    creating,
    cwd,
    insertionRevision,
    loading,
    terminals,
  ]);

  const applyDescriptor = useCallback((terminal: TerminalDescriptor) => {
    setCatalog((current) =>
      current
        ? {
            ...current,
            revision:
              current.catalogEpoch === terminal.catalogEpoch
                ? Math.max(current.revision, terminal.catalogRevision)
                : current.revision,
            terminals: current.terminals.map((candidate) =>
              candidate.id === terminal.id ? terminal : candidate,
            ),
          }
        : current,
    );
  }, []);

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
      const background = terminal.id !== activeId || document.hidden;
      if (background)
        setBellIds((current) => new Set(current).add(terminal.id));
      if (
        background &&
        uiSettings.bell === "desktop" &&
        "Notification" in window &&
        Notification.permission === "granted"
      )
        new Notification(`Terminal · ${notificationTerminalLabel(terminal)}`, {
          body: "Terminal bell",
          tag: `inspire-terminal-${terminal.id}`,
        });
    },
    [activeId, uiSettings.bell],
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
        (terminal.id === activeId && !document.hidden) ||
        !("Notification" in window) ||
        Notification.permission !== "granted"
      )
        return;
      const seconds = Math.max(1, Math.round(message.durationMs / 1_000));
      new Notification(
        `Terminal finished · ${notificationTerminalLabel(terminal)}`,
        {
          body: `${seconds}s · ${message.exitCode === 0 ? "Succeeded" : `Exit ${message.exitCode ?? "unknown"}`}`,
          tag: `inspire-terminal-command-${terminal.id}`,
        },
      );
    },
    [
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
    try {
      const removed = await api.removeTerminal(terminal.id, force);
      setRecentlyClosed({ terminal, closedAt: Date.now() });
      setCatalog((current) =>
        current
          ? {
              ...current,
              revision:
                current.catalogEpoch === removed.catalogEpoch
                  ? Math.max(current.revision, removed.revision)
                  : current.revision,
              terminals: current.terminals.filter(
                (candidate) => candidate.id !== terminal.id,
              ),
            }
          : current,
      );
      if (activeId === terminal.id) {
        const index = terminals.findIndex(
          (candidate) => candidate.id === terminal.id,
        );
        setActiveId(
          terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? null,
        );
      }
    } catch (closeError) {
      setError(
        closeError instanceof Error
          ? closeError.message
          : "Terminal could not be closed",
      );
    }
  };

  const duplicateTerminal = async (source: TerminalDescriptor) => {
    try {
      const created = await api.createTerminal({
        cwd: source.projectCwd,
        profileId: source.profileId,
        cols: source.cols,
        rows: source.rows,
      });
      const duplicate =
        source.titleSource === "user"
          ? await api.renameTerminal(created.id, {
              title: `${source.title.slice(0, MAX_TERMINAL_TITLE_CHARS - 5)} copy`,
            })
          : created;
      setCatalog((current) =>
        current
          ? {
              ...current,
              revision:
                current.catalogEpoch === duplicate.catalogEpoch
                  ? Math.max(current.revision, duplicate.catalogRevision)
                  : current.revision,
              terminals: [...current.terminals, duplicate],
            }
          : current,
      );
      setActiveId(duplicate.id);
    } catch (duplicateError) {
      setError(
        duplicateError instanceof Error
          ? duplicateError.message
          : "Terminal could not be duplicated",
      );
    }
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
    try {
      const restarted = await api.restartTerminal(terminal.id);
      applyDescriptor(restarted);
      setOpenedIds((current) => {
        const next = new Set(current);
        next.delete(terminal.id);
        return next;
      });
      requestAnimationFrame(() => {
        setOpenedIds((current) => new Set(current).add(terminal.id));
      });
    } catch (restartError) {
      setError(
        restartError instanceof Error
          ? restartError.message
          : "Terminal could not be restarted",
      );
    }
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
    try {
      const renamed = await api.renameTerminal(id, {
        title: renameValue.trim() || null,
      });
      applyDescriptor(renamed);
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : "Terminal could not be renamed",
      );
    }
  };

  const reopenClosed = async () => {
    const closed = recentlyClosed;
    if (!closed) return;
    const targetCwd = closed.terminal.projectCwd;
    setRecentlyClosed(null);
    try {
      const terminal = await api.createTerminal({
        cwd: targetCwd,
        profileId: closed.terminal.profileId,
        cols: closed.terminal.cols,
        rows: closed.terminal.rows,
      });
      const restored =
        closed.terminal.titleSource === "user"
          ? await api.renameTerminal(terminal.id, {
              title: closed.terminal.title,
            })
          : terminal;
      if (cwd === targetCwd)
        setCatalog((current) =>
          current
            ? {
                ...current,
                revision:
                  current.catalogEpoch === restored.catalogEpoch
                    ? Math.max(current.revision, restored.catalogRevision)
                    : current.revision,
                terminals: [...current.terminals, restored],
              }
            : current,
        );
      else {
        setCatalog(null);
        setCwd(targetCwd);
      }
      setActiveId(restored.id);
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : "Terminal could not be reopened",
      );
    }
  };

  const reorder = async (
    fromId: string,
    targetId: string,
    position: "before" | "after" = "before",
  ) => {
    if (!cwd || fromId === targetId) return;
    const previous = terminals;
    const next = [...terminals];
    const fromIndex = next.findIndex((terminal) => terminal.id === fromId);
    if (fromIndex < 0 || !next.some((terminal) => terminal.id === targetId))
      return;
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    const targetIndex = next.findIndex((terminal) => terminal.id === targetId);
    next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, moved);
    setCatalog((current) =>
      current ? { ...current, terminals: next } : current,
    );
    try {
      setCatalog(
        await api.reorderTerminals({
          cwd,
          terminalIds: next.map((terminal) => terminal.id),
        }),
      );
    } catch (reorderError) {
      setCatalog((current) =>
        current ? { ...current, terminals: previous } : current,
      );
      setError(
        reorderError instanceof Error
          ? reorderError.message
          : "Terminal order could not be saved",
      );
    }
  };

  const handleTabKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const current = terminals[index];
    const reorderShortcut = event.shiftKey && (event.ctrlKey || event.metaKey);
    if (reorderShortcut) {
      const target = terminals[index + direction];
      if (current && target)
        void reorder(current.id, target.id, direction > 0 ? "after" : "before");
      return;
    }
    const next =
      terminals[(index + direction + terminals.length) % terminals.length];
    if (!next) return;
    setActiveId(next.id);
    document.getElementById(`terminal-tab-${next.id}`)?.focus();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault();
    const fromId = draggedId.current;
    draggedId.current = null;
    if (!fromId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position =
      event.clientX > bounds.left + bounds.width / 2 ? "after" : "before";
    void reorder(fromId, targetId, position);
  };

  terminalActionHandlerRef.current = (action) => {
    if (action === "take-control")
      return activeTerminal ? activeTerminal.status !== "running" : false;
    if (action === "new") {
      if (!cwd) return false;
      void createTerminal();
      return true;
    }
    if (action === "focus") {
      setFocused(true);
      return true;
    }
    if (action === "settings") {
      setSettingsOpen(true);
      return true;
    }
    if (!activeTerminal) return false;
    if (action === "close") void closeTerminal(activeTerminal);
    else if (action === "restart") void restartTerminal(activeTerminal);
    else {
      const index = terminals.indexOf(activeTerminal);
      const offset = action === "next" ? 1 : -1;
      const next =
        terminals[(index + offset + terminals.length) % terminals.length];
      if (next) setActiveId(next.id);
    }
    return true;
  };

  useEffect(
    () =>
      subscribeTerminalActions((action) =>
        terminalActionHandlerRef.current(action),
      ),
    [activeId, cwd, terminals],
  );

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        uiSettings.shortcutMode !== "workbench" ||
        !paneRef.current?.contains(event.target as Node)
      )
        return;
      const modifier = event.ctrlKey || event.metaKey;
      let nextIndex: number | null = null;
      if (modifier && event.key === "PageDown")
        nextIndex = Math.max(0, terminals.indexOf(activeTerminal!) + 1);
      else if (modifier && event.key === "PageUp")
        nextIndex = terminals.indexOf(activeTerminal!) - 1;
      else if (event.altKey && /^Digit[1-9]$/u.test(event.code))
        nextIndex = Number(event.code.at(-1)) - 1;
      else if (modifier && event.shiftKey && event.key === "`") {
        event.preventDefault();
        void createTerminal();
        return;
      }
      if (nextIndex === null || terminals.length === 0) return;
      event.preventDefault();
      const terminal =
        terminals[(nextIndex + terminals.length) % terminals.length];
      if (terminal) setActiveId(terminal.id);
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [activeTerminal, createTerminal, terminals, uiSettings.shortcutMode]);

  if (!cwd) {
    return (
      <div className="terminal-empty">
        <SquareTerminal size={24} aria-hidden />
        <strong>No project selected</strong>
        <span>Open a Pi session to attach project terminals.</span>
      </div>
    );
  }

  const globalGroups = new Map<string, TerminalDescriptor[]>();
  for (const terminal of globalCatalog?.terminals ?? []) {
    const group = globalGroups.get(terminal.projectCwd) ?? [];
    group.push(terminal);
    globalGroups.set(terminal.projectCwd, group);
  }

  const filteredTerminals = terminalFilter
    ? terminals.filter((terminal) =>
        `${terminal.title} ${terminal.currentCommand}`
          .toLowerCase()
          .includes(terminalFilter.toLowerCase()),
      )
    : terminals;

  return (
    <div
      ref={paneRef}
      className={`terminal-pane${focused ? " terminal-pane--focused" : ""}`}
    >
      {sessionCwd && cwd !== sessionCwd ? (
        <div className="terminal-project-context">
          <span>
            Viewing <strong>{projectLabel(cwd)}</strong>
          </span>
          <button
            type="button"
            onClick={() => {
              setCatalog(null);
              setActiveId(null);
              setCwd(sessionCwd);
            }}
          >
            Back to current project
          </button>
        </div>
      ) : null}
      <div className="terminal-tabs-shell">
        <div
          className="terminal-tabs"
          role="toolbar"
          aria-label="Project terminals"
        >
          {terminals.map((terminal, index) => (
            <div
              key={terminal.id}
              className={`terminal-tab${terminal.id === activeId ? " terminal-tab--active" : ""}`}
              role="presentation"
              draggable
              onDragStart={() => {
                draggedId.current = terminal.id;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, terminal.id)}
            >
              {renameId === terminal.id ? (
                <input
                  className="terminal-tab__rename"
                  value={renameValue}
                  autoFocus
                  maxLength={120}
                  aria-label="Terminal name"
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") void commitRename();
                    else if (event.key === "Escape") {
                      renamePendingRef.current = false;
                      setRenameId(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  id={`terminal-tab-${terminal.id}`}
                  className="terminal-tab__select"
                  aria-pressed={terminal.id === activeId}
                  aria-label={`${terminalLabel(terminal)}${unreadIds.has(terminal.id) ? ", new output" : ""}${bellIds.has(terminal.id) ? ", bell" : ""}`}
                  aria-controls={`terminal-view-${terminal.id}`}
                  aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight Meta+Shift+ArrowLeft Meta+Shift+ArrowRight"
                  tabIndex={terminal.id === activeId ? 0 : -1}
                  onClick={() => setActiveId(terminal.id)}
                  onDoubleClick={() => beginRename(terminal)}
                  onKeyDown={(event) => handleTabKey(event, index)}
                  title={`${terminalLabel(terminal)} — ${terminal.currentCwd}`}
                >
                  <span
                    className={`terminal-tab__status terminal-tab__status--${terminal.status}`}
                    aria-hidden
                  />
                  <span className="terminal-tab__label">
                    {terminalLabel(terminal)}
                  </span>
                  {bellIds.has(terminal.id) ? (
                    <Bell
                      className="terminal-tab__bell"
                      size={10}
                      aria-hidden
                    />
                  ) : null}
                  {unreadIds.has(terminal.id) ? (
                    <span className="terminal-tab__unread" aria-hidden />
                  ) : null}
                </button>
              )}
              <button
                type="button"
                className="terminal-tab__close"
                onClick={() => void closeTerminal(terminal)}
                aria-label={`Close ${terminalLabel(terminal)}`}
                title="Close terminal"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-tabs__new">
          <button
            type="button"
            className="icon-button"
            onClick={() => void createTerminal()}
            disabled={creating}
            aria-label="New terminal"
            title="New terminal"
          >
            <Plus size={15} aria-hidden />
          </button>
          {(catalog?.profiles.length ?? 0) > 1 ? (
            <details className="terminal-menu">
              <summary
                className="terminal-tabs__profile"
                aria-label="Choose terminal profile"
                title="Choose terminal profile"
              >
                <ChevronDown size={12} aria-hidden />
              </summary>
              <div className="terminal-menu__popover terminal-menu__popover--profiles">
                {catalog?.profiles
                  .filter((profile) => profile.available)
                  .map((profile) => (
                    <button
                      type="button"
                      key={profile.id}
                      onClick={(event) => {
                        void createTerminal(profile);
                        event.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                      }}
                    >
                      <span>{profile.label}</span>
                      {profile.isDefault ? <small>Default</small> : null}
                    </button>
                  ))}
              </div>
            </details>
          ) : null}
        </div>
        <details className="terminal-menu terminal-menu--more">
          <summary
            className="icon-button"
            aria-label="Terminal actions"
            title="Terminal actions"
          >
            <MoreHorizontal size={15} aria-hidden />
          </summary>
          <div
            className="terminal-menu__popover"
            onClick={(event) => {
              if ((event.target as Element).closest("button"))
                event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            {terminals.length > 5 ? (
              <label className="terminal-menu__search">
                <Search size={13} aria-hidden />
                <input
                  value={terminalFilter}
                  onChange={(event) => setTerminalFilter(event.target.value)}
                  placeholder="Find terminal"
                  aria-label="Find terminal"
                />
              </label>
            ) : null}
            {terminals.length > 5 ? (
              <div className="terminal-menu__terminal-list">
                {filteredTerminals.map((terminal) => (
                  <button
                    type="button"
                    key={terminal.id}
                    onClick={(event) => {
                      setActiveId(terminal.id);
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                    }}
                  >
                    <span>{terminalLabel(terminal)}</span>
                    <small>{terminal.currentCommand}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {activeTerminal ? (
              <>
                <button
                  type="button"
                  onClick={() => beginRename(activeTerminal)}
                >
                  <Pencil size={13} aria-hidden /> Rename
                </button>
                <button
                  type="button"
                  onClick={() => void duplicateTerminal(activeTerminal)}
                >
                  <CopyPlus size={13} aria-hidden /> Duplicate
                </button>
                {terminals.indexOf(activeTerminal) > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      const target =
                        terminals[terminals.indexOf(activeTerminal) - 1];
                      if (target)
                        void reorder(activeTerminal.id, target.id, "before");
                    }}
                  >
                    <ArrowLeft size={13} aria-hidden /> Move tab left
                  </button>
                ) : null}
                {terminals.indexOf(activeTerminal) < terminals.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => {
                      const target =
                        terminals[terminals.indexOf(activeTerminal) + 1];
                      if (target)
                        void reorder(activeTerminal.id, target.id, "after");
                    }}
                  >
                    <ArrowRight size={13} aria-hidden /> Move tab right
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void restartTerminal(activeTerminal)}
                >
                  <RotateCcw size={13} aria-hidden /> Restart
                </button>
                <button
                  type="button"
                  onClick={() => openInWindow(activeTerminal)}
                >
                  <ExternalLink size={13} aria-hidden /> Open in window
                </button>
                <button
                  type="button"
                  className="terminal-menu__danger"
                  onClick={() => void closeTerminal(activeTerminal)}
                >
                  <Trash2 size={13} aria-hidden /> Close
                </button>
                {activeTerminal.status === "running" ? (
                  <button
                    type="button"
                    className="terminal-menu__danger"
                    onClick={() => void closeTerminal(activeTerminal, true)}
                  >
                    <X size={13} aria-hidden /> Force terminate
                  </button>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              className="terminal-menu__settings"
              onClick={(event) => {
                setSettingsOpen(true);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              <Settings2 size={13} aria-hidden /> Settings
            </button>
          </div>
        </details>
        <details
          className="terminal-menu terminal-menu--projects"
          onToggle={(event) => {
            if (event.currentTarget.open) void loadGlobal();
          }}
        >
          <summary
            className="icon-button"
            aria-label="Terminals in all projects"
            title="All project terminals"
          >
            <FolderKanban size={14} aria-hidden />
          </summary>
          <div className="terminal-menu__popover terminal-menu__popover--global">
            <div className="terminal-menu__heading">All project terminals</div>
            {globalLoading && !globalCatalog ? (
              <div className="terminal-menu__message">Loading…</div>
            ) : globalGroups.size === 0 ? (
              <div className="terminal-menu__message">No terminals</div>
            ) : (
              [...globalGroups].map(([projectCwd, projectTerminals]) => (
                <div className="terminal-menu__project" key={projectCwd}>
                  <div title={projectCwd}>
                    {projectLabel(projectCwd)}
                    {projectCwd === cwd ? <small>Current</small> : null}
                  </div>
                  {projectTerminals.map((terminal) => (
                    <button
                      type="button"
                      key={terminal.id}
                      onClick={(event) => {
                        setCatalog(null);
                        setActiveId(terminal.id);
                        setCwd(projectCwd);
                        event.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                      }}
                    >
                      <span
                        className={`terminal-tab__status terminal-tab__status--${terminal.status}`}
                        aria-hidden
                      />
                      <span>{terminalLabel(terminal)}</span>
                      <small>{terminal.currentCommand}</small>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </details>
        <button
          type="button"
          className="icon-button terminal-tabs__focus"
          onClick={() => setFocused((value) => !value)}
          aria-label={focused ? "Exit focused terminal" : "Focus terminal"}
          title={focused ? "Exit focus (Ctrl+Shift+Esc)" : "Focus terminal"}
        >
          {focused ? (
            <Minimize2 size={14} aria-hidden />
          ) : (
            <Maximize2 size={14} aria-hidden />
          )}
        </button>
      </div>

      {loading && !catalog ? (
        <div className="terminal-empty terminal-empty--loading">
          Loading terminals…
        </div>
      ) : terminals.length === 0 ? (
        <div className="terminal-empty">
          <SquareTerminal size={28} aria-hidden />
          <strong>Project terminal</strong>
          <span>Shells stay alive when this panel or browser disconnects.</span>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void createTerminal()}
            disabled={creating}
          >
            <Plus size={14} aria-hidden />
            {creating ? "Starting…" : "New terminal"}
          </button>
        </div>
      ) : (
        <div className="terminal-views">
          {terminals
            .filter((terminal) => openedIds.has(terminal.id))
            .map((terminal) => (
              <div
                id={`terminal-view-${terminal.id}`}
                key={terminal.id}
                className="terminal-views__item"
                role="region"
                aria-label={`${terminalLabel(terminal)} terminal`}
                hidden={terminal.id !== activeId}
              >
                <TerminalView
                  api={api}
                  terminal={terminal}
                  active={terminal.id === activeId}
                  settings={uiSettings}
                  onDescriptor={applyDescriptor}
                  onBackgroundOutput={markBackgroundOutput}
                  onBell={markBell}
                  onOpenFile={cwd === sessionCwd ? onOpenFile : undefined}
                  onSendToComposer={
                    cwd === sessionCwd ? onSendToComposer : undefined
                  }
                  onCommandComplete={handleCommandComplete}
                />
              </div>
            ))}
        </div>
      )}

      {settingsOpen ? (
        <TerminalSettingsDialog
          api={api}
          settings={uiSettings}
          onSettingsChange={setUiSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {recentlyClosed && Date.now() - recentlyClosed.closedAt < 30_000 ? (
        <div className="terminal-undo" role="status">
          <span>Terminal closed</span>
          <button type="button" onClick={() => void reopenClosed()}>
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
        <button
          type="button"
          className="terminal-pane__error"
          onClick={() => setError(null)}
          title="Dismiss"
        >
          {error}
        </button>
      ) : null}
    </div>
  );
});
