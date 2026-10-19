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

describe("Windows containment contracts (not native volume evidence)", () => {
  it.each([
    ["C:\\Project", "C:\\Project\\sub\\file.txt", "sub\\file.txt"],
    ["C:\\Project", "C:\\Project", ""],
    ["C:\\", "C:\\file.txt", "file.txt"],
    [
      "\\\\host\\share\\Project",
      "\\\\host\\share\\Project\\file.txt",
      "file.txt",
    ],
  ])(
    "keeps the exact native prefix fast path: %s",
    async (root, path, within) => {
      expect(await filesystemRelativePath(root, path)).toBe(within);
      expect(native.stat).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["C:\\Project", "C:\\Project-extra\\file.txt"],
    ["C:\\Project", "D:\\Project\\file.txt"],
    ["C:\\Project", "C:\\elsewhere\\file.txt"],
    ["\\\\host\\share\\Project", "\\\\other\\share\\Project\\file.txt"],
  ])(
    "rejects unrelated native paths without probing them: %s",
    async (root, path) => {
      expect(await filesystemRelativePath(root, path)).toBeNull();
      expect(native.stat).not.toHaveBeenCalled();
    },
  );

  it("proves only the base-level ancestor for a real spelling alias", async () => {
    native.stat.mockResolvedValue(directory(9n));
    expect(
      await filesystemRelativePath(
        "C:\\Project",
        "c:\\project\\a\\b\\file.txt",
      ),
    ).toBe("a\\b\\file.txt");
    expect(native.stat.mock.calls).toEqual([
      ["C:\\Project", { bigint: true }],
      ["c:\\project", { bigint: true }],
    ]);
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

  it("fails closed if alias identity cannot be read", async () => {
    native.stat.mockRejectedValue(
      Object.assign(new Error("offline"), { code: "EACCES" }),
    );
    expect(
      await filesystemRelativePath("C:\\Project", "C:\\project\\file.txt"),
    ).toBeNull();
  });
});
