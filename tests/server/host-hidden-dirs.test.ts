import { describe, expect, it, vi } from "vitest";
import { listNativeHiddenNames } from "../../server/host-hidden-dirs.js";

describe("native hidden-folder attributes", () => {
  it("does not spawn an attribute command on Linux", async () => {
    const run = vi.fn();
    await expect(
      listNativeHiddenNames("/home/demo", "linux", run),
    ).resolves.toEqual(new Set());
    expect(run).not.toHaveBeenCalled();
  });

  it("reads Windows Hidden names as a UTF-8 JSON array using a literal environment path", async () => {
    const path = "C:\\Users\\demo\\work [1]'; $(throw 'not code') & 中文";
    const run = vi.fn<NonNullable<Parameters<typeof listNativeHiddenNames>[2]>>(
      async () => ({
        stdout: '\uFEFF["AppData","隐藏目录","line\\nbreak"]\r\n',
      }),
    );
    await expect(listNativeHiddenNames(path, "win32", run)).resolves.toEqual(
      new Set(["AppData", "隐藏目录", "line\nbreak"]),
    );
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toMatch(
      /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/,
    );
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
    );
    expect(args.at(-1)).toContain(
      "-LiteralPath $env:INSPIRE_DIRECTORY_PATH -Force -Hidden",
    );
    expect(args.at(-1)).toContain("[Console]::OutputEncoding");
    expect(args.at(-1)).not.toContain(path);
    expect(options).toMatchObject({
      env: { INSPIRE_DIRECTORY_PATH: path },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
  });

  it.each(["[]", '["AppData"]'])(
    "accepts empty and singleton Windows arrays: %s",
    async (stdout) => {
      const run = vi.fn(async () => ({ stdout }));
      await expect(
        listNativeHiddenNames("C:\\", "win32", run),
      ).resolves.toEqual(new Set(JSON.parse(stdout)));
    },
  );

  it.each(['"AppData"', "null", "[42]", "truncated"])(
    "rejects malformed Windows attribute output: %s",
    async (stdout) => {
      const run = vi.fn(async () => ({ stdout }));
      await expect(listNativeHiddenNames("C:\\", "win32", run)).rejects.toThrow(
        "Cannot read hidden-folder attributes",
      );
    },
  );

  it("reads macOS UF_HIDDEN with a bounded NUL-delimited, nonrecursive scan", async () => {
    const path = "/Users/demo/work [1] & 中文";
    const run = vi.fn(async () => ({
      stdout: `${path}/Library\0${path}/line\nbreak\0`,
    }));
    await expect(listNativeHiddenNames(path, "darwin", run)).resolves.toEqual(
      new Set(["Library", "line\nbreak"]),
    );
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
      expect.objectContaining({ encoding: "utf8", timeout: 10_000 }),
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
        listNativeHiddenNames("/directory", platform, run),
      ).rejects.toMatchObject({
        message: "Cannot read hidden-folder attributes on the host",
        cause,
      });
    },
  );
});
