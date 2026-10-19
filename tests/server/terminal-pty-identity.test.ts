import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalTreeInspector } from "../../server/terminal-process-tree.js";
import { trackedTerminalPty } from "../../server/terminal-pty.js";
import { FakePty } from "./fixtures/terminal-pty.js";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  native.spawn.mockReset();
});

function fixture(
  pid = 100,
  identity: TerminalTreeInspector["identity"] = vi.fn(
    async () => "windows-root-birth",
  ),
) {
  const pty = new FakePty(pid);
  const kill = vi.spyOn(pty, "kill");
  const inspector: TerminalTreeInspector = {
    identity,
    descendants: vi.fn(async () => []),
    signal: vi.fn(),
  };
  const wrapper = trackedTerminalPty(pty, {}, "win32", inspector);
  return { pty, kill, inspector, wrapper };
}

describe("native Windows PTY authority contract (no native Windows execution)", () => {
  it("never calls taskkill or native PID kill after observed exit", async () => {
    const f = fixture();
    f.pty.emitExit(0);
    await f.wrapper.killTree!("SIGKILL");
    f.wrapper.kill("SIGKILL");
    expect(native.spawn).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("validates startup birth even if the late onExit still says running", async () => {
    const f = fixture();
    await Promise.resolve();
    vi.mocked(f.inspector.identity).mockResolvedValue("reused-pid-birth");
    await f.wrapper.killTree!("SIGKILL");
    expect(native.spawn).not.toHaveBeenCalled();
    expect(f.kill.mock.calls).toEqual([[]]);
  });

  it("closes only native ConPTY when identity cannot be proven", async () => {
    const f = fixture();
    await Promise.resolve();
    vi.mocked(f.inspector.identity).mockRejectedValueOnce(
      new Error("native query failed"),
    );
    await f.wrapper.killTree!("SIGKILL");
    expect(native.spawn).not.toHaveBeenCalled();
    expect(f.kill.mock.calls).toEqual([[]]);
  });

  it("cancels numeric tree work when exit arrives during verification", async () => {
    const f = fixture();
    await Promise.resolve();
    vi.mocked(f.inspector.identity).mockImplementationOnce(async () => {
      f.pty.emitExit(0);
      return "windows-root-birth";
    });
    await f.wrapper.killTree!("SIGKILL");
    expect(native.spawn).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
  });

  it("captures delayed PID and only launches a tree command for the matching live birth", async () => {
    vi.useFakeTimers();
    const f = fixture(0);
    Object.defineProperty(f.pty, "pid", { value: 100 });
    await vi.advanceTimersByTimeAsync(10);
    native.spawn.mockImplementation(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => {
        f.pty.emitExit(0);
        killer.emit("close", 0);
      });
      return killer;
    });
    await f.wrapper.killTree!("SIGKILL");
    expect(f.inspector.identity).toHaveBeenCalledWith(
      100,
      expect.any(AbortSignal),
    );
    expect(native.spawn.mock.calls[0]![1]).toEqual(["/pid", "100", "/T", "/F"]);
    expect(f.kill).not.toHaveBeenCalled();
    await f.wrapper.killTree!("SIGKILL");
    expect(native.spawn).toHaveBeenCalledTimes(1);
  });

  it("queues native close before asynchronous PID assignment, without querying PID zero", async () => {
    const f = fixture(0);
    await f.wrapper.killTree!("SIGHUP");
    expect(f.inspector.identity).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();
    expect(f.kill.mock.calls).toEqual([[]]);
  });

  it("does not wait for pending startup birth and discards its late result after native close", async () => {
    let finish!: (birth: string) => void;
    let observed: AbortSignal | undefined;
    const identity = vi.fn((_pid: number, signal?: AbortSignal) => {
      observed = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const f = fixture(100, identity);
    f.kill.mockImplementation(() => {});
    await f.wrapper.killTree!("SIGHUP");
    expect(f.kill.mock.calls).toEqual([[]]);
    expect(observed!.aborted).toBe(true);
    expect(native.spawn).not.toHaveBeenCalled();
    finish("windows-root-birth");
    await Promise.resolve();
    await f.wrapper.killTree!("SIGKILL");
    expect(identity).toHaveBeenCalledTimes(1);
    expect(native.spawn).not.toHaveBeenCalled();
    expect(f.kill.mock.calls).toEqual([[], []]);
    f.pty.emitExit(0);
  });

  it("bounds slow verification, aborts it, and never authorizes a late match", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await Promise.resolve();
    f.kill.mockImplementation(() => {});
    let finish!: (birth: string) => void;
    let observed: AbortSignal | undefined;
    vi.mocked(f.inspector.identity).mockImplementationOnce((_pid, signal) => {
      observed = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const stopping = f.wrapper.killTree!("SIGKILL");
    await vi.advanceTimersByTimeAsync(999);
    expect(f.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(f.kill.mock.calls).toEqual([[]]);
    expect(observed!.aborted).toBe(true);
    finish("windows-root-birth");
    await Promise.resolve();
    expect(native.spawn).not.toHaveBeenCalled();
    await f.wrapper.killTree!("SIGKILL");
    expect(native.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.pty.emitExit(0);
  });

  it("gives taskkill only the remainder of the same one-second control window", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await Promise.resolve();
    vi.mocked(f.inspector.identity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("windows-root-birth"), 600);
        }),
    );
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    native.spawn.mockReturnValue(killer);
    const stopping = f.wrapper.killTree!("SIGKILL");
    await vi.advanceTimersByTimeAsync(999);
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(killer.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(killer.kill).toHaveBeenCalledTimes(1);
    expect(f.kill.mock.calls).toEqual([[]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never invokes native fallback after exit during a failed tree command", async () => {
    const f = fixture();
    await Promise.resolve();
    native.spawn.mockImplementation(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => {
        f.pty.emitExit(0);
        killer.emit("error", new Error("failed tree command"));
      });
      return killer;
    });
    await f.wrapper.killTree!("SIGKILL");
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(f.kill).not.toHaveBeenCalled();
  });
});
