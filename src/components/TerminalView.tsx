import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IMarker, type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  Eye,
  Keyboard,
  LoaderCircle,
  MessageSquareQuote,
  Monitor,
  RotateCcw,
  Search,
  Square,
  TextSelect,
  X,
} from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  type TerminalCommandOutput,
  terminalCommandOutput,
} from "../terminal-command-output";
import {
  TerminalConnection,
  type TerminalTransportStatus,
} from "../terminal-connection";
import { terminalActivationFocus } from "../terminal-focus";
import { terminalFileLinks } from "../terminal-links";
import type { TerminalUiSettings } from "../terminal-settings";

interface TerminalViewProps {
  api: Api;
  terminal: TerminalDescriptor;
  active: boolean;
  settings: TerminalUiSettings;
  toolbarHost: HTMLElement | null;
  menuHost: HTMLElement | null;
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
  toolbarHost,
  menuHost,
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
  const replayGenerationRef = useRef(0);
  const clipboardEpochRef = useRef(0);
  const snapshotStartedRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const bellTimerRef = useRef<number | null>(null);
  const commandStartRef = useRef<{ marker: IMarker; column: number } | null>(
    null,
  );
  const lastOutputRef = useRef<TerminalCommandOutput | null>(null);
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
  const [lastOutput, setLastOutput] = useState<TerminalCommandOutput | null>(
    null,
  );

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

  useLayoutEffect(() => {
    clipboardEpochRef.current += 1;
  }, [active]);

  const clearCommandOutput = useCallback(() => {
    const start = commandStartRef.current;
    const output = lastOutputRef.current;
    commandStartRef.current = null;
    lastOutputRef.current = null;
    start?.marker.dispose();
    output?.start.dispose();
    output?.end.dispose();
    setLastOutput(null);
  }, []);

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
      if (
        message.type === "attached" ||
        (message.type === "ownership" &&
          message.writable !== writableRef.current)
      )
        clipboardEpochRef.current += 1;
      const xterm = xtermRef.current;
      if (message.type === "attached") {
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
        clearCommandOutput();
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
    [clearCommandOutput, onBackgroundOutput],
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
          if (!shellMarkerCommand(phase, payload)) return true;
          commandStartRef.current?.marker.dispose();
          const marker = xterm.registerMarker(0);
          commandStartRef.current = marker
            ? { marker, column: xterm.buffer.active.cursorX }
            : null;
        } else if (phase === "D") {
          const start = commandStartRef.current;
          commandStartRef.current = null;
          if (!start || start.marker.isDisposed) return true;
          const end = xterm.registerMarker(0);
          if (!end) {
            start.marker.dispose();
            return true;
          }
          // Keep only the last completed output, not a second command history.
          lastOutputRef.current?.start.dispose();
          lastOutputRef.current?.end.dispose();
          const output = {
            start: start.marker,
            startColumn: start.column,
            end,
            endColumn: xterm.buffer.active.cursorX,
          };
          lastOutputRef.current = output;
          setLastOutput(output);
          const retire = () => {
            if (lastOutputRef.current === output) setLastOutput(null);
          };
          start.marker.onDispose(retire);
          end.onDispose(retire);
        }
        return true;
      },
    );
    const resetDisposable = xterm.parser.registerEscHandler(
      { final: "c" },
      () => {
        clearCommandOutput();
        return false;
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
    // Cell columns are not durable through reflow. Never copy guessed ranges
    // after a resize; the next completed command establishes fresh boundaries.
    const resizeDisposable = xterm.onResize(clearCommandOutput);
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
          clipboardEpochRef.current += 1;
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
      resizeDisposable.dispose();
      resultsDisposable.dispose();
      bellDisposable.dispose();
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      fileLinksDisposable.dispose();
      shellMarkerDisposable.dispose();
      resetDisposable.dispose();
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
    clearCommandOutput,
    currentDimensions,
    descriptor.id,
    fitAndResize,
    handleControl,
    handleData,
  ]);

  useEffect(() => {
    if (!active) return;
    const permitted = terminalActivationFocus();
    const frame = requestAnimationFrame(() => {
      fitAndResize();
      if (activeRef.current && permitted()) xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fitAndResize]);

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
        xtermRef.current?.focus();
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
    const xterm = xtermRef.current;
    if (!xterm || !ready || !writableRef.current) return;
    const epoch = clipboardEpochRef.current;
    const opener = document.activeElement;
    const ownsPaste = () =>
      epoch === clipboardEpochRef.current &&
      activeRef.current &&
      writableRef.current &&
      descriptorRef.current.status === "running" &&
      xtermRef.current === xterm;
    try {
      const value = await clipboardText();
      if (!ownsPaste()) return;
      if (
        value &&
        (!settingsRef.current.pasteProtection ||
          !isRiskyPaste(value) ||
          window.confirm(
            "Paste multiple lines or control characters into this terminal?",
          ))
      )
        xterm.paste(value);
    } catch (clipboardError) {
      if (!ownsPaste()) return;
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : "Clipboard access failed",
      );
    } finally {
      // Return from the dismissed menu, but never steal a newer focus choice.
      if (
        ownsPaste() &&
        (document.activeElement === opener ||
          document.activeElement === document.body)
      )
        xterm.focus();
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
    }
  };

  const copyLastCommandOutput = async () => {
    const xterm = xtermRef.current;
    const outputRange = lastOutputRef.current;
    if (!xterm || !outputRange) return;
    const output = terminalCommandOutput(xterm.buffer.normal, outputRange);
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
  const statusLabel =
    descriptor.status === "exited"
      ? `Exited ${descriptor.exitCode ?? ""}`.trim()
      : transport !== "connected"
        ? transport.charAt(0).toUpperCase() + transport.slice(1)
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
      {active && toolbarHost
        ? createPortal(
            <>
              <span
                className={`terminal-view__status terminal-view__status--${transport}`}
                role="status"
                aria-label={statusLabel}
                title={`${statusLabel} · ${transport}`}
              >
                {descriptor.status === "exited" ? (
                  <Square size={12} aria-hidden />
                ) : transport !== "connected" ? (
                  <LoaderCircle size={14} aria-hidden />
                ) : writable ? (
                  <Keyboard size={14} aria-hidden />
                ) : (
                  <Eye size={14} aria-hidden />
                )}
                <span className="terminal-view__status-label">
                  {statusLabel}
                </span>
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  if (search.open) closeSearch();
                  else setSearch((current) => ({ ...current, open: true }));
                }}
                aria-label="Search terminal output"
                aria-expanded={search.open}
                title="Search terminal output"
              >
                <Search size={14} aria-hidden />
              </button>
            </>,
            toolbarHost,
          )
        : null}
      {active && menuHost
        ? createPortal(
            <>
              <button
                type="button"
                onClick={() => void pasteClipboard()}
                disabled={
                  !writable || !ready || descriptor.status !== "running"
                }
                aria-label="Paste into terminal"
              >
                <ClipboardPaste size={14} aria-hidden /> Paste
              </button>
              <button
                type="button"
                disabled={!lastOutput}
                title={
                  lastOutput
                    ? "Copy the last completed command output"
                    : "Available after a command finishes in this view (requires shell integration)"
                }
                onClick={() => void copyLastCommandOutput()}
              >
                <Copy size={14} aria-hidden /> Copy last output
              </button>
              <details
                className="terminal-menu__group"
                data-terminal-menu-group
              >
                <summary>
                  <Monitor size={14} aria-hidden /> Display
                  <ChevronRight
                    className="terminal-menu__chevron"
                    size={13}
                    aria-hidden
                  />
                </summary>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      xtermRef.current?.selectAll();
                      xtermRef.current?.focus();
                    }}
                  >
                    <TextSelect size={14} aria-hidden /> Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => xtermRef.current?.clear()}
                  >
                    <Eraser size={14} aria-hidden /> Clear local scrollback
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearCommandOutput();
                      xtermRef.current?.reset();
                      connectionRef.current?.forceSnapshot();
                    }}
                  >
                    <RotateCcw size={14} aria-hidden /> Reset terminal display
                  </button>
                </div>
              </details>
            </>,
            menuHost,
          )
        : null}
      <div className="terminal-view__stage">
        <div ref={hostRef} className="terminal-view__xterm" />
        <div className="terminal-view__overlays">
          {search.open ? (
            <div
              className="terminal-search"
              role="search"
              aria-label="Terminal output"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }}
            >
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
          ) : null}
          {hasSelection && !search.open ? (
            <div
              className="terminal-selection"
              role="group"
              aria-label="Selected terminal text"
            >
              <button
                type="button"
                onClick={() => void copySelection()}
                aria-label="Copy terminal selection"
              >
                <Copy size={14} aria-hidden /> Copy
              </button>
              {onSendToComposer ? (
                <button
                  type="button"
                  className="terminal-selection__quote"
                  onClick={() => {
                    const selection = xtermRef.current?.getSelection();
                    if (selection) onSendToComposerRef.current?.(selection);
                  }}
                  aria-label="Send terminal selection to composer"
                  title="Add selection to the composer without sending"
                >
                  <MessageSquareQuote size={14} aria-hidden /> Add to chat
                </button>
              ) : null}
            </div>
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
        </div>
        {!writable && descriptor.status === "running" ? (
          <div className="terminal-view__ownership">
            <span>{statusLabel}</span>
            {ready ? (
              <button
                type="button"
                className="terminal-view__control"
                onClick={() => {
                  const dimensions = currentDimensions();
                  connectionRef.current?.takeControl(
                    dimensions.cols,
                    dimensions.rows,
                  );
                  xtermRef.current?.focus();
                }}
              >
                <Keyboard size={13} aria-hidden /> Take control
              </button>
            ) : null}
          </div>
        ) : null}
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
