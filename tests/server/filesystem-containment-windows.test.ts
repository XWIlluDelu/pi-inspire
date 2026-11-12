import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, ...actual.win32 };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  stat: native.stat,
}));

import { filesystemRelativePath } from "../../server/filesystem-containment.js";

function directory(ino: bigint, dev = 1n) {
  return { ino, dev, isDirectory: () => true };
}
beforeEach(() => {
  native.stat.mockReset();
});

describe("Windows path and directory alias identity", () => {
  it.each([
    ["C:\\", "C:\\file.txt", "file.txt"],
    [
      "\\\\host\\share\\Project",
      "\\\\host\\share\\Project\\file.txt",
      "file.txt",
    ],
  ])("returns a relative path within %s", async (root, path, within) => {
    native.stat.mockResolvedValue(directory(9n));
    expect(await filesystemRelativePath(root, path)).toBe(within);
  });

  it.each([
    ["C:\\Project", "D:\\Project\\file.txt"],
    ["\\\\host\\share\\Project", "\\\\other\\share\\Project\\file.txt"],
  ])(
    "rejects unrelated native paths without probing them: %s",
    async (root, path) => {
      expect(await filesystemRelativePath(root, path)).toBeNull();
      expect(native.stat).not.toHaveBeenCalled();
    },
  );

  it("accepts a real spelling alias through its matching ancestor", async () => {
    const root = "C:\\Project";
    const ancestor = "c:\\project";
    native.stat.mockImplementation(async (path) =>
      directory(path === root || path === ancestor ? 9n : 10n),
    );
    expect(
      await filesystemRelativePath(root, `${ancestor}\\a\\b\\file.txt`),
    ).toBe("a\\b\\file.txt");
  });

  it.each([
    [directory(9n), directory(10n)],
    [directory(9n, 1n), directory(9n, 2n)],
    [directory(0n), directory(0n)],
    [directory(9n), { ino: 9n, dev: 1n, isDirectory: () => false }],
  ])(
    "does not conflate distinct or unidentified base directories",
    async (first, second) => {
      native.stat.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      expect(
        await filesystemRelativePath("C:\\Project", "C:\\project\\file.txt"),
      ).toBeNull();
    },
  );
});
