import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IMarker, type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  History as CommandHistory,
  Copy,
  Keyboard,
  MessageSquareQuote,
  Search,
  X,
} from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  INSPIRE_SHELL_OSC,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_COMMAND_CHARS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type TerminalDescriptor,
  type TerminalServerControlMessage,
  type TerminalServerDataFrame,
} from "../../shared/terminal-contracts";
import type { Api } from "../api";
import {
  hasTerminalInsertion,
  subscribeTerminalActions,
  subscribeTerminalInsertion,
  takeTerminalInsertion,
} from "../terminal-actions";
import {
  TerminalConnection,
  type TerminalTransportStatus,
} from "../terminal-connection";
import { terminalFileLinks } from "../terminal-links";
import type { TerminalUiSettings } from "../terminal-settings";

interface TerminalViewProps {
  api: Api;
  terminal: TerminalDescriptor;
  active: boolean;
  settings: TerminalUiSettings;
  onDescriptor(terminal: TerminalDescriptor): void;
  onBackgroundOutput(id: string): void;
  onBell(terminal: TerminalDescriptor): void;
  onOpenFile?(reference: string): void;
  onSendToComposer?(text: string): void;
  onCommandComplete?(
    terminal: TerminalDescriptor,
    message: Extract<
      TerminalServerControlMessage,
      { type: "command_complete" }
    >,
  ): void;
}

interface TerminalCommandBoundary {
  command: string;
  start: IMarker;
  end: IMarker | null;
  exitCode: number | null;
}

interface SearchState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  resultIndex: number;
  resultCount: number;
}

const initialSearch: SearchState = {
  open: false,
  query: "",
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  resultIndex: -1,
  resultCount: 0,
};

function terminalFileReference(reference: string, currentCwd: string): string {
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/u.test(reference)) return reference;
  const separator = currentCwd.includes("\\") ? "\\" : "/";
  return `${currentCwd.replace(/[\\/]+$/u, "")}${separator}${reference}`;
}

function cssColor(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

function terminalTheme(): ITheme {
  return {
    background: cssColor("--terminal-bg", "#0a0c0f"),
    foreground: cssColor("--terminal-fg", "#cad0d8"),
    cursor: cssColor("--terminal-cursor", "#ff781f"),
    cursorAccent: cssColor("--terminal-bg", "#0a0c0f"),
    selectionBackground: cssColor("--terminal-selection", "#5b331f"),
    black: cssColor("--terminal-black", "#20252b"),
    red: cssColor("--terminal-red", "#f06a65"),
    green: cssColor("--terminal-green", "#4eba88"),
    yellow: cssColor("--terminal-yellow", "#e4b65a"),
    blue: cssColor("--terminal-blue", "#65a8df"),
    magenta: cssColor("--terminal-magenta", "#a290f5"),
    cyan: cssColor("--terminal-cyan", "#5bbdc1"),
    white: cssColor("--terminal-white", "#cad0d8"),
    brightBlack: cssColor("--terminal-bright-black", "#737d8a"),
    brightRed: cssColor("--terminal-bright-red", "#ff8782"),
    brightGreen: cssColor("--terminal-bright-green", "#69d7a3"),
    brightYellow: cssColor("--terminal-bright-yellow", "#ffd27a"),
    brightBlue: cssColor("--terminal-bright-blue", "#83c3f4"),
    brightMagenta: cssColor("--terminal-bright-magenta", "#c0b2ff"),
    brightCyan: cssColor("--terminal-bright-cyan", "#76d9dc"),
    brightWhite: cssColor("--terminal-bright-white", "#f4f6f8"),
  };
}

function terminalFontFamily(): string {
  return cssColor("--font-mono", '"Flux Mono SC", ui-monospace, monospace');
}

function safeDimensions(
  dimensions: { cols: number; rows: number } | undefined,
  fallback: TerminalDescriptor,
): { cols: number; rows: number } {
  return {
    cols: Math.max(
      MIN_TERMINAL_COLS,
      Math.min(MAX_TERMINAL_COLS, dimensions?.cols ?? fallback.cols),
    ),
    rows: Math.max(
      MIN_TERMINAL_ROWS,
      Math.min(MAX_TERMINAL_ROWS, dimensions?.rows ?? fallback.rows),
    ),
  };
}

function shellMarkerCommand(phase: string, payload: string): string {
  let command = payload;
  if (phase === "C1") {
    try {
      command = decodeURIComponent(payload);
    } catch {
      return "";
    }
  }
  if (
    command.length < 1 ||
    command.length > MAX_TERMINAL_COMMAND_CHARS ||
    /[\u0000\u0007\u001b]/u.test(command) ||
    !/\S/u.test(command)
  )
    return "";
  return command;
}

function hasUnsafePasteControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isRiskyPaste(value: string): boolean {
  return /[\r\n]/u.test(value) || hasUnsafePasteControl(value);
}

async function clipboardText(): Promise<string> {
  if (!navigator.clipboard?.readText)
    throw new Error("Clipboard access is unavailable in this browser");
  return navigator.clipboard.readText();
}

export const TerminalView = memo(function TerminalView({
  api,
  terminal: descriptor,
  active,
  settings,
  onDescriptor,
  onBackgroundOutput,
  onBell,
  onOpenFile,
  onSendToComposer,
  onCommandComplete,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const descriptorRef = useRef(descriptor);
  const activeRef = useRef(active);
  const writableRef = useRef(false);
  const settingsRef = useRef(settings);
  const onBellRef = useRef(onBell);
  const onOpenFileRef = useRef(onOpenFile);
  const onSendToComposerRef = useRef(onSendToComposer);
  const onCommandCompleteRef = useRef(onCommandComplete);
  const ctrlLatchedRef = useRef(false);
  const altLatchedRef = useRef(false);
  const replayModeRef = useRef<"delta" | "snapshot">("snapshot");
  const replayGenerationRef = useRef(0);
  const snapshotStartedRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const bellTimerRef = useRef<number | null>(null);
  const commandMarkersRef = useRef<TerminalCommandBoundary[]>([]);
  const [transport, setTransport] =
    useState<TerminalTransportStatus>("connecting");
  const [writable, setWritable] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>(initialSearch);
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [bellFlash, setBellFlash] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [outputBelow, setOutputBelow] = useState(false);
  const [commandRevision, setCommandRevision] = useState(0);

  descriptorRef.current = descriptor;
  activeRef.current = active;
  writableRef.current = writable;
  settingsRef.current = settings;
  onBellRef.current = onBell;
  onOpenFileRef.current = onOpenFile;
  onSendToComposerRef.current = onSendToComposer;
  onCommandCompleteRef.current = onCommandComplete;
  ctrlLatchedRef.current = ctrlLatched;
  altLatchedRef.current = altLatched;

  const currentDimensions = useCallback(() => {
    const proposed = fitRef.current?.proposeDimensions();
    return safeDimensions(proposed, descriptorRef.current);
  }, []);

  const fitAndResize = useCallback(() => {
    if (!activeRef.current || !writableRef.current) return;
    const dimensions = currentDimensions();
    const xterm = xtermRef.current;
    if (!xterm) return;
    if (xterm.cols !== dimensions.cols || xterm.rows !== dimensions.rows)
      xterm.resize(dimensions.cols, dimensions.rows);
    connectionRef.current?.resize(dimensions.cols, dimensions.rows);
  }, [currentDimensions]);

  const applyDescriptor = useCallback(
    (next: TerminalDescriptor) => {
      descriptorRef.current = next;
      onDescriptor(next);
    },
    [onDescriptor],
  );

  const handleControl = useCallback(
    (message: TerminalServerControlMessage) => {
      const xterm = xtermRef.current;
      if (message.type === "attached") {
        replayModeRef.current = message.replay;
        replayGenerationRef.current += 1;
        snapshotStartedRef.current = false;
        writableRef.current = message.writable;
        setWritable(message.writable);
        setReady(false);
        setError(null);
        applyDescriptor(message.terminal);
        if (
          xterm &&
          (xterm.cols !== message.terminal.cols ||
            xterm.rows !== message.terminal.rows)
        )
          xterm.resize(message.terminal.cols, message.terminal.rows);
      } else if (message.type === "replay_complete") {
        const replayGeneration = replayGenerationRef.current;
        const completeReplay = () => {
          if (replayGeneration !== replayGenerationRef.current) return;
          setReady(true);
          if (activeRef.current && writableRef.current)
            requestAnimationFrame(fitAndResize);
        };
        // The protocol replay edge can arrive before xterm has drained its
        // asynchronous write queue. Use an empty write as a parser barrier so
        // input and protected code insertion see the restored terminal modes.
        if (xterm) xterm.write("", completeReplay);
        else completeReplay();
      } else if (message.type === "ownership") {
        writableRef.current = message.writable;
        setWritable(message.writable);
        if (message.writable && activeRef.current)
          requestAnimationFrame(fitAndResize);
      } else if (message.type === "resized") {
        if (
          xterm &&
          (xterm.cols !== message.cols || xterm.rows !== message.rows)
        )
          xterm.resize(message.cols, message.rows);
      } else if (message.type === "descriptor") {
        applyDescriptor(message.terminal);
      } else if (message.type === "command_complete") {
        onCommandCompleteRef.current?.(descriptorRef.current, message);
      } else if (message.type === "exit") {
        writableRef.current = false;
        setWritable(false);
        applyDescriptor(message.terminal);
      } else if (message.type === "error") {
        setError(message.message);
      }
    },
    [applyDescriptor, fitAndResize],
  );

  const handleData = useCallback(
    (frame: TerminalServerDataFrame) => {
      const xterm = xtermRef.current;
      if (!xterm) return;
      if (frame.kind === "snapshot" && !snapshotStartedRef.current) {
        for (const boundary of commandMarkersRef.current) {
          boundary.start.dispose();
          boundary.end?.dispose();
        }
        commandMarkersRef.current = [];
        setCommandRevision((revision) => revision + 1);
        xterm.reset();
        snapshotStartedRef.current = true;
      }
      xterm.write(frame.data, () => {
        setOutputBelow(
          xterm.buffer.active.viewportY < xterm.buffer.active.baseY,
        );
      });
      if (frame.kind === "output" && !activeRef.current)
        onBackgroundOutput(descriptorRef.current.id);
    },
    [onBackgroundOutput],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xterm = new Terminal({
      allowProposedApi: true,
      cursorBlink: settingsRef.current.cursorBlink,
      cursorStyle: settingsRef.current.cursorStyle,
      cursorInactiveStyle: "outline",
      customGlyphs: true,
      fontFamily: terminalFontFamily(),
      fontSize: settingsRef.current.fontSize,
      fontWeight: 400,
      fontWeightBold: 600,
      letterSpacing: 0,
      lineHeight: settingsRef.current.lineHeight,
      logLevel: "off",
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      rescaleOverlappingGlyphs: true,
      rightClickSelectsWord: true,
      screenReaderMode: settingsRef.current.screenReaderMode,
      scrollback: settingsRef.current.scrollbackRows,
      scrollOnEraseInDisplay: true,
      smoothScrollDuration: 0,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(searchAddon);
    xterm.loadAddon(
      new WebLinksAddon((_event, value) => {
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") return;
          window.open(url.href, "_blank", "noopener,noreferrer");
        } catch {
          // Terminal-controlled malformed links stay inert.
        }
      }),
    );
    xterm.open(host);
    const protectNativePaste = (event: ClipboardEvent) => {
      const value = event.clipboardData?.getData("text/plain") ?? "";
      if (
        !value ||
        !settingsRef.current.pasteProtection ||
        !isRiskyPaste(value)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        window.confirm(
          "Paste multiple lines or control characters into this terminal?",
        )
      )
        xterm.paste(value);
    };
    host.addEventListener("paste", protectNativePaste, true);
    const shellMarkerDisposable = xterm.parser.registerOscHandler(
      INSPIRE_SHELL_OSC,
      (value) => {
        const separator = value.indexOf(";");
        const phase = separator < 0 ? value : value.slice(0, separator);
        const payload = separator < 0 ? "" : value.slice(separator + 1);
        if (phase === "C" || phase === "C1") {
          const command = shellMarkerCommand(phase, payload);
          const marker = xterm.registerMarker(0);
          if (!command || !marker) return true;
          commandMarkersRef.current.push({
            command,
            start: marker,
            end: null,
            exitCode: null,
          });
          while (commandMarkersRef.current.length > 200) {
            const retired = commandMarkersRef.current.shift();
            retired?.start.dispose();
            retired?.end?.dispose();
          }
          setCommandRevision((revision) => revision + 1);
        } else if (phase === "D") {
          const boundary = commandMarkersRef.current.at(-1);
          if (!boundary || boundary.end) return true;
          boundary.end = xterm.registerMarker(0) ?? null;
          const exitCode = Number(payload);
          boundary.exitCode = Number.isInteger(exitCode) ? exitCode : null;
          setCommandRevision((revision) => revision + 1);
        }
        return true;
      },
    );
    const fileLinksDisposable = xterm.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        if (!onOpenFileRef.current) {
          callback(undefined);
          return;
        }
        const line = xterm.buffer.active.getLine(lineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const links = terminalFileLinks(line, lineNumber, (_event, value) =>
          onOpenFileRef.current?.(
            terminalFileReference(value, descriptorRef.current.currentCwd),
          ),
        );
        callback(links.length > 0 ? links : undefined);
      },
    });
    xtermRef.current = xterm;
    fitRef.current = fit;
    searchRef.current = searchAddon;
    const updateTheme = () => {
      xterm.options.theme = terminalTheme();
      xterm.options.fontFamily = terminalFontFamily();
    };
    const refitAfterFontLoad = () => {
      if (xtermRef.current !== xterm) return;
      updateTheme();
      requestAnimationFrame(fitAndResize);
    };
    document.fonts?.addEventListener("loadingdone", refitAfterFontLoad);
    void document.fonts?.ready.then(refitAfterFontLoad);
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette", "style", "class"],
    });
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      xterm.loadAddon(webgl);
    } catch {
      webgl?.dispose();
      webgl = null;
    }
    const resultsDisposable = searchAddon.onDidChangeResults((result) =>
      setSearch((current) => ({
        ...current,
        resultIndex: result.resultIndex,
        resultCount: result.resultCount,
      })),
    );
    const selectionDisposable = xterm.onSelectionChange(() =>
      setHasSelection(xterm.hasSelection()),
    );
    const scrollDisposable = xterm.onScroll(() =>
      setOutputBelow(xterm.buffer.active.viewportY < xterm.buffer.active.baseY),
    );
    const bellDisposable = xterm.onBell(() => {
      if (settingsRef.current.bell === "off") return;
      setBellFlash(true);
      if (bellTimerRef.current !== null)
        window.clearTimeout(bellTimerRef.current);
      bellTimerRef.current = window.setTimeout(() => {
        bellTimerRef.current = null;
        setBellFlash(false);
      }, 180);
      onBellRef.current(descriptorRef.current);
    });
    const inputDisposable = xterm.onData((value) => {
      let input = value;
      if (ctrlLatchedRef.current && input.length === 1) {
        const code = input.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) input = String.fromCharCode(code - 64);
        ctrlLatchedRef.current = false;
        setCtrlLatched(false);
      }
      if (altLatchedRef.current) {
        input = `\u001b${input}`;
        altLatchedRef.current = false;
        setAltLatched(false);
      }
      connectionRef.current?.sendInput(input);
    });
    xterm.attachCustomKeyEventHandler((event) => {
      const command = event.metaKey || event.ctrlKey;
      const workbenchShortcut =
        settingsRef.current.shortcutMode === "workbench" || event.metaKey;
      if (event.type !== "keydown") return true;
      const applicationShortcut =
        workbenchShortcut &&
        ((command && ["k", "b", "."].includes(event.key.toLowerCase())) ||
          (settingsRef.current.shortcutMode === "workbench" &&
            ((command && ["PageUp", "PageDown"].includes(event.key)) ||
              (event.altKey && /^Digit[1-9]$/u.test(event.code)) ||
              (command && event.shiftKey && event.key === "`"))));
      // Returning early leaves the DOM event available to the workbench-level
      // shortcut handlers instead of letting xterm stop its propagation.
      if (applicationShortcut) return false;
      if (workbenchShortcut && command && event.key.toLowerCase() === "f") {
        setSearch((current) => ({ ...current, open: true }));
        return false;
      }
      if (
        workbenchShortcut &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "c"
      ) {
        if (!xterm.hasSelection()) return event.ctrlKey && !event.metaKey;
        // Let xterm's native copy event place its selection on the clipboard.
        return false;
      }
      if (
        workbenchShortcut &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "v"
      ) {
        // Leave the native paste event intact so clipboard text remains
        // ordered before any immediately following keystroke. The capture
        // handler above protects risky content before xterm receives it.
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.key === "Escape") {
        xterm.blur();
        return false;
      }
      return true;
    });
    const connection = new TerminalConnection(api, descriptor.id, {
      dimensions: currentDimensions,
      data: handleData,
      control: handleControl,
      status: (status) => {
        setTransport(status);
        if (status !== "connected") {
          replayGenerationRef.current += 1;
          writableRef.current = false;
          setWritable(false);
          setReady(false);
        }
      },
      error: setError,
    });
    connectionRef.current = connection;
    const initialize = async () => {
      try {
        await document.fonts?.ready;
      } catch {
        // Browser font loading failures use the declared monospace fallback.
      }
      if (xtermRef.current !== xterm) return;
      updateTheme();
      fit.fit();
      connection.start();
      if (activeRef.current) xterm.focus();
    };
    void initialize();
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null)
        cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        fitAndResize();
      });
    });
    resizeObserver.observe(host);
    return () => {
      if (resizeFrameRef.current !== null)
        cancelAnimationFrame(resizeFrameRef.current);
      connection.stop();
      connectionRef.current = null;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.fonts?.removeEventListener("loadingdone", refitAfterFontLoad);
      host.removeEventListener("paste", protectNativePaste, true);
      inputDisposable.dispose();
      resultsDisposable.dispose();
      bellDisposable.dispose();
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      fileLinksDisposable.dispose();
      shellMarkerDisposable.dispose();
      if (bellTimerRef.current !== null)
        window.clearTimeout(bellTimerRef.current);
      webgl?.dispose();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [
    api,
    currentDimensions,
    descriptor.id,
    fitAndResize,
    handleControl,
    handleData,
  ]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitAndResize();
      xtermRef.current?.focus();
    });
  }, [active, fitAndResize, ready, writable]);

  useEffect(
    () =>
      subscribeTerminalActions((action) => {
        if (
          action !== "take-control" ||
          !active ||
          !ready ||
          descriptor.status !== "running"
        )
          return false;
        const dimensions = currentDimensions();
        connectionRef.current?.takeControl(dimensions.cols, dimensions.rows);
        return true;
      }),
    [active, currentDimensions, descriptor.status, ready],
  );

  useEffect(() => {
    const deliver = () => {
      const xterm = xtermRef.current;
      if (!active || !ready || !writable || !xterm) return;
      let inserted = false;
      while (hasTerminalInsertion(descriptor.projectCwd)) {
        const text = takeTerminalInsertion(descriptor.projectCwd);
        if (!text) break;
        if (hasUnsafePasteControl(text)) {
          setError("Code containing control characters was not inserted");
          continue;
        }
        if (/[\r\n]/u.test(text)) {
          if (!xterm.modes.bracketedPasteMode) {
            setError(
              "Multiline code needs protected paste support from the active program",
            );
            continue;
          }
          if (
            settingsRef.current.pasteProtection &&
            !window.confirm(
              "Insert multiple lines into this terminal? Review them before running.",
            )
          )
            continue;
        }
        xterm.paste(text);
        inserted = true;
      }
      if (inserted) xterm.focus();
    };
    deliver();
    return subscribeTerminalInsertion(deliver);
  }, [active, descriptor.projectCwd, ready, writable]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontSize = settings.fontSize;
    xterm.options.lineHeight = settings.lineHeight;
    xterm.options.cursorStyle = settings.cursorStyle;
    xterm.options.cursorBlink = settings.cursorBlink;
    xterm.options.screenReaderMode = settings.screenReaderMode;
    xterm.options.scrollback = settings.scrollbackRows;
    requestAnimationFrame(fitAndResize);
  }, [fitAndResize, settings]);

  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.disableStdin =
      !writable || !ready || descriptor.status !== "running";
  }, [descriptor.status, ready, writable]);

  const optionsForSearch = (value: SearchState) => ({
    caseSensitive: value.caseSensitive,
    regex: value.regex,
    wholeWord: value.wholeWord,
    decorations: {
      matchOverviewRuler: cssColor("--terminal-search", "#e4b65a"),
      activeMatchColorOverviewRuler: cssColor(
        "--terminal-search-active",
        "#ff781f",
      ),
      matchBackground: cssColor("--terminal-search-bg", "#5b4a24"),
      activeMatchBackground: cssColor("--terminal-search-active-bg", "#8a431d"),
    },
  });
  const searchOptions = optionsForSearch(search);
  const toggleSearchOption = (
    option: "caseSensitive" | "regex" | "wholeWord",
  ) => {
    const next = { ...search, [option]: !search[option] };
    setSearch(next);
    if (next.query)
      searchRef.current?.findNext(next.query, {
        ...optionsForSearch(next),
        incremental: true,
      });
  };
  const find = (direction: "next" | "previous") => {
    const addon = searchRef.current;
    if (!addon || !search.query) return;
    if (direction === "next") addon.findNext(search.query, searchOptions);
    else addon.findPrevious(search.query, searchOptions);
  };
  const closeSearch = () => {
    searchRef.current?.clearDecorations();
    setSearch(initialSearch);
    xtermRef.current?.focus();
  };
  const copySelection = async () => {
    const selection = xtermRef.current?.getSelection();
    if (!selection) return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard access is unavailable in this browser");
      await navigator.clipboard.writeText(selection);
    } catch (clipboardError) {
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : "Clipboard write failed",
      );
    }
  };
  const pasteClipboard = async () => {
    try {
      const value = await clipboardText();
      if (
        value &&
        (!settingsRef.current.pasteProtection ||
          !isRiskyPaste(value) ||
          window.confirm(
            "Paste multiple lines or control characters into this terminal?",
          ))
      )
        xtermRef.current?.paste(value);
    } catch (clipboardError) {
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : "Clipboard access failed",
      );
    }
  };
  const sendTouchKey = (value: string) => {
    let input = value;
    if (ctrlLatched && input.length === 1) {
      const code = input.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) input = String.fromCharCode(code - 64);
      setCtrlLatched(false);
    }
    if (altLatched) {
      input = `\u001b${input}`;
      setAltLatched(false);
    }
    connectionRef.current?.sendInput(input);
    xtermRef.current?.focus();
  };
  const sendTouchCursorKey = (
    normal: string,
    application: string,
    final: string,
  ) => {
    const modifier = 1 + (altLatched ? 2 : 0) + (ctrlLatched ? 4 : 0);
    if (modifier === 1) {
      sendTouchKey(
        xtermRef.current?.modes.applicationCursorKeysMode
          ? application
          : normal,
      );
      return;
    }
    setCtrlLatched(false);
    setAltLatched(false);
    connectionRef.current?.sendInput(`\u001b[1;${modifier}${final}`);
    xtermRef.current?.focus();
  };
  const sendTouchPageKey = (page: 5 | 6) => {
    const modifier = 1 + (altLatched ? 2 : 0) + (ctrlLatched ? 4 : 0);
    setCtrlLatched(false);
    setAltLatched(false);
    connectionRef.current?.sendInput(
      modifier === 1 ? `\u001b[${page}~` : `\u001b[${page};${modifier}~`,
    );
    xtermRef.current?.focus();
  };
  const handleSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      find(event.shiftKey ? "previous" : "next");
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  };

  const commandBoundaries =
    commandRevision >= 0
      ? commandMarkersRef.current.filter(
          (boundary) => !boundary.start.isDisposed && boundary.start.line >= 0,
        )
      : [];
  const lastCommand = commandBoundaries.at(-1);
  const navigateCommand = (direction: "previous" | "next") => {
    const xterm = xtermRef.current;
    if (!xterm || commandBoundaries.length === 0) return;
    const viewport = xterm.buffer.active.viewportY;
    let target: TerminalCommandBoundary | undefined;
    if (direction === "previous") {
      for (let index = commandBoundaries.length - 1; index >= 0; index -= 1) {
        if (commandBoundaries[index]!.start.line < viewport) {
          target = commandBoundaries[index];
          break;
        }
      }
      target ??= commandBoundaries.at(-1);
    } else {
      target = commandBoundaries.find(
        (boundary) => boundary.start.line > viewport,
      );
      target ??= commandBoundaries[0];
    }
    if (target) xterm.scrollToLine(target.start.line);
  };
  const copyLastCommand = async () => {
    if (!lastCommand) return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard access is unavailable in this browser");
      await navigator.clipboard.writeText(lastCommand.command);
    } catch (clipboardError) {
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : "Clipboard write failed",
      );
    }
  };
  const copyLastCommandOutput = async () => {
    const xterm = xtermRef.current;
    const endLine = lastCommand?.end?.line;
    if (!xterm || !lastCommand || endLine === undefined || endLine < 0) return;
    const lines: string[] = [];
    for (let line = lastCommand.start.line + 1; line <= endLine; line += 1) {
      const value = xterm.buffer.active.getLine(line)?.translateToString(true);
      if (value !== undefined) lines.push(value);
    }
    const output = lines.join("\n").trimEnd();
    if (!output) return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard access is unavailable in this browser");
      await navigator.clipboard.writeText(output);
    } catch (clipboardError) {
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : "Clipboard write failed",
      );
    }
  };
  const rerunLastCommand = () => {
    if (!lastCommand || !writable || !ready) return;
    if (
      isRiskyPaste(lastCommand.command) &&
      !window.confirm("Run this multi-line terminal command again?")
    )
      return;
    if (!connectionRef.current?.sendInput(`${lastCommand.command}\r`))
      setError("Terminal command could not be sent");
  };

  const statusLabel =
    descriptor.status === "exited"
      ? `Exited ${descriptor.exitCode ?? ""}`.trim()
      : writable
        ? "Controlling"
        : descriptor.hasOwner
          ? "View only"
          : "Control available";

  return (
    <section
      className={`terminal-view${active ? " terminal-view--active" : ""}${bellFlash ? " terminal-view--bell" : ""}`}
      aria-label={`Terminal ${descriptor.title}`}
      aria-hidden={!active}
    >
      <div className="terminal-view__toolbar">
        {search.open ? (
          <div className="terminal-search" role="search">
            <Search size={13} aria-hidden />
            <input
              autoFocus
              value={search.query}
              onChange={(event) => {
                const query = event.target.value;
                setSearch((current) => ({ ...current, query }));
                if (query)
                  searchRef.current?.findNext(query, {
                    ...searchOptions,
                    incremental: true,
                  });
                else searchRef.current?.clearDecorations();
              }}
              onKeyDown={handleSearchKey}
              aria-label="Search terminal output"
              placeholder="Find"
            />
            <button
              type="button"
              className="terminal-search__option"
              aria-pressed={search.caseSensitive}
              aria-label="Match case"
              title="Match case"
              onClick={() => toggleSearchOption("caseSensitive")}
            >
              Aa
            </button>
            <button
              type="button"
              className="terminal-search__option"
              aria-pressed={search.wholeWord}
              aria-label="Match whole word"
              title="Match whole word"
              onClick={() => toggleSearchOption("wholeWord")}
            >
              ab
            </button>
            <button
              type="button"
              className="terminal-search__option"
              aria-pressed={search.regex}
              aria-label="Use regular expression"
              title="Use regular expression"
              onClick={() => toggleSearchOption("regex")}
            >
              .*
            </button>
            <span className="terminal-search__count" aria-live="polite">
              {search.resultCount > 0
                ? `${search.resultIndex + 1}/${search.resultCount}`
                : "0/0"}
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => find("previous")}
              aria-label="Previous terminal match"
              title="Previous match"
            >
              <ChevronUp size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => find("next")}
              aria-label="Next terminal match"
              title="Next match"
            >
              <ChevronDown size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={closeSearch}
              aria-label="Close terminal search"
              title="Close search"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : (
          <>
            <div className="terminal-view__status" title={transport}>
              <span
                className={`terminal-view__status-dot terminal-view__status-dot--${transport}`}
                aria-hidden
              />
              <span>{statusLabel}</span>
            </div>
            <div className="terminal-view__actions">
              {!writable && descriptor.status === "running" ? (
                <button
                  type="button"
                  className="terminal-view__control"
                  disabled={!ready}
                  onClick={() => {
                    const dimensions = currentDimensions();
                    connectionRef.current?.takeControl(
                      dimensions.cols,
                      dimensions.rows,
                    );
                  }}
                >
                  <Keyboard size={13} aria-hidden />
                  Take control
                </button>
              ) : null}
              <details className="terminal-command-menu" data-terminal-menu>
                <summary
                  className="icon-button"
                  aria-label="Terminal command history"
                  title="Command history"
                >
                  <CommandHistory size={14} aria-hidden />
                </summary>
                <div
                  className="terminal-command-menu__popover"
                  onClick={(event) => {
                    if ((event.target as Element).closest("button"))
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                  }}
                >
                  <button
                    type="button"
                    disabled={commandBoundaries.length === 0}
                    onClick={() => navigateCommand("previous")}
                  >
                    Previous command
                  </button>
                  <button
                    type="button"
                    disabled={commandBoundaries.length === 0}
                    onClick={() => navigateCommand("next")}
                  >
                    Next command
                  </button>
                  <button
                    type="button"
                    disabled={!lastCommand}
                    onClick={() => void copyLastCommand()}
                  >
                    Copy last command
                  </button>
                  <button
                    type="button"
                    disabled={!lastCommand?.end}
                    onClick={() => void copyLastCommandOutput()}
                  >
                    Copy last output
                  </button>
                  <button
                    type="button"
                    disabled={!lastCommand || !writable || !ready}
                    onClick={rerunLastCommand}
                  >
                    Run last command again
                  </button>
                  <button
                    type="button"
                    onClick={() => xtermRef.current?.selectAll()}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => xtermRef.current?.clear()}
                  >
                    Clear local scrollback
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      xtermRef.current?.reset();
                      connectionRef.current?.forceSnapshot();
                    }}
                  >
                    Reset terminal display
                  </button>
                </div>
              </details>
              <button
                type="button"
                className="icon-button"
                onClick={() =>
                  setSearch((current) => ({ ...current, open: true }))
                }
                aria-label="Search terminal output"
                title="Search terminal output"
              >
                <Search size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => void copySelection()}
                disabled={!hasSelection}
                aria-label="Copy terminal selection"
                title="Copy selection"
              >
                <Copy size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  const selection = xtermRef.current?.getSelection();
                  if (selection) onSendToComposerRef.current?.(selection);
                }}
                disabled={!hasSelection || !onSendToComposer}
                aria-label="Send terminal selection to composer"
                title="Send selection to composer"
              >
                <MessageSquareQuote size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => void pasteClipboard()}
                disabled={!writable || !ready}
                aria-label="Paste into terminal"
                title="Paste"
              >
                <ClipboardPaste size={14} aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>
      <div className="terminal-view__stage">
        <div ref={hostRef} className="terminal-view__xterm" />
        {outputBelow ? (
          <button
            type="button"
            className="terminal-view__new-output"
            onClick={() => {
              xtermRef.current?.scrollToBottom();
              xtermRef.current?.focus();
              setOutputBelow(false);
            }}
          >
            New output ↓
          </button>
        ) : null}
        {error ? (
          <button
            type="button"
            className="terminal-view__error"
            onClick={() => setError(null)}
            title="Dismiss"
          >
            {error}
          </button>
        ) : null}
        {descriptor.status === "exited" ? (
          <div className="terminal-view__exit" role="status">
            Process exited
            {descriptor.exitCode !== null
              ? ` with code ${descriptor.exitCode}`
              : ""}
          </div>
        ) : null}
      </div>
      <fieldset
        className="terminal-touch-keys"
        disabled={!writable || !ready || descriptor.status !== "running"}
      >
        <legend className="sr-only">Terminal modifier keys</legend>
        <button type="button" onClick={() => sendTouchKey("\u001b")}>
          Esc
        </button>
        <button
          type="button"
          className={ctrlLatched ? "is-active" : ""}
          aria-pressed={ctrlLatched}
          onClick={() => setCtrlLatched((value) => !value)}
        >
          Ctrl
        </button>
        <button
          type="button"
          className={altLatched ? "is-active" : ""}
          aria-pressed={altLatched}
          onClick={() => setAltLatched((value) => !value)}
        >
          Alt
        </button>
        <button type="button" onClick={() => sendTouchKey("\t")}>
          Tab
        </button>
        <button
          type="button"
          aria-label="Arrow up"
          onClick={() => sendTouchCursorKey("\u001b[A", "\u001bOA", "A")}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Arrow down"
          onClick={() => sendTouchCursorKey("\u001b[B", "\u001bOB", "B")}
        >
          ↓
        </button>
        <button
          type="button"
          aria-label="Arrow left"
          onClick={() => sendTouchCursorKey("\u001b[D", "\u001bOD", "D")}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Arrow right"
          onClick={() => sendTouchCursorKey("\u001b[C", "\u001bOC", "C")}
        >
          →
        </button>
        <button
          type="button"
          onClick={() => sendTouchCursorKey("\u001b[H", "\u001bOH", "H")}
        >
          Home
        </button>
        <button
          type="button"
          onClick={() => sendTouchCursorKey("\u001b[F", "\u001bOF", "F")}
        >
          End
        </button>
        <button type="button" onClick={() => sendTouchPageKey(5)}>
          PgUp
        </button>
        <button type="button" onClick={() => sendTouchPageKey(6)}>
          PgDn
        </button>
      </fieldset>
      <span className="sr-only" aria-live="polite">
        {transport === "reconnecting" ? "Terminal reconnecting" : ""}
      </span>
    </section>
  );
});
