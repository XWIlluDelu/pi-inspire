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

describe("POSIX spelling/normalization identity contracts (not native APFS evidence)", () => {
  it("keeps canonical prefixes on a zero-I/O path", async () => {
    expect(
      await filesystemRelativePath("/Project", "/Project/deep/file.txt"),
    ).toBe("deep/file.txt");
    expect(native.stat).not.toHaveBeenCalled();
  });

  it.each([
    ["/Project", "/project/deep/file.txt", "/project", "deep/file.txt"],
    ["/Caf\u00e9", "/Cafe\u0301/deep/file.txt", "/Cafe\u0301", "deep/file.txt"],
    [
      "/\u00e9/Project",
      "/e\u0301/project/file.txt",
      "/e\u0301/project",
      "file.txt",
    ],
  ])(
    "accepts %s only with a matching live directory identity",
    async (base, path, ancestor, within) => {
      native.stat.mockResolvedValue(directory(7n));
      expect(await filesystemRelativePath(base, path)).toBe(within);
      expect(native.stat.mock.calls).toEqual([
        [base, { bigint: true }],
        [ancestor, { bigint: true }],
      ]);
    },
  );

  it.each([
    ["/Project", "/project/file.txt"],
    ["/Caf\u00e9", "/Cafe\u0301/file.txt"],
    // Unicode uppercase expands ß to SS: that is only a candidate filter,
    // not a promise that this volume equates the two directory names.
    ["/Stra\u00dfe", "/STRASSE/file.txt"],
  ])(
    "refuses Unicode/case candidates that are actually distinct: %s",
    async (base, path) => {
      native.stat
        .mockResolvedValueOnce(directory(7n))
        .mockResolvedValueOnce(directory(8n));
      expect(await filesystemRelativePath(base, path)).toBeNull();
    },
  );

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
