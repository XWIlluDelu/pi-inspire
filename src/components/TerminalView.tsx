import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IMarker, type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Keyboard,
  MessageSquareQuote,
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
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  parseTerminalShellMarker,
  type TerminalDescriptor,
  type TerminalServerControlMessage,
  type TerminalServerDataFrame,
} from "../../shared/terminal-contracts";
import type { Api } from "../api";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  hasTerminalInsertion,
  subscribeTerminalInsertion,
  takeTerminalInsertion,
} from "../terminal-actions";
import {
  TerminalConnection,
  type TerminalTransportStatus,
} from "../terminal-connection";
import { terminalActivationFocus } from "../terminal-focus";
import {
  NO_TERMINAL_MODIFIERS,
  type TerminalModifiers,
  type TerminalTouchKey,
  terminalTextInput,
  terminalTouchInput,
} from "../terminal-input";
import { isMacTerminalBrowser, terminalShortcut } from "../terminal-keyboard";
import { terminalFileLinks, terminalFileReference } from "../terminal-links";
import {
  type TerminalCommandOutput,
  terminalBufferText,
  terminalCommandOutput,
} from "../terminal-output";
import type { TerminalUiSettings } from "../terminal-settings";
import {
  TerminalSearchAddon,
  terminalSearchOptions,
  terminalSelectionColor,
} from "../terminal-theme";
import { useCopied } from "../use-copied";
import { NoticeCard } from "./NoticeCard";
import { SearchField } from "./SearchField";
import { TerminalTextDialog } from "./TerminalTextDialog";
import { TerminalTouchKeys } from "./TerminalTouchKeys";

type TerminalViewAction =
  | "focus"
  | "take-control"
  | "search"
  | "paste"
  | "copy"
  | "select"
  | "copy-last"
  | "clear"
  | "reset";

export interface TerminalViewActions {
  owner: string;
  statusLabel: string;
  transport: TerminalTransportStatus;
  exited: boolean;
  writable: boolean;
  ready: boolean;
  searchOpen: boolean;
  hasLastOutput: boolean;
  invoke(action: TerminalViewAction, opener?: HTMLButtonElement): void;
}

interface TerminalViewProps {
  publishActions(actions: TerminalViewActions): void;
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
    selectionBackground: terminalSelectionColor(
      cssColor("--terminal-selection", "#5b331f"),
      "#5b331f",
    ),
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

export const TerminalView = memo(function TerminalView(
  props: TerminalViewProps,
) {
  const {
    api,
    terminal: descriptor,
    active,
    settings,
    publishActions,
    onDescriptor,
    onBackgroundOutput,
    onSendToComposer,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<TerminalSearchAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const descriptorRef = useRef(descriptor);
  const writableRef = useRef(false);
  const modifiersRef = useRef(NO_TERMINAL_MODIFIERS);
  const replayGenerationRef = useRef(0);
  const clipboardEpochRef = useRef(0);
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
  const searchStateRef = useRef(search);
  searchStateRef.current = search;
  const [modifiers, setModifiers] = useState(NO_TERMINAL_MODIFIERS);
  const [textSnapshot, setTextSnapshot] = useState<{
    text: string;
    scrollRatio: number;
  } | null>(null);
  const { copied, copy } = useCopied({
    onError: (message) =>
      setError(`${message}\nUse Select text to copy manually.`),
  });
  const [bellFlash, setBellFlash] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [outputBelow, setOutputBelow] = useState(false);
  const [lastOutput, setLastOutput] = useState<TerminalCommandOutput | null>(
    null,
  );

  descriptorRef.current = descriptor;
  writableRef.current = writable;

  const updateModifiers = useCallback((next: TerminalModifiers) => {
    modifiersRef.current = next;
    setModifiers(next);
  }, []);
  const clearModifiers = useCallback(
    () => updateModifiers(NO_TERMINAL_MODIFIERS),
    [updateModifiers],
  );

  useLayoutEffect(() => {
    clipboardEpochRef.current += 1;
    if (!active) setTextSnapshot(null);
  }, [active]);

  useEffect(() => {
    if (!active || !ready || !writable) clearModifiers();
  }, [active, ready, writable, clearModifiers]);

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
    const proposed = propsRef.current.active
      ? fitRef.current?.proposeDimensions()
      : undefined;
    return safeDimensions(proposed, descriptorRef.current);
  }, []);

  const fitAndResize = useCallback(() => {
    if (!propsRef.current.active || !writableRef.current) return;
    const { cols, rows } = currentDimensions();
    connectionRef.current?.resize(cols, rows);
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
      const size =
        message.type === "attached"
          ? message.terminal
          : message.type === "resized"
            ? message
            : null;
      if (xterm && size)
        xterm.write("", () => {
          if (xterm.cols !== size.cols || xterm.rows !== size.rows)
            xterm.resize(size.cols, size.rows);
        });
      if (message.type === "attached") {
        replayGenerationRef.current += 1;
        writableRef.current = message.writable;
        setWritable(message.writable);
        setReady(false);
        setError(null);
        applyDescriptor(message.terminal);
      } else if (message.type === "replay_complete") {
        const replayGeneration = replayGenerationRef.current;
        const completeReplay = () => {
          if (replayGeneration !== replayGenerationRef.current) return;
          setReady(true);
          if (propsRef.current.active && writableRef.current)
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
        if (message.writable && propsRef.current.active)
          requestAnimationFrame(fitAndResize);
      } else if (message.type === "descriptor") {
        applyDescriptor(message.terminal);
      } else if (message.type === "command_complete") {
        propsRef.current.onCommandComplete?.(descriptorRef.current, message);
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
      if (frame.kind === "snapshot") {
        clearCommandOutput();
        // Byte CAN aborts pending UTF-8/VT input before the ordered RIS reset.
        xterm.write(Uint8Array.of(0x18, 0x1b, 0x63));
      }
      xterm.write(frame.data, () => {
        setOutputBelow(
          xterm.buffer.active.viewportY < xterm.buffer.active.baseY,
        );
      });
      if (frame.kind === "output" && !propsRef.current.active)
        onBackgroundOutput(descriptorRef.current.id);
    },
    [clearCommandOutput, onBackgroundOutput],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xterm = new Terminal({
      allowProposedApi: true,
      cursorBlink: propsRef.current.settings.cursorBlink,
      cursorStyle: propsRef.current.settings.cursorStyle,
      cursorInactiveStyle: "outline",
      customGlyphs: true,
      fontFamily: terminalFontFamily(),
      fontSize: propsRef.current.settings.fontSize,
      fontWeight: 400,
      fontWeightBold: 600,
      letterSpacing: 0,
      lineHeight: propsRef.current.settings.lineHeight,
      logLevel: "off",
      macOptionIsMeta: propsRef.current.settings.macOptionIsMeta,
      minimumContrastRatio: 4.5,
      rescaleOverlappingGlyphs: true,
      rightClickSelectsWord: true,
      screenReaderMode: propsRef.current.settings.screenReaderMode,
      scrollback: propsRef.current.settings.scrollbackRows,
      scrollOnEraseInDisplay: true,
      smoothScrollDuration: 0,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const searchAddon = new TerminalSearchAddon();
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
      clearModifiers();
      const value = event.clipboardData?.getData("text/plain") ?? "";
      if (
        !value ||
        !propsRef.current.settings.pasteProtection ||
        !isRiskyPaste(value)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (window.confirm("Paste multiple lines or control characters?"))
        xterm.paste(value);
    };
    host.addEventListener("paste", protectNativePaste, true);
    xterm.textarea?.addEventListener("blur", clearModifiers);
    const shellMarkerDisposable = xterm.parser.registerOscHandler(
      INSPIRE_SHELL_OSC,
      (value) => {
        const shellMarker = parseTerminalShellMarker(value);
        if (shellMarker?.type === "command") {
          commandStartRef.current?.marker.dispose();
          const marker = xterm.registerMarker(0);
          commandStartRef.current = marker
            ? { marker, column: xterm.buffer.active.cursorX }
            : null;
        } else if (shellMarker?.type === "complete") {
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
        if (!propsRef.current.onOpenFile) {
          callback(undefined);
          return;
        }
        const line = xterm.buffer.active.getLine(lineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const links = terminalFileLinks(line, lineNumber, (_event, value) =>
          propsRef.current.onOpenFile?.(
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
      searchAddon.refreshTheme(searchStateRef.current);
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
    // Rows do not reflow text; markers still track their lines when the mobile
    // keyboard changes the height. A column change invalidates cell offsets.
    let outputColumns = xterm.cols;
    const resizeDisposable = xterm.onResize(({ cols }) => {
      if (cols === outputColumns) return;
      outputColumns = cols;
      clearCommandOutput();
    });
    const selectionDisposable = xterm.onSelectionChange(() =>
      setHasSelection(xterm.hasSelection()),
    );
    const scrollDisposable = xterm.onScroll(() =>
      setOutputBelow(xterm.buffer.active.viewportY < xterm.buffer.active.baseY),
    );
    const bellDisposable = xterm.onBell(() => {
      if (propsRef.current.settings.bell === "off") return;
      setBellFlash(true);
      if (bellTimerRef.current !== null)
        window.clearTimeout(bellTimerRef.current);
      bellTimerRef.current = window.setTimeout(() => {
        bellTimerRef.current = null;
        setBellFlash(false);
      }, 180);
      propsRef.current.onBell(descriptorRef.current);
    });
    const inputDisposable = xterm.onData((value) => {
      const input = terminalTextInput(value, modifiersRef.current);
      if (input !== null) clearModifiers();
      connectionRef.current?.sendInput(input ?? value);
    });
    xterm.attachCustomKeyEventHandler((event) => {
      const command = event.metaKey || event.ctrlKey;
      const workbenchShortcut =
        propsRef.current.settings.shortcutMode === "workbench" || event.metaKey;
      if (event.type !== "keydown") return true;
      if (event.defaultPrevented) return false;
      if (isComposingKeyboardEvent(event) || event.getModifierState("AltGraph"))
        return true;
      const applicationShortcut =
        workbenchShortcut &&
        ((command && ["k", "b", "."].includes(event.key.toLowerCase())) ||
          (propsRef.current.settings.shortcutMode === "workbench" &&
            terminalShortcut(event) !== null));
      // Returning early leaves the DOM event available to the workbench-level
      // shortcut handlers instead of letting xterm stop its propagation.
      if (applicationShortcut) return false;
      if (workbenchShortcut && command && event.key.toLowerCase() === "f") {
        setSearch((current) => ({ ...current, open: true }));
        return false;
      }
      const clipboardModifier = isMacTerminalBrowser()
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        workbenchShortcut &&
        clipboardModifier &&
        event.key.toLowerCase() === "c"
      ) {
        if (!xterm.hasSelection()) return event.ctrlKey && !event.metaKey;
        // Let xterm's native copy event place its selection on the clipboard.
        return false;
      }
      if (
        workbenchShortcut &&
        clipboardModifier &&
        event.key.toLowerCase() === "v"
      ) {
        // Leave the native paste event intact so clipboard text remains
        // ordered before any immediately following keystroke. The capture
        // handler above protects risky content before xterm receives it.
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
      if (propsRef.current.active) fit.fit();
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
      xterm.textarea?.removeEventListener("blur", clearModifiers);
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
    clearModifiers,
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
      if (propsRef.current.active && permitted()) xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fitAndResize]);

  useEffect(() => {
    const deliver = () => {
      const xterm = xtermRef.current;
      if (!active || !ready || !writable || !xterm) return;
      let inserted = false;
      while (hasTerminalInsertion(descriptor.projectCwd)) {
        const text = takeTerminalInsertion(descriptor.projectCwd);
        if (!text) break;
        if (hasUnsafePasteControl(text)) {
          setError("Control characters blocked code insertion");
          continue;
        }
        if (/[\r\n]/u.test(text)) {
          if (!xterm.modes.bracketedPasteMode) {
            setError("Multiline insertion requires protected paste support");
            continue;
          }
          if (
            propsRef.current.settings.pasteProtection &&
            !window.confirm("Insert multiple lines? Review before running.")
          )
            continue;
        }
        clearModifiers();
        xterm.paste(text);
        inserted = true;
      }
      if (inserted) xterm.focus();
    };
    deliver();
    return subscribeTerminalInsertion(deliver);
  }, [active, clearModifiers, descriptor.projectCwd, ready, writable]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontSize = settings.fontSize;
    xterm.options.lineHeight = settings.lineHeight;
    xterm.options.cursorStyle = settings.cursorStyle;
    xterm.options.cursorBlink = settings.cursorBlink;
    xterm.options.screenReaderMode = settings.screenReaderMode;
    xterm.options.macOptionIsMeta = settings.macOptionIsMeta;
    xterm.options.scrollback = settings.scrollbackRows;
    requestAnimationFrame(fitAndResize);
  }, [fitAndResize, settings]);

  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.disableStdin =
      !writable || !ready || descriptor.status !== "running";
  }, [descriptor.status, ready, writable]);

  const toggleSearchOption = (
    option: "caseSensitive" | "regex" | "wholeWord",
  ) => {
    const next = { ...search, [option]: !search[option] };
    setSearch(next);
    if (next.query)
      searchRef.current?.findNext(next.query, {
        ...terminalSearchOptions(next),
        incremental: true,
      });
  };
  const find = (direction: "next" | "previous") => {
    const addon = searchRef.current;
    if (!addon || !search.query) return;
    const options = terminalSearchOptions(search);
    if (direction === "next") addon.findNext(search.query, options);
    else addon.findPrevious(search.query, options);
  };
  const closeSearch = (returnToInput: boolean) => {
    searchRef.current?.clearDecorations();
    setSearch(initialSearch);
    if (returnToInput) xtermRef.current?.focus();
  };
  const copySelection = () => {
    const selection = xtermRef.current?.getSelection();
    if (selection) void copy(selection);
  };
  const copyAll = () => {
    const xterm = xtermRef.current;
    if (xterm) void copy(terminalBufferText(xterm.buffer.active));
  };
  const selectText = (opener?: HTMLButtonElement) => {
    const buffer = xtermRef.current?.buffer.active;
    if (!buffer) return;
    clearModifiers();
    opener
      ?.closest("details[data-terminal-menu]")
      ?.querySelector("summary")
      ?.focus();
    setTextSnapshot({
      text: terminalBufferText(buffer),
      scrollRatio: buffer.baseY > 0 ? buffer.viewportY / buffer.baseY : 0,
    });
  };
  const pasteClipboard = async () => {
    const xterm = xtermRef.current;
    if (!xterm || !ready || !writableRef.current) return;
    const epoch = clipboardEpochRef.current;
    const opener = document.activeElement;
    const ownsPaste = () =>
      epoch === clipboardEpochRef.current &&
      propsRef.current.active &&
      writableRef.current &&
      descriptorRef.current.status === "running" &&
      xtermRef.current === xterm;
    try {
      const value = await clipboardText();
      if (!ownsPaste()) return;
      if (
        value &&
        (!propsRef.current.settings.pasteProtection ||
          !isRiskyPaste(value) ||
          window.confirm("Paste multiple lines or control characters?"))
      ) {
        clearModifiers();
        xterm.paste(value);
      }
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
  const sendTouchKey = (key: TerminalTouchKey) => {
    connectionRef.current?.sendInput(
      terminalTouchInput(
        key,
        modifiersRef.current,
        xtermRef.current?.modes.applicationCursorKeysMode ?? false,
      ),
    );
    clearModifiers();
  };
  const handleSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      find(event.shiftKey ? "previous" : "next");
    }
  };

  const copyLastCommandOutput = () => {
    const xterm = xtermRef.current;
    const outputRange = lastOutputRef.current;
    if (!xterm || !outputRange) return;
    const output = terminalCommandOutput(xterm.buffer.normal, outputRange);
    if (output) void copy(output);
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

  const invokeRef = useRef<TerminalViewActions["invoke"]>(() => {});
  invokeRef.current = (action, opener) => {
    switch (action) {
      case "focus": {
        const pending = modifiersRef.current;
        xtermRef.current?.blur();
        xtermRef.current?.focus();
        updateModifiers(pending);
        break;
      }
      case "take-control": {
        if (!ready || descriptor.status !== "running") break;
        const { cols, rows } = currentDimensions();
        connectionRef.current?.takeControl(cols, rows);
        xtermRef.current?.focus();
        break;
      }
      case "search":
        if (searchStateRef.current.open) closeSearch(false);
        else setSearch((current) => ({ ...current, open: true }));
        break;
      case "paste":
        void pasteClipboard();
        break;
      case "copy":
        copyAll();
        break;
      case "select":
        selectText(opener);
        break;
      case "copy-last":
        copyLastCommandOutput();
        break;
      case "clear":
        xtermRef.current?.clear();
        break;
      case "reset":
        clearCommandOutput();
        xtermRef.current?.reset();
        connectionRef.current?.forceSnapshot();
    }
  };

  const owner = `${descriptor.id}:${descriptor.outputEpoch}`;
  const exited = descriptor.status === "exited";
  const hasLastOutput = lastOutput !== null;
  useLayoutEffect(() => {
    if (!active) return;
    publishActions({
      owner,
      statusLabel,
      transport,
      exited,
      writable,
      ready,
      searchOpen: search.open,
      hasLastOutput,
      invoke(action, opener) {
        if (
          propsRef.current.active &&
          xtermRef.current &&
          `${descriptorRef.current.id}:${descriptorRef.current.outputEpoch}` ===
            owner
        )
          invokeRef.current(action, opener);
      },
    });
  }, [
    active,
    owner,
    statusLabel,
    transport,
    exited,
    writable,
    ready,
    search.open,
    hasLastOutput,
    publishActions,
  ]);

  return (
    <section
      className={`terminal-view${active ? " terminal-view--active" : ""}${bellFlash ? " terminal-view--bell" : ""}`}
      aria-label={`Terminal ${descriptor.title}`}
      aria-hidden={!active}
    >
      <div className="terminal-view__stage">
        <div ref={hostRef} className="terminal-view__xterm" />
        <div className="terminal-view__overlays">
          {search.open ? (
            <div
              className="terminal-search"
              role="search"
              aria-label="Terminal output"
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest("button"))
                  event.preventDefault();
              }}
              onKeyDown={(event) => {
                if (isComposingKeyboardEvent(event.nativeEvent)) return;
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeSearch(true);
              }}
            >
              <SearchField
                className="terminal-search__field"
                iconSize={13}
                role="textbox"
                autoFocus
                value={search.query}
                onValueChange={(query) => {
                  setSearch((current) => ({ ...current, query }));
                  if (query)
                    searchRef.current?.findNext(query, {
                      ...terminalSearchOptions(search),
                      incremental: true,
                    });
                  else searchRef.current?.clearDecorations();
                }}
                onKeyDown={handleSearchKey}
                aria-label="Search terminal output"
                placeholder="Find"
              />
              {([
                ["caseSensitive", "Match case", "Aa"],
                ["wholeWord", "Match whole word", "ab"],
                ["regex", "Use regular expression", ".*"],
              ] as const).map(([option, label, text]) => (
                <button
                  key={option}
                  type="button"
                  className="icon-button terminal-search__option"
                  aria-pressed={search[option]}
                  aria-label={label}
                  title={label}
                  onClick={() => toggleSearchOption(option)}
                >
                  {text}
                </button>
              ))}
              <span className="terminal-search__count" aria-live="polite">
                {search.resultCount > 0
                  ? `${search.resultIndex + 1}/${search.resultCount}`
                  : "0/0"}
              </span>
              {([
                ["previous", "Previous", ChevronUp],
                ["next", "Next", ChevronDown],
              ] as const).map(([direction, label, Icon]) => (
                <button
                  key={direction}
                  type="button"
                  className="icon-button"
                  aria-label={`${label} terminal match`}
                  title={`${label} match`}
                  onClick={() => find(direction)}
                >
                  <Icon size={14} aria-hidden />
                </button>
              ))}
              <button
                type="button"
                className="icon-button terminal-search__close"
                onClick={() => closeSearch(false)}
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
              onPointerDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="button button--quiet"
                onClick={copySelection}
                aria-label="Copy terminal selection"
              >
                <Copy size={14} aria-hidden /> Copy
              </button>
              {onSendToComposer ? (
                <button
                  type="button"
                  className="button button--quiet terminal-selection__quote"
                  onClick={() => {
                    const selection = xtermRef.current?.getSelection();
                    if (selection)
                      propsRef.current.onSendToComposer?.(selection);
                  }}
                  aria-label="Send terminal selection to composer"
                  title="Add selection to draft"
                >
                  <MessageSquareQuote size={14} aria-hidden /> Add to chat
                </button>
              ) : null}
            </div>
          ) : null}
          {copied ? (
            <span className="terminal-copy-confirmation" role="status">
              <Check size={14} aria-hidden /> Copied
            </span>
          ) : null}
          {error ? (
            <NoticeCard
              kind="error"
              text={error}
              className="terminal-view__error"
              onDismiss={() => setError(null)}
              dismissLabel="Dismiss terminal error"
            />
          ) : null}
        </div>
        {!writable && descriptor.status === "running" ? (
          <div className="terminal-view__ownership">
            <span>{statusLabel}</span>
            {ready ? (
              <button
                type="button"
                className="button terminal-view__control"
                onClick={() => invokeRef.current("take-control")}
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
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              xtermRef.current?.scrollToBottom();
              if (event.detail === 0) xtermRef.current?.focus();
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
      <TerminalTouchKeys
        disabled={!writable || !ready || descriptor.status !== "running"}
        modifiers={modifiers}
        onToggleModifier={(modifier) =>
          updateModifiers({
            ...modifiersRef.current,
            [modifier]: !modifiersRef.current[modifier],
          })
        }
        onKey={sendTouchKey}
      />
      {active && textSnapshot
        ? createPortal(
            <TerminalTextDialog
              {...textSnapshot}
              onClose={() => setTextSnapshot(null)}
              onSendToComposer={onSendToComposer}
            />,
            document.body,
          )
        : null}
      <span className="sr-only" aria-live="polite">
        {transport === "reconnecting" ? "Terminal reconnecting" : ""}
      </span>
    </section>
  );
});
