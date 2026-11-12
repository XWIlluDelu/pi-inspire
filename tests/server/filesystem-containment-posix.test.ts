import { beforeEach, describe, expect, it, vi } from "vitest";

// POSIX path syntax does not establish the filesystem's actual case or Unicode
// equivalence. These identity contracts run independently of the host volume.
const native = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, ...actual.posix };
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

describe("POSIX directory alias identity", () => {
  it("returns a path relative to its exact base", async () => {
    native.stat.mockResolvedValue(directory(7n));
    expect(
      await filesystemRelativePath("/Project", "/Project/deep/file.txt"),
    ).toBe("deep/file.txt");
  });

  it("accepts a case and normalization alias only through its matching ancestor", async () => {
    const root = "/\u00e9/Project";
    const ancestor = "/e\u0301/project";
    native.stat.mockImplementation(async (path) =>
      directory(path === root || path === ancestor ? 7n : 8n),
    );
    expect(
      await filesystemRelativePath(root, `${ancestor}/deep/file.txt`),
    ).toBe("deep/file.txt");
  });

  it("refuses visually related directories with different inodes", async () => {
    native.stat
      .mockResolvedValueOnce(directory(7n))
      .mockResolvedValueOnce(directory(8n));
    expect(
      await filesystemRelativePath("/Stra\u00dfe", "/STRASSE/file.txt"),
    ).toBeNull();
  });

  it("rejects unrelated segments or ancestors without any filesystem probe", async () => {
    expect(
      await filesystemRelativePath("/Project", "/private/file.txt"),
    ).toBeNull();
    expect(
      await filesystemRelativePath("/one/Project", "/two/project/file.txt"),
    ).toBeNull();
    expect(
      await filesystemRelativePath("/Project/deep", "/project"),
    ).toBeNull();
    expect(native.stat).not.toHaveBeenCalled();
  });

  it("does not let a normalization candidate bypass an unavailable identity", async () => {
    native.stat.mockRejectedValue(
      Object.assign(new Error("offline"), { code: "EACCES" }),
    );
    expect(
      await filesystemRelativePath("/Caf\u00e9", "/Cafe\u0301/file.txt"),
    ).toBeNull();
  });
});
