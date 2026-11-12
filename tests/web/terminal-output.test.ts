import headless from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import {
  type TerminalCommandOutput,
  terminalBufferText,
  terminalCommandOutput,
} from "../../src/terminal-output";

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
  it("keeps the command's lines and excludes the next prompt after row resize", async () => {
    const { terminal, range } = await completedOutput("first\r\nsecond\r\n");
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe(
      "first\nsecond",
    );
    terminal.resize(terminal.cols, 6);
    terminal.resize(terminal.cols, 28);
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

  it("refuses a range whose start was evicted", async () => {
    const { terminal, range } = await completedOutput("old output\r\n");
    await write(terminal, "later\r\n".repeat(40));
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBeNull();
  });

  it("copies rendered Unicode across soft wraps and distinguishes shell output from the alternate screen", async () => {
    const text = "hello  中文 e\u0301 🙂 1234567890 ".repeat(3);
    const { terminal, range } = await completedOutput(
      `\u001b[31m${text}\u001b[0m\r\n`,
      "",
      16,
    );
    expect(terminalBufferText(terminal.buffer.active)).toBe(`${text}\nnext$`);
    await write(terminal, "\u001b[?1049h\u001b[HTUI content");
    expect(terminalBufferText(terminal.buffer.active)).toBe("TUI content");
    expect(terminalCommandOutput(terminal.buffer.normal, range)).toBe(
      text.trimEnd(),
    );
  });
});
