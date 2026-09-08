import {
  MAX_TOOL_ARGUMENT_DEPTH,
  MAX_TOOL_ARGUMENT_KEY_CHARS,
  MAX_TOOL_ARGUMENT_NODES,
  MAX_TOOL_ARGUMENT_PREVIEW_CHARS,
  type ToolArgumentPath,
  type ToolArgumentUpdate,
} from "../shared/tool-argument-updates.js";
import { isSensitiveProjectionKey } from "./safe-projection.js";

const MAX_SOURCE_CHARS = 256_000;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
type Expectation =
  | "keyOrEnd"
  | "key"
  | "colon"
  | "valueOrEnd"
  | "value"
  | "commaOrEnd";
interface Frame {
  kind: "object" | "array";
  path: ToolArgumentPath;
  hidden: boolean;
  expectation: Expectation;
  key: string;
  index: number;
}
interface Token {
  kind: "key" | "string" | "primitive";
  path: ToolArgumentPath;
  hidden: boolean;
  text: string;
  escape: boolean;
  unicode: string | null;
}

/** One-pass, bounded JSON preview projection. Incomplete tokens never become
 * executable arguments. Sensitive keyed values are discarded before producing
 * any update, including nested values and keys containing JSON escapes. No raw
 * source or cumulative JSON string is retained or sent to the browser. */
export class ToolArgumentStream {
  private frames: Frame[] = [];
  private token: Token | null = null;
  private started = false;
  private finished = false;
  private sourceChars = 0;
  private nodes = 0;
  private updates: ToolArgumentUpdate[] = [];
  characters = 0;
  truncated = false;

  private stop(): void {
    this.truncated = true;
    this.frames = [];
    this.token = null;
  }

  private emit(update: ToolArgumentUpdate): void {
    const last = this.updates.at(-1);
    if (last && last.path === update.path && "append" in update) {
      if ("append" in last) last.append += update.append;
      else if (typeof last.set === "string") last.set += update.append;
      else this.updates.push(update);
    } else this.updates.push(update);
  }

  private decoded(token: Token, text: string): void {
    if (token.kind === "key") {
      token.text += text;
      if (token.text.length > MAX_TOOL_ARGUMENT_KEY_CHARS) this.stop();
    } else if (!token.hidden) {
      const remaining = MAX_TOOL_ARGUMENT_PREVIEW_CHARS - this.characters;
      const visible = text.slice(0, remaining);
      if (visible) {
        this.characters += visible.length;
        this.emit({ path: token.path, append: visible });
      }
      if (visible.length < text.length) this.stop();
    }
  }

  private stringCharacter(char: string): void {
    const token = this.token!;
    if (token.unicode !== null) {
      if (!/^[0-9a-f]$/i.test(char)) return this.stop();
      token.unicode += char;
      if (token.unicode.length === 4) {
        const decoded = String.fromCharCode(Number.parseInt(token.unicode, 16));
        token.unicode = null;
        this.decoded(token, decoded);
      }
    } else if (token.escape) {
      token.escape = false;
      if (char === "u") token.unicode = "";
      else if (Object.hasOwn(ESCAPES, char))
        this.decoded(token, ESCAPES[char]!);
      else this.stop();
    } else if (char === "\\") token.escape = true;
    else if (char === '"') {
      if (token.kind === "key") {
        const frame = this.frames.at(-1)!;
        frame.key = token.text;
        frame.expectation = "colon";
      }
      this.token = null;
    } else if (char.charCodeAt(0) < 32) this.stop();
    else this.decoded(token, char);
  }

  private value(char: string, frame: Frame): void {
    if (++this.nodes > MAX_TOOL_ARGUMENT_NODES) return this.stop();
    const key = frame.kind === "array" ? frame.index++ : frame.key;
    const path = [...frame.path, key];
    if (path.length > MAX_TOOL_ARGUMENT_DEPTH) return this.stop();
    const hidden =
      frame.hidden ||
      (typeof key === "string" && isSensitiveProjectionKey(key));
    frame.expectation = "commaOrEnd";
    if (hidden && !frame.hidden) this.emit({ path, set: "[redacted]" });
    if (char === "{" || char === "[") {
      if (!hidden) this.emit({ path, set: char === "{" ? {} : [] });
      this.frames.push({
        kind: char === "{" ? "object" : "array",
        path,
        hidden,
        expectation: char === "{" ? "keyOrEnd" : "valueOrEnd",
        key: "",
        index: 0,
      });
    } else if (char === '"') {
      if (!hidden) this.emit({ path, set: "" });
      this.token = {
        kind: "string",
        path,
        hidden,
        text: "",
        escape: false,
        unicode: null,
      };
    } else if (/[-0-9tfn]/.test(char)) {
      this.token = {
        kind: "primitive",
        path,
        hidden,
        text: char,
        escape: false,
        unicode: null,
      };
    } else this.stop();
  }

  private structural(char: string): void {
    if (/^[\t\n\r ]$/.test(char)) return;
    if (this.finished) return this.stop();
    if (!this.started) {
      if (char !== "{") return this.stop();
      this.started = true;
      this.frames.push({
        kind: "object",
        path: [],
        hidden: false,
        expectation: "keyOrEnd",
        key: "",
        index: 0,
      });
      return;
    }
    const frame = this.frames.at(-1)!;
    if (char === "}" || char === "]") {
      const allowed =
        frame.kind === "object"
          ? char === "}" &&
            ["keyOrEnd", "commaOrEnd"].includes(frame.expectation)
          : char === "]" &&
            ["valueOrEnd", "commaOrEnd"].includes(frame.expectation);
      if (!allowed) return this.stop();
      this.frames.pop();
      if (this.frames.length === 0) this.finished = true;
    } else if (
      frame.expectation === "keyOrEnd" ||
      frame.expectation === "key"
    ) {
      if (char !== '"') return this.stop();
      this.token = {
        kind: "key",
        path: [],
        hidden: true,
        text: "",
        escape: false,
        unicode: null,
      };
    } else if (frame.expectation === "colon") {
      if (char !== ":") return this.stop();
      frame.expectation = "value";
    } else if (
      frame.expectation === "value" ||
      frame.expectation === "valueOrEnd"
    )
      this.value(char, frame);
    else if (char === ",")
      frame.expectation = frame.kind === "object" ? "key" : "value";
    else this.stop();
  }

  feed(delta: string): ToolArgumentUpdate[] {
    this.updates = [];
    for (let index = 0; index < delta.length && !this.truncated; index++) {
      if (++this.sourceChars > MAX_SOURCE_CHARS) {
        this.stop();
        break;
      }
      const char = delta[index]!;
      if (this.token?.kind === "primitive") {
        if (/^[\t\n\r ,}\]]$/.test(char)) {
          const token = this.token;
          this.token = null;
          try {
            const value: unknown = JSON.parse(token.text);
            if (
              value !== null &&
              typeof value !== "boolean" &&
              !(typeof value === "number" && Number.isFinite(value))
            )
              this.stop();
            else if (!token.hidden) this.emit({ path: token.path, set: value });
          } catch {
            this.stop();
          }
          if (!this.truncated) this.structural(char);
        } else {
          this.token.text += char;
          if (this.token.text.length > 128) this.stop();
        }
      } else if (this.token) this.stringCharacter(char);
      else this.structural(char);
    }
    return this.updates;
  }
}
