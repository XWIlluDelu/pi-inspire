import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: native.execFile,
}));

let identity: typeof import("../../server/instance-state.mjs").processStartIdentity;
beforeEach(async () => {
  vi.resetModules();
  native.execFile.mockReset();
  // Import first: only the native lookup contract, not the module loader or
  // test runner, uses the simulated Windows process.
  ({ processStartIdentity: identity } = await import(
    "../../server/instance-state.mjs"
  ));
  vi.stubGlobal("process", {
    ...process,
    platform: "win32",
    pid: 4321,
    env: { programfiles: "C:\\Program Files" },
  });
});
afterEach(() => vi.unstubAllGlobals());

function reply(value: string) {
  native.execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, result?: object) => void,
    ) => {
      queueMicrotask(() => callback(null, { stdout: value }));
    },
  );
}

describe("process birth identity lookup authority", () => {
  it("shares concurrent and later self queries without starting another native process", async () => {
    reply("638900000000001234\r\n");
    expect(
      await Promise.all([identity(4321), identity(4321), identity(4321)]),
    ).toEqual([
      "win32:638900000000001234",
      "win32:638900000000001234",
      "win32:638900000000001234",
    ]);
    expect(await identity(4321)).toBe("win32:638900000000001234");
    expect(native.execFile).toHaveBeenCalledOnce();
    expect(native.execFile.mock.calls[0]![0]).toBe(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    );
    expect(native.execFile.mock.calls[0]![1].at(-1)).toBe(
      "[System.Diagnostics.Process]::GetProcessById(4321).StartTime.ToUniversalTime().Ticks",
    );
  });

  it("queries foreign PIDs again so a recycled process cannot inherit cached authority", async () => {
    reply("101");
    reply("202");
    expect(await identity(4322)).toBe("win32:101");
    expect(await identity(4322)).toBe("win32:202");
    expect(native.execFile).toHaveBeenCalledTimes(2);
  });

  it("does not turn a failed self lookup into a permanent cached identity or absence", async () => {
    native.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: object,
        callback: (error: Error) => void,
      ) =>
        queueMicrotask(() =>
          callback(
            Object.assign(new Error("native lookup timeout"), {
              code: "ETIMEDOUT",
            }),
          ),
        ),
    );
    await expect(identity(4321)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    reply("303");
    expect(await identity(4321)).toBe("win32:303");
    expect(native.execFile).toHaveBeenCalledTimes(2);
  });
});
