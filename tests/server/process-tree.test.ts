import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalProcessTree } from "../../server/process-tree.mjs";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
beforeEach(() => {
  native.spawn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function child(exitCode: number | null = null) {
  return { pid: 4242, exitCode, signalCode: null, kill: vi.fn(() => true) };
}

describe("POSIX tracked process-group authority", () => {
  it("refuses a reaped child without issuing a signal to its former group", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const target of [
      child(0),
      { ...child(), signalCode: "SIGTERM" as const },
    ]) {
      await signalProcessTree(target, "SIGKILL", {
        platform: "linux",
        isolated: true,
      });
      expect(target.kill).not.toHaveBeenCalled();
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it("signals the owned live isolated group by its tracked PID", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const target = child();
    await signalProcessTree(target, "SIGTERM", {
      platform: "darwin",
      isolated: true,
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(-target.pid, "SIGTERM");
    expect(target.kill).not.toHaveBeenCalled();
  });

  it("falls back to the tracked child when its live group cannot be signalled", async () => {
    const target = child();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("group missing");
    });
    await signalProcessTree(target, "SIGKILL", {
      platform: "linux",
      isolated: true,
    });
    expect(target.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });
});

describe("Windows process tree ownership and command lookup", () => {
  it("signals the owned live tree using copied SystemRoot", async () => {
    native.spawn.mockImplementation(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit("close", 0));
      return killer;
    });
    const target = child();
    await signalProcessTree(target, "SIGKILL", {
      platform: "win32",
      environment: { systemroot: "native-windows-root" },
    });
    expect(native.spawn).toHaveBeenCalledWith(
      join("native-windows-root", "System32", "taskkill.exe"),
      ["/pid", "4242", "/T", "/F"],
      expect.not.objectContaining({ shell: expect.anything() }),
    );
    expect(target.kill).not.toHaveBeenCalled();
  });

  it("never sends a stale child's reusable PID to taskkill", async () => {
    const target = child(0);
    await signalProcessTree(target, "SIGKILL", { platform: "win32" });
    expect(native.spawn).not.toHaveBeenCalled();
    expect(target.kill).not.toHaveBeenCalled();
  });

  it("observes a failed tree command and falls back only to its tracked child handle", async () => {
    native.spawn.mockImplementation(() => {
      const killer = new EventEmitter();
      queueMicrotask(() =>
        killer.emit("error", new Error("unavailable taskkill")),
      );
      return killer;
    });
    const target = child();
    await signalProcessTree(target, "SIGTERM", { platform: "win32" });
    expect(target.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
});
