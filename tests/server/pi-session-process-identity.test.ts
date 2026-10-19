import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  execFile: vi.fn(),
  files: new Set<string>(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: native.execFile,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    statSync: (path: string) =>
      native.files.has(String(path))
        ? { isFile: () => true }
        : fs.statSync(path),
  };
});
import { piActivityProcessIdentity } from "../../docs/examples/session-activity.js";

afterEach(() => {
  vi.unstubAllGlobals();
  native.execFile.mockReset();
  native.files.clear();
});
function reply(stdout: string) {
  native.execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: object,
      callback: (error: unknown, output: object) => void,
    ) => queueMicrotask(() => callback(null, { stdout })),
  );
}

it("reads locale-stable macOS process birth metadata", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  reply("Mon Oct 19 12:34:56 2026\n");
  expect(await piActivityProcessIdentity(4321)).toBe(
    "darwin:Mon Oct 19 12:34:56 2026",
  );
  expect(native.execFile.mock.calls[0]!.slice(0, 2)).toEqual([
    "/bin/ps",
    ["-p", "4321", "-o", "lstart="],
  ]);
  expect(native.execFile.mock.calls[0]![2]).toMatchObject({
    env: { LANG: "C", LC_ALL: "C" },
    timeout: 1500,
  });
});

it("uses current PowerShell on a named Windows PATH and queries birth rather than PID existence", async () => {
  vi.stubGlobal("process", {
    ...process,
    platform: "win32",
    env: {
      Path: '"D:\\Power Shell;7";C:\\Windows',
      ProgramFiles: "C:\\Program Files",
    },
  });
  native.files.add("D:\\Power Shell;7\\pwsh.exe");
  reply("638900000000001234\r\n");
  expect(await piActivityProcessIdentity(4321)).toBe(
    "win32:638900000000001234",
  );
  expect(native.execFile.mock.calls[0]![0]).toBe("D:\\Power Shell;7\\pwsh.exe");
  expect(native.execFile.mock.calls[0]![1].at(-1)).toBe(
    "[System.Diagnostics.Process]::GetProcessById(4321).StartTime.ToUniversalTime().Ticks",
  );
});

it("preserves a missing metadata executable as a lookup failure, not process retirement", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", env: {} });
  native.execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: object,
      callback: (error: Error) => void,
    ) =>
      queueMicrotask(() =>
        callback(
          Object.assign(new Error("PowerShell unavailable"), {
            code: "ENOENT",
          }),
        ),
      ),
  );
  await expect(piActivityProcessIdentity(4321)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
