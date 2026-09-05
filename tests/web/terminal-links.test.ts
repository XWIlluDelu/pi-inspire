import xterm from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { terminalFileLinks } from "../../src/terminal-links";

describe("terminal file link cells", () => {
  it.each([
    ["中文 /tmp/a.txt", "/tmp/a.txt", 6, 15],
    ["中文 /tmp/目录.txt:12:3", "/tmp/目录.txt:12:3", 6, 23],
    ["e\u0301 /tmp/测\u0301试.txt", "/tmp/测\u0301试.txt", 3, 15],
    ["𐐀 /tmp/a.txt", "/tmp/a.txt", 3, 12],
  ] as const)(
    "maps %s through real xterm cells",
    async (output, reference, start, end) => {
      const terminal = new xterm.Terminal({
        cols: 80,
        rows: 24,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => terminal.write(output, resolve));
        const activate = vi.fn();
        const links = terminalFileLinks(
          terminal.buffer.active.getLine(0)!,
          1,
          activate,
        );
        expect(links).toHaveLength(1);
        expect(links[0]).toMatchObject({
          text: reference,
          range: { start: { x: start, y: 1 }, end: { x: end, y: 1 } },
          activate,
        });
      } finally {
        terminal.dispose();
      }
    },
  );
});
