import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import { launchTerminalDaemon } from "../../server/terminal-daemon-launcher.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly unref = vi.fn();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "term-launch-failure-"));
  return {
    root,
    host: "127.0.0.1",
    port: 4231,
    environment: {
      INSPIRE_TERMINAL_DAEMON_ADDRESS:
        process.platform === "win32"
          ? "\\\\.\\pipe\\inspire-launch-failure-" + randomUUID()
          : join(root, "ipc"),
      INSPIRE_TERMINAL_TOKEN_PATH: join(root, "token"),
      INSPIRE_TERMINAL_STATE_PATH: join(root, "state"),
      NOTIFY_SOCKET: "/host/notify",
      INVOCATION_ID: "host-incarnation",
      LISTEN_PID: "99",
    },
  };
}

it("observes detached spawn errors instead of emitting an uncaught process error", async () => {
  const options = await fixture();
  const probe = vi
    .spyOn(TerminalDaemonClient.prototype, "probe")
    .mockRejectedValue(new Error("No daemon"));
  vi.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild();
    queueMicrotask(() =>
      child.emit("error", new Error("Synthetic spawn failure")),
    );
    return child as unknown as ChildProcess;
  });
  try {
    await expect(launchTerminalDaemon(options)).rejects.toThrow(
      "Synthetic spawn failure",
    );
  } finally {
    probe.mockRestore();
    vi.mocked(spawn).mockReset();
    await rm(options.root, { recursive: true, force: true });
  }
});

it.runIf(process.platform === "linux")(
  "bounds a hung systemd handoff and strips Host service identity from fallback",
  async () => {
    const options = await fixture();
    const probe = vi
      .spyOn(TerminalDaemonClient.prototype, "probe")
      .mockRejectedValueOnce(new Error("No daemon"))
      .mockResolvedValue(undefined);
    const unit = new FakeChild();
    const detached = new FakeChild();
    let started!: () => void;
    const launching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(spawn).mockImplementation((command) => {
      if (command === "systemd-run") {
        started();
        return unit as unknown as ChildProcess;
      }
      queueMicrotask(() => detached.emit("spawn"));
      return detached as unknown as ChildProcess;
    });
    vi.useFakeTimers();
    try {
      const request = launchTerminalDaemon(options);
      await launching;
      await vi.advanceTimersByTimeAsync(2_000);
      const client = await request;
      await client.close();
      expect(unit.kill).toHaveBeenCalledWith("SIGKILL");
      const env = vi.mocked(spawn).mock.calls[1]?.[2]?.env;
      expect(env).not.toHaveProperty("NOTIFY_SOCKET");
      expect(env).not.toHaveProperty("INVOCATION_ID");
      expect(env).not.toHaveProperty("LISTEN_PID");
      expect(env?.INSPIRE_TERMINAL_STATE_PATH).toBe(
        options.environment.INSPIRE_TERMINAL_STATE_PATH,
      );
      expect(detached.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      probe.mockRestore();
      vi.mocked(spawn).mockReset();
      await rm(options.root, { recursive: true, force: true });
    }
  },
);
