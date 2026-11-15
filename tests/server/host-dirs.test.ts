import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listHostDirectories, listHostRoots } from "../../server/host-dirs.js";
import * as hiddenAttributes from "../../server/host-hidden-dirs.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat) };
});

const execFile = promisify(execFileCallback);

describe("listHostRoots", () => {
  it("returns the single POSIX root", async () => {
    await expect(listHostRoots("linux")).resolves.toEqual({
      roots: [{ name: "/", path: "/" }],
    });
  });

  it("sorts assigned Windows drive names without probing disconnected drives", async () => {
    const enumerate = vi.fn(async () =>
      JSON.stringify(["Z:\\", "c:\\", "D:\\", "C:\\"]),
    );
    await expect(listHostRoots("win32", enumerate)).resolves.toEqual({
      roots: [
        { name: "C:", path: "C:\\" },
        { name: "D:", path: "D:\\" },
        { name: "Z:", path: "Z:\\" },
      ],
    });
    expect(enumerate).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([null, "C:\\", ["C:\\", "C:\\unsafe"], Array(27).fill("C:\\")])(
    "rejects malformed or oversized native drive lists: %j",
    async (paths) => {
      await expect(
        listHostRoots("win32", async () => JSON.stringify(paths)),
      ).rejects.toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "enumerates native drive names",
    async () => {
      const { roots } = await listHostRoots();
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) expect(root.path).toMatch(/^[A-Z]:\\$/u);
    },
    20_000,
  );
});

describe("listHostDirectories", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inspire-hostdirs-"));
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "notes.txt"), "not a directory");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("lists visible subdirectories sorted, with host-joined paths", async () => {
    const listing = await listHostDirectories(root);
    const resolved = await realpath(root);
    expect(listing.path).toBe(resolved);
    expect(listing.parent).toBe(dirname(resolved));
    expect(listing.dirs).toEqual([
      { name: "alpha", path: join(resolved, "alpha") },
      { name: "beta", path: join(resolved, "beta") },
    ]);
  });

  it("expands typed Host home paths before browsing their native directories", async () => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const physical = await realpath(root);
    expect((await listHostDirectories("~")).path).toBe(physical);
    expect((await listHostDirectories("~/alpha")).path).toBe(
      join(physical, "alpha"),
    );
    if (sep === "\\")
      expect((await listHostDirectories("~\\beta")).path).toBe(
        join(physical, "beta"),
      );
  });

  it("reveals dot directories only when requested, without including files", async () => {
    await writeFile(join(root, ".hidden-file"), "not a directory");
    const resolved = await realpath(root);
    expect((await listHostDirectories(root, true)).dirs).toEqual([
      { name: ".hidden", path: join(resolved, ".hidden") },
      { name: "alpha", path: join(resolved, "alpha") },
      { name: "beta", path: join(resolved, "beta") },
    ]);
    expect(
      (await listHostDirectories(root, false)).dirs.map((entry) => entry.name),
    ).toEqual(["alpha", "beta"]);
  });

  it("can enter a hidden path directly and still filter its hidden children", async () => {
    const path = join(root, ".hidden");
    await mkdir(join(path, "visible"));
    await mkdir(join(path, ".nested"));
    const listing = await listHostDirectories(path);
    expect(listing.path).toBe(await realpath(path));
    expect(listing.dirs.map((entry) => entry.name)).toEqual(["visible"]);
    expect(
      (await listHostDirectories(path, true)).dirs.map((entry) => entry.name),
    ).toEqual([".nested", "visible"]);
  });

  it("filters native hidden names independently of dot names", async () => {
    vi.spyOn(hiddenAttributes, "listNativeHiddenNames").mockResolvedValue(
      new Set(["alpha"]),
    );
    expect(
      (await listHostDirectories(root)).dirs.map((entry) => entry.name),
    ).toEqual(["beta"]);
    expect(
      (await listHostDirectories(root, true)).dirs.map((entry) => entry.name),
    ).toEqual([".hidden", "alpha", "beta"]);
  });

  it("filters native-hidden links before resolving their potentially offline targets", async () => {
    const link = join(root, "hidden-junction");
    await symlink(
      join(root, "alpha"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    vi.spyOn(hiddenAttributes, "listNativeHiddenNames").mockResolvedValue(
      new Set(["hidden-junction"]),
    );
    const physicalLink = join(await realpath(root), "hidden-junction");
    vi.mocked(stat).mockClear();
    expect(
      (await listHostDirectories(root)).dirs.map((entry) => entry.name),
    ).toEqual(["alpha", "beta"]);
    expect(
      vi.mocked(stat).mock.calls.some(([path]) => path === physicalLink),
    ).toBe(false);
    expect((await listHostDirectories(root, true)).dirs).toContainEqual({
      name: "hidden-junction",
      path: physicalLink,
    });
  });

  it("lets explicit show-hidden browsing recover from unavailable native inspection", async () => {
    vi.spyOn(hiddenAttributes, "listNativeHiddenNames").mockRejectedValue(
      new Error("Cannot read hidden-folder attributes on the host"),
    );
    await expect(listHostDirectories(root)).rejects.toThrow(
      "Cannot read hidden-folder attributes",
    );
    await expect(listHostDirectories(root, true)).resolves.toMatchObject({
      dirs: expect.arrayContaining([
        { name: ".hidden", path: join(await realpath(root), ".hidden") },
      ]),
    });
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "honors real native hidden attributes on this host",
    async () => {
      const path = join(root, "hidden by OS & 中文 [1]");
      await mkdir(path);
      const command =
        process.platform === "win32" ? "attrib.exe" : "/usr/bin/chflags";
      const set = process.platform === "win32" ? "+H" : "hidden";
      const clear = process.platform === "win32" ? "-H" : "nohidden";
      await execFile(command, [set, path]);
      try {
        expect(
          (await listHostDirectories(root)).dirs.map((entry) => entry.name),
        ).not.toContain("hidden by OS & 中文 [1]");
        expect(
          (await listHostDirectories(root, true)).dirs.map(
            (entry) => entry.name,
          ),
        ).toContain("hidden by OS & 中文 [1]");
        expect((await listHostDirectories(path)).path).toBe(
          await realpath(path),
        );
      } finally {
        await execFile(command, [clear, path]);
      }
    },
    30_000,
  );

  it("reveals dot-prefixed directory links without changing host path handling", async () => {
    await symlink(
      join(root, "alpha"),
      join(root, ".linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      (await listHostDirectories(root)).dirs.map((entry) => entry.name),
    ).not.toContain(".linked");
    expect((await listHostDirectories(root, true)).dirs).toContainEqual({
      name: ".linked",
      path: join(await realpath(root), ".linked"),
    });
    expect((await listHostDirectories(join(root, ".linked"), true)).path).toBe(
      await realpath(join(root, "alpha")),
    );
  });

  it.runIf(process.platform !== "win32")(
    "includes symlinks that resolve to directories and skips broken ones",
    async () => {
      await symlink(join(root, "alpha"), join(root, "linked"));
      await symlink(join(root, "vanished"), join(root, "broken"));
      const listing = await listHostDirectories(root);
      expect(listing.dirs.map((entry) => entry.name)).toEqual([
        "alpha",
        "beta",
        "linked",
      ]);
    },
  );

  it("defaults to the host home directory", async () => {
    const listing = await listHostDirectories();
    expect(listing.path).toBe(await realpath(homedir()));
  });

  it("reports a filesystem root with a null parent", async () => {
    const listing = await listHostDirectories("/");
    expect(listing.path).toBe(resolve("/"));
    expect(listing.parent).toBeNull();
  });

  it("rejects a missing directory", async () => {
    await expect(
      listHostDirectories(join(root, "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native hidden-folder attributes", () => {
  it("reads Windows Hidden names as a UTF-8 JSON array using a literal environment path", async () => {
    const path = "C:\\Users\\demo\\work [1]'; $(throw 'not code') & 中文";
    const run = vi.fn<
      NonNullable<Parameters<typeof hiddenAttributes.listNativeHiddenNames>[2]>
    >(async () => ({
      stdout: '\uFEFF["AppData","隐藏目录","line\\nbreak"]\r\n',
    }));
    await expect(
      hiddenAttributes.listNativeHiddenNames(path, "win32", run),
    ).resolves.toEqual(new Set(["AppData", "隐藏目录", "line\nbreak"]));
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toMatch(/\\pwsh\.exe$/u);
    expect(args.at(-1)).toContain(
      "-LiteralPath $env:INSPIRE_DIRECTORY_PATH -Force -Hidden",
    );
    expect(args.at(-1)).toContain("[Console]::OutputEncoding");
    expect(args.at(-1)).toContain("ConvertTo-Json -Compress -InputObject @(");
    expect(args.at(-1)).not.toContain(path);
    expect(options).toMatchObject({
      env: { INSPIRE_DIRECTORY_PATH: path },
      encoding: "utf8",
    });
  });

  it.each(['"AppData"', "[42]", "truncated"])(
    "rejects malformed Windows attribute output: %s",
    async (stdout) => {
      const run = vi.fn(async () => ({ stdout }));
      await expect(
        hiddenAttributes.listNativeHiddenNames("C:\\", "win32", run),
      ).rejects.toThrow("Cannot read hidden-folder attributes");
    },
  );

  it("reads macOS UF_HIDDEN with a bounded NUL-delimited, nonrecursive scan", async () => {
    const path = "/Users/demo/work [1] & 中文";
    const run = vi.fn(async () => ({
      stdout: `${path}/Library\0${path}/line\nbreak\0`,
    }));
    await expect(
      hiddenAttributes.listNativeHiddenNames(path, "darwin", run),
    ).resolves.toEqual(new Set(["Library", "line\nbreak"]));
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/find",
      [
        path,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-flags",
        "+hidden",
        "-print0",
      ],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it.each(["win32", "darwin"] as const)(
    "does not silently fail open if %s attribute inspection fails",
    async (platform) => {
      const cause = Object.assign(new Error("command unavailable"), {
        code: "ENOENT",
      });
      const run = vi.fn(async () => {
        throw cause;
      });
      await expect(
        hiddenAttributes.listNativeHiddenNames("/directory", platform, run),
      ).rejects.toMatchObject({
        message: "Cannot read hidden-folder attributes on the host",
        cause,
      });
    },
  );
});
