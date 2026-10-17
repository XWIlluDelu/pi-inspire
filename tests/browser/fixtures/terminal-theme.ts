import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  TerminalSearchAddon,
  terminalSearchOptions,
  terminalSelectionColor,
  type TerminalSearchQuery,
} from "../../../src/terminal-theme";

const terminal = new Terminal({ cols: 60, rows: 8, allowProposedApi: true });
const addon = new TerminalSearchAddon();
terminal.loadAddon(addon);
terminal.open(document.getElementById("terminal")!);
const decorations: Parameters<Terminal["registerDecoration"]>[0][] = [];
const register = terminal.registerDecoration.bind(terminal);
terminal.registerDecoration = (options) => {
  decorations.push(options);
  return register(options);
};
let result = { resultIndex: -1, resultCount: 0 };
addon.onDidChangeResults((value) => (result = value));
let query: TerminalSearchQuery = {
  open: true,
  query: "needle",
  caseSensitive: true,
  wholeWord: true,
  regex: false,
};
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const state = () => ({
  selection: terminal.getSelectionPosition(),
  text: terminal.getSelection(),
  viewport: terminal.buffer.active.viewportY,
  result,
  decorations: decorations.map(({ backgroundColor, overviewRulerOptions }) => ({
    backgroundColor,
    ruler: overviewRulerOptions?.color,
  })),
  options: terminalSearchOptions(query),
  selectionColor: terminal.options.theme?.selectionBackground,
  accent: css("--accent"),
});
const fixture = {
  async start() {
    await new Promise<void>((resolve) =>
      terminal.write(
        Array.from(
          { length: 24 },
          (_, i) => `row ${i}: needle NEEDLE needles\r\n`,
        ).join(""),
        resolve,
      ),
    );
    addon.findNext(query.query, terminalSearchOptions(query));
    addon.findNext(query.query, terminalSearchOptions(query));
    // Retain a deliberately different viewport, not just the searched row.
    terminal.scrollToLine(7);
    return state();
  },
  theme(palette: string, theme: string) {
    Object.assign(document.documentElement.dataset, { palette, theme });
    terminal.options.theme = {
      background: css("--terminal-bg"),
      foreground: css("--terminal-fg"),
      selectionBackground: terminalSelectionColor(
        css("--terminal-selection"),
        "#5b331f",
      ),
    };
    decorations.length = 0;
    addon.refreshTheme(query);
    return state();
  },
  state,
  options(next: Partial<TerminalSearchQuery>) {
    query = { ...query, ...next };
    addon.findNext(query.query, terminalSearchOptions(query));
    return state();
  },
  navigate(direction: "next" | "previous") {
    if (direction === "next")
      addon.findNext(query.query, terminalSearchOptions(query));
    else addon.findPrevious(query.query, terminalSearchOptions(query));
    return state();
  },
  layout() {
    document.documentElement.style.setProperty("--nav-w", "300px");
    decorations.length = 0;
    addon.refreshTheme(query);
    return state();
  },
  manualSelection(kind: "none" | "linear") {
    if (kind === "none") terminal.clearSelection();
    else terminal.select(0, 12, 6);
    return state();
  },
  async appendOutput(text = "another needle NEEDLE needles\r\n") {
    await new Promise<void>((resolve) => terminal.write(text, resolve));
  },
  close() {
    query = { ...query, open: false };
    addon.clearDecorations();
    terminal.clearSelection();
  },
  noMatch() {
    query = { ...query, open: true, query: "not present" };
    addon.findNext(query.query, terminalSearchOptions(query));
    return state();
  },
};
(
  window as unknown as { terminalThemeFixture: typeof fixture }
).terminalThemeFixture = fixture;
