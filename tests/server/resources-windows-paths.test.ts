import { describe, expect, it, vi } from "vitest";

// Exercise the real reference parser with Node's Windows path/URL algorithms
// even on Linux; native filesystem serving remains covered by resources.test.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, ...actual.win32 };
});
vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return {
    ...actual,
    fileURLToPath: (url: string | URL) =>
      actual.fileURLToPath(url, { windows: true }),
  };
});

import { referencePath } from "../../server/resources.js";

describe("Windows resource URI paths", () => {
  it.each([
    [
      "vscode://file/c:/myProject/package.json:5:10",
      "c:\\myProject\\package.json",
    ],
    [
      "vscode://file/C:/my%20Project/my%20file.ts:12:3",
      "C:\\my Project\\my file.ts",
    ],
    ["vscode://file/C:/my%20Project/file.ts#L12", "C:\\my Project\\file.ts"],
    ["file:///C:/my%20Project/file.ts:12:3", "C:\\my Project\\file.ts"],
  ])("resolves %s without duplicating the drive", (reference, expected) => {
    expect(referencePath(reference, "C:\\host")).toBe(expected);
  });
});
