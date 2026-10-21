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

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => "C:\\Users\\Jane Doe",
}));

import { resolveUserPath } from "../../server/paths.js";
import { referencePath } from "../../server/resources.js";
import {
  collectSessionResourceReferences,
  fileResourceReference,
} from "../../shared/resource-references.js";

describe("Windows resource URI paths", () => {
  it.each([
    [
      "C:\\Users\\Jane Doe\\C#\\report%20draft.md",
      "C:\\Users\\Jane Doe\\C#\\report%20draft.md",
    ],
    [
      "\\\\nas\\Results Share\\C#\\report%20draft.md",
      "\\\\nas\\Results Share\\C#\\report%20draft.md",
    ],
    ["~\\C#\\report%20draft.md", "C:\\Users\\Jane Doe\\C#\\report%20draft.md"],
    ["C:\\C#\\literal.ts:12", "C:\\C#\\literal.ts:12"],
  ])(
    "round-trips literal native filename syntax through the link-form adapter: %s",
    (path, expected) => {
      const resources = collectSessionResourceReferences([
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: { path } }],
        },
      ]);
      expect(resources).toHaveLength(1);
      expect(resources[0]!.reference).toBe(fileResourceReference(path));
      expect(resources[0]!.label).toBe(path);
      expect(referencePath(resources[0]!.reference!, "C:\\host")).toBe(
        expected,
      );
    },
  );

  it.each([
    ["\\\\nas\\results\\ARTIFACT", "\\\\nas\\results\\ARTIFACT"],
    ["~\\ARTIFACT", "C:\\Users\\Jane Doe\\ARTIFACT"],
    [".\\ARTIFACT", "C:\\host\\ARTIFACT"],
  ])(
    "carries a native structured path from the index through Windows resolution: %s",
    (path, expected) => {
      const resources = collectSessionResourceReferences([
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "read", arguments: { path } }],
        },
      ]);
      expect(resources).toHaveLength(1);
      expect(referencePath(resources[0]!.reference!, "C:\\host")).toBe(
        expected,
      );
    },
  );

  it.each(["~/notes/file.ts", "~\\notes\\file.ts"])(
    "expands Host-native home syntax: %s",
    (reference) => {
      expect(referencePath(reference, "C:\\host")).toBe(
        "C:\\Users\\Jane Doe\\notes\\file.ts",
      );
      expect(resolveUserPath(reference, "C:\\host")).toBe(
        "C:\\Users\\Jane Doe\\notes\\file.ts",
      );
    },
  );

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
