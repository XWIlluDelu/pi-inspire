import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processIdentity as piIdentity } from "../../extensions/attach-control.js";

const native = vi.hoisted(() => ({
  execFile: vi.fn(),
  files: new Set<string>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: native.execFile,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    statSync: (path: string) =>
      native.files.has(path) ? { isFile: () => true } : fs.statSync(path),
  };
});

const pid = 4321;
let hostIdentity: typeof import("../../server/instance-state.mjs").processStartIdentity;
beforeEach(async () => {
  vi.resetModules();
  native.execFile.mockReset();
  native.files.clear();
  ({ processStartIdentity: hostIdentity } = await import(
    "../../server/instance-state.mjs"
  ));
});
afterEach(() => vi.unstubAllGlobals());

function onPlatform(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) {
  vi.stubGlobal("process", { ...process, platform, pid, env });
}

function reply(value: string | Error) {
  native.execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, result?: object) => void,
    ) =>
      queueMicrotask(() => {
        if (typeof value === "string") callback(null, { stdout: value });
        else callback(value);
      }),
  );
}

describe("process birth identity", () => {
  it("retries a failed Host self lookup and shares its successful identity", async () => {
    onPlatform("win32", { programfiles: "D:\\Programs" });
    const failure = Object.assign(new Error("native lookup timeout"), {
      code: "ETIMEDOUT",
    });
    reply(failure);
    await expect(hostIdentity(pid)).rejects.toBe(failure);

    reply("303");
    expect(await Promise.all([hostIdentity(pid), hostIdentity(pid)])).toEqual([
      "win32:303",
      "win32:303",
    ]);
    expect(await hostIdentity(pid)).toBe("win32:303");
    expect(native.execFile).toHaveBeenCalledTimes(2);
    expect(native.execFile.mock.lastCall?.[0]).toBe(
      "D:\\Programs\\PowerShell\\7\\pwsh.exe",
    );
  });

  it("rechecks a foreign PID so a replacement process cannot inherit authority", async () => {
    onPlatform("win32");
    reply("101");
    reply("202");
    expect(await hostIdentity(pid + 1)).toBe("win32:101");
    expect(await hostIdentity(pid + 1)).toBe("win32:202");
  });

  it("uses the named PowerShell and reads UTC birth ticks for the Host and Pi", async () => {
    const command = "D:\\Power Shell;7\\pwsh.exe";
    onPlatform("win32", { Path: '"D:\\Power Shell;7";C:\\Windows' });
    native.files.add(command);
    for (const identify of [hostIdentity, piIdentity]) {
      reply("638900000000001234\r\n");
      expect(await identify(pid)).toBe("win32:638900000000001234");
      const [invoked, args] = native.execFile.mock.lastCall!;
      expect(invoked).toBe(command);
      expect(args.at(-1)).toContain(
        `GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`,
      );
    }
  });

  it("queries locale-stable macOS birth metadata for the Host and Pi", async () => {
    onPlatform("darwin", { LANG: "fr_FR.UTF-8" });
    const birth = "Mon Oct 19 12:34:56 2026";
    for (const identify of [hostIdentity, piIdentity]) {
      reply(`${birth}\n`);
      expect(await identify(pid)).toBe(`darwin:${birth}`);
      expect(native.execFile.mock.lastCall?.slice(0, 3)).toEqual([
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        expect.objectContaining({
          env: expect.objectContaining({ LANG: "C", LC_ALL: "C" }),
        }),
      ]);
    }
  });

  it("leaves unavailable Pi process metadata distinguishable from an exited process", async () => {
    onPlatform("win32");
    const failure = Object.assign(new Error("PowerShell unavailable"), {
      code: "ENOENT",
    });
    reply(failure);
    await expect(piIdentity(pid)).rejects.toBe(failure);
  });
});
