import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import type { IMarker, ITerminalAddon, Terminal } from "@xterm/xterm";

/** xterm cannot parse modern translucent CSS colors, even though canvas can.
 * Resolve the browser's color to unpremultiplied RGBA, not an opaque swatch. */
export function terminalSelectionColor(
  value: string,
  fallback: string,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export type TerminalSearchQuery = Pick<
  ISearchOptions,
  "caseSensitive" | "regex" | "wholeWord"
> & { query: string; open: boolean };

export function terminalSearchOptions(
  query: TerminalSearchQuery,
): ISearchOptions {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    caseSensitive: query.caseSensitive,
    regex: query.regex,
    wholeWord: query.wholeWord,
    decorations: {
      matchOverviewRuler: color("--terminal-search", "#e4b65a"),
      activeMatchColorOverviewRuler: color(
        "--terminal-search-active",
        "#ff781f",
      ),
      matchBackground: color("--terminal-search-bg", "#5b4a24"),
      activeMatchBackground: color("--terminal-search-active-bg", "#8a431d"),
    },
  };
}

/** Express word boundaries in the search pattern so an embedded partial word
 * cannot make xterm skip the other candidates on that line (notably in reverse).
 * Use its space/punctuation word separators, not JavaScript word boundaries. */
function searchRequest(term: string, options?: ISearchOptions) {
  if (!term || !options?.wholeWord) return { term, options };
  const separators = " ~!@#$%^&*()+`-=[]{}|\\;:\"',./<>?";
  const escapedSeparators = separators.replace(/[\\\]^-]/g, "\\$&");
  const pattern = options.regex
    ? term
    : term.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  return {
    term:
      "(?<![^" +
      escapedSeparators +
      "])(?:" +
      pattern +
      ")(?![^" +
      escapedSeparators +
      "])",
    // Keep the native whole-word check too: it sees context outside the
    // sliced search range when navigation begins inside a word.
    options: { ...options, regex: true },
  };
}

/** Search navigation may select and scroll; passive repainting must not.
 * Give the addon a public-API facade rather than touching xterm internals or
 * restoring selection afterward (which would destroy rectangular selections). */
export class TerminalSearchAddon implements ITerminalAddon {
  private readonly addon = new SearchAddon();
  readonly onDidChangeResults = this.addon.onDidChangeResults;
  private navigating = false;
  private match:
    | { marker: IMarker; column: number; length: number }
    | undefined;
  private colors: ISearchOptions["decorations"];
  private requestKey: string | undefined;

  activate(terminal: Terminal): void {
    const passivePosition = () => {
      if (!this.match || this.match.marker.isDisposed) return undefined;
      const start = {
        x: Math.min(this.match.column, terminal.cols - 1),
        y: this.match.marker.line,
      };
      const end = start.x + this.match.length;
      return {
        start,
        end: {
          x: end % terminal.cols,
          y: start.y + Math.floor(end / terminal.cols),
        },
      };
    };
    const selection: Pick<
      Terminal,
      "getSelectionPosition" | "clearSelection" | "select" | "scrollLines"
    > = {
      getSelectionPosition: () =>
        this.navigating ? terminal.getSelectionPosition() : passivePosition(),
      clearSelection: () => {
        if (this.navigating) terminal.clearSelection();
      },
      select: (column, row, length) => {
        this.match?.marker.dispose();
        const buffer = terminal.buffer.active;
        const marker = terminal.registerMarker(
          row - buffer.baseY - buffer.cursorY,
        );
        this.match = marker ? { marker, column, length } : undefined;
        if (this.navigating) terminal.select(column, row, length);
      },
      scrollLines: (lines) => {
        if (this.navigating) terminal.scrollLines(lines);
      },
    };
    // Only the search addon sees the facade. The terminal itself, its input,
    // other addons and callers retain their original methods and selection.
    this.addon.activate(
      new Proxy(terminal, {
        get(target, property) {
          if (Object.hasOwn(selection, property))
            return selection[property as keyof typeof selection];
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
  }

  findNext(term: string, options?: ISearchOptions): boolean {
    return this.navigate("findNext", term, options);
  }

  findPrevious(term: string, options?: ISearchOptions): boolean {
    return this.navigate("findPrevious", term, options);
  }

  private navigate(
    direction: "findNext" | "findPrevious",
    term: string,
    options?: ISearchOptions,
  ): boolean {
    this.colors = options?.decorations;
    this.navigating = true;
    try {
      const found = this.search(direction, term, options);
      if (!found) this.clearMatch();
      return found;
    } finally {
      this.navigating = false;
    }
  }

  private search(
    direction: "findNext" | "findPrevious",
    term: string,
    options?: ISearchOptions,
  ): boolean {
    const request = searchRequest(term, options);
    const key = JSON.stringify([
      request.term,
      !!request.options?.caseSensitive,
      !!request.options?.regex,
      !!request.options?.wholeWord,
    ]);
    // The addon does not reliably invalidate highlights for option-only changes.
    if (key !== this.requestKey) this.addon.clearDecorations();
    this.requestKey = key;
    return this.addon[direction](request.term, request.options);
  }

  refreshTheme(query: TerminalSearchQuery): void {
    if (!query.open || !query.query) return;
    const options = terminalSearchOptions(query);
    // Root style changes also include pane sizes. Do not rescan the buffer
    // unless search colors actually changed.
    if (JSON.stringify(this.colors) === JSON.stringify(options.decorations))
      return;
    this.colors = options.decorations;
    this.addon.clearDecorations();
    if (!this.search("findNext", query.query, options)) this.clearMatch();
  }

  clearDecorations(): void {
    this.addon.clearDecorations();
    this.clearMatch();
    this.colors = undefined;
    this.requestKey = undefined;
  }

  private clearMatch(): void {
    this.match?.marker.dispose();
    this.match = undefined;
  }

  dispose(): void {
    this.addon.dispose();
    this.clearMatch();
  }
}
