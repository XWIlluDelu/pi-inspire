import headless from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import {
  type TerminalCommandOutput,
  terminalCommandOutput,
} from "../../src/terminal-command-output";

type Terminal = InstanceType<typeof headless.Terminal>;
const terminals: Terminal[] = [];
const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

async function completedOutput(text: string, prefix = "", cols = 40) {
  const terminal = new headless.Terminal({
    allowProposedApi: true,
    cols,
    rows: 20,
    scrollback: 10,
  });
  terminals.push(terminal);
  await write(terminal, prefix);
  const start = terminal.registerMarker(0)!;
  const startColumn = terminal.buffer.active.cursorX;
  await write(terminal, text);
  const range: TerminalCommandOutput = {
    start,
    startColumn,
    end: terminal.registerMarker(0)!,
    endColumn: terminal.buffer.active.cursorX,
  };
  await write(terminal, "next$ ");
  return { terminal, range };
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe("last completed terminal output", () => {
  it("keeps the first output line and excludes the following prompt", async () => {
    const { terminal, range } = await completedOutput("first\r\nsecond\r\n");
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe(
      "first\nsecond",
    );
  });

  it("uses cell columns when output shares a line with surrounding text", async () => {
    const { terminal, range } = await completedOutput(
      "中文 result",
      "before> ",
    );
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe(
      "中文 result",
    );
  });

  it("joins soft wraps without losing Unicode or spaces at the boundary", async () => {
    const text = "hello  中文 e\u0301 🙂 1234567890 ".repeat(3);
    const { terminal, range } = await completedOutput(text, "", 16);
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe(
      text.trimEnd(),
    );
  });

  it("copies rendered text without ANSI escapes", async () => {
    const { terminal, range } = await completedOutput(
      "\u001b[31mred\u001b[0m\r\n",
    );
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe("red");
  });

  it("retains normal-buffer output while a subsequent TUI uses the alternate screen", async () => {
    const { terminal, range } = await completedOutput("shell output\r\n");
    await write(terminal, "\u001b[?1049hTUI content");
    expect(terminal.buffer.active).not.toBe(terminal.buffer.normal);
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe(
      "shell output",
    );
  });

  it("refuses a range whose start was evicted", async () => {
    const { terminal, range } = await completedOutput("old output\r\n");
    await write(terminal, "later\r\n".repeat(40));
    expect(range.start.isDisposed).toBe(true);
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBeNull();
  });

  it("refuses an explicitly retired output range", async () => {
    const { terminal, range } = await completedOutput("old output\r\n");
    range.start.dispose();
    range.end.dispose();
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBeNull();
  });
});
