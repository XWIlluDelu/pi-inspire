import { describe, expect, it } from "vitest";
import { terminalDirectoryFromUrl } from "../../server/terminal-paths.js";

describe("Host-native OSC 7 directory URLs", () => {
  it.each([
    ["win32", "file:///C:/Users/Jane%20Doe/repo", "C:\\Users\\Jane Doe\\repo"],
    [
      "win32",
      "file://DESKTOP/C:/Users/Jane%20Doe/repo",
      "C:\\Users\\Jane Doe\\repo",
    ],
    [
      "win32",
      "file://server/share/Jane%20Doe/repo",
      "\\\\server\\share\\Jane Doe\\repo",
    ],
    ["win32", "file://server/share/目录", "\\\\server\\share\\目录"],
    [
      "darwin",
      "file://workstation.local/Users/Jane%20Doe/repo",
      "/Users/Jane Doe/repo",
    ],
    ["linux", "file:///home/user/目录", "/home/user/目录"],
  ] as const)(
    "decodes %s %s without losing drive/share identity",
    (platform, value, expected) => {
      expect(terminalDirectoryFromUrl(value, platform)).toBe(expected);
    },
  );
  it.each([
    "https://example.invalid/workspace",
    "relative/path",
    "file:///tmp/a%2Fb",
  ])("refuses non-file or malformed directory metadata: %s", (value) => {
    expect(() => terminalDirectoryFromUrl(value, "linux")).toThrow();
  });
});
