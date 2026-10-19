import xterm from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import {
  terminalFileLinks,
  terminalFileReference,
} from "../../src/terminal-links";

describe("terminal file link cells", () => {
  it.each([
    [
      '"C:\\Users\\Jane Doe\\project\\file.ts:12:3"',
      "C:\\Users\\Jane Doe\\project\\file.ts:12:3",
      "C:\\Users\\Jane Doe\\project\\file.ts:12:3",
    ],
    [
      "'/Users/Jane Doe/project/file.ts:12:3'",
      "/Users/Jane Doe/project/file.ts:12:3",
      "/Users/Jane Doe/project/file.ts:12:3",
    ],
    [
      "C:\\Users\\Jane Doe\\project\\file.ts:12:3",
      "C:\\Users\\Jane Doe\\project\\file.ts:12:3",
      "C:\\Users\\Jane Doe\\project\\file.ts:12:3",
    ],
    [
      "/Users/Jane Doe/project/file.ts:12:3",
      "/Users/Jane Doe/project/file.ts:12:3",
      "/Users/Jane Doe/project/file.ts:12:3",
    ],
    [
      "/Users/Jane Doe/project/file.ts",
      "/Users/Jane Doe/project/file.ts",
      "/Users/Jane Doe/project/file.ts",
    ],
    [
      "'/Users/Jane Doe/file (draft).ts'",
      "/Users/Jane Doe/file (draft).ts",
      "/Users/Jane Doe/file (draft).ts",
    ],
    ["'src/my file.ts':12:3", "src/my file.ts:12:3", "src/my file.ts':12:3"],
    [
      '"C:\\目录\\带 空格\\file.ts":12',
      "C:\\目录\\带 空格\\file.ts:12",
      'C:\\目录\\带 空格\\file.ts":12',
    ],
    [
      '"file:///C:/Program%20Files/app.ts"',
      "file:///C:/Program%20Files/app.ts",
      "file:///C:/Program%20Files/app.ts",
    ],
    [
      "vscode://file/C:/Program%20Files/app.ts:12",
      "vscode://file/C:/Program%20Files/app.ts:12",
      "vscode://file/C:/Program%20Files/app.ts:12",
    ],
    ["file:///tmp/a.ts", "file:///tmp/a.ts", "file:///tmp/a.ts"],
    ['"src/file (draft).ts"', "src/file (draft).ts", "src/file (draft).ts"],
  ])(
    "keeps the complete quoted/URI filename in %s",
    async (output, reference, highlighted) => {
      const terminal = new xterm.Terminal({
        cols: 120,
        rows: 3,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) =>
          terminal.write("中文 " + output, resolve),
        );
        const line = terminal.buffer.active.getLine(0)!;
        const links = terminalFileLinks(line, 1, vi.fn());
        expect(links).toHaveLength(1);
        const link = links[0]!;
        expect(link.text).toBe(reference);
        expect(
          line.translateToString(
            false,
            link.range.start.x - 1,
            link.range.end.x,
          ),
        ).toBe(highlighted);
      } finally {
        terminal.dispose();
      }
    },
  );

  it("does not merge consecutive absolute paths into a filename containing both", async () => {
    const terminal = new xterm.Terminal({
      cols: 120,
      rows: 3,
      allowProposedApi: true,
    });
    try {
      await new Promise<void>((resolve) =>
        terminal.write(
          "C:\\Users\\Jane Doe\\a.ts:12 D:\\Other Files\\b.ts:20 /tmp/a.txt /tmp/b.txt",
          resolve,
        ),
      );
      expect(
        terminalFileLinks(terminal.buffer.active.getLine(0)!, 1, vi.fn()).map(
          (link) => link.text,
        ),
      ).toEqual([
        "C:\\Users\\Jane Doe\\a.ts:12",
        "D:\\Other Files\\b.ts:20",
        "/tmp/a.txt",
        "/tmp/b.txt",
      ]);
    } finally {
      terminal.dispose();
    }
  });

  it.each([
    '"https://example.invalid/file.ts"',
    "'javascript:file.ts'",
    '"example.com"',
    '"not a filename"',
  ])(
    "does not turn quoted external links/prose into a file reference: %s",
    async (output) => {
      const terminal = new xterm.Terminal({
        cols: 120,
        rows: 3,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => terminal.write(output, resolve));
        expect(
          terminalFileLinks(terminal.buffer.active.getLine(0)!, 1, vi.fn()),
        ).toEqual([]);
      } finally {
        terminal.dispose();
      }
    },
  );

  it.each([
    [
      "notes/my file.ts",
      "C:\\Users\\Jane Doe\\repo",
      "C:\\Users\\Jane%20Doe\\repo\\notes/my%20file.ts",
    ],
    [
      "notes/my file.ts",
      "/Users/Jane Doe/repo",
      "/Users/Jane%20Doe/repo/notes/my%20file.ts",
    ],
    ["~/notes.txt", "/project", "~/notes.txt"],
    [
      "file:///C:/Users/Jane%20Doe/file.ts",
      "C:\\repo",
      "file:///C:/Users/Jane%20Doe/file.ts",
    ],
    [
      "vscode://file/C:/Users/Jane%20Doe/file.ts",
      "/project",
      "vscode://file/C:/Users/Jane%20Doe/file.ts",
    ],
  ])(
    "resolves %s without changing Host-specific syntax",
    (reference, cwd, expected) => {
      expect(terminalFileReference(reference, cwd)).toBe(expected);
    },
  );

  it("encodes the terminal's literal cwd independently of a diagnostic location", () => {
    expect(terminalFileReference("report%20draft.ts:12", "/project/C#")).toBe(
      "/project/C%23/report%2520draft.ts:12",
    );
    expect(terminalFileReference("report%20draft.ts:12", "C:\\Users\\C#")).toBe(
      "C:\\Users\\C%23\\report%2520draft.ts:12",
    );
  });

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
