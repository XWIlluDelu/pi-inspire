import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchTerminalDaemon } from "../../server/terminal-daemon-launcher.js";

const { probe, launch } = vi.hoisted(() => ({
  probe: vi.fn(),
  launch: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: launch }));
vi.mock("../../server/terminal-daemon-client.js", () => ({
  TerminalDaemonClient: class {
    probe = probe;
  },
}));
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.runIf(process.platform === "linux")(
  "passes user exports through systemd without putting values on its command line",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-environment-"));
    directories.push(directory);
    const environment = {
      PATH: "/user/tools:/usr/bin:/bin",
      USER_EXPORT: "synthetic-private-value",
      NODE_ENV: "test",
      INVOCATION_ID: "host-invocation",
      NOTIFY_SOCKET: "/host/socket",
      INSPIRE_TERMINAL_DAEMON_ADDRESS: join(directory, "daemon.sock"),
      INSPIRE_TERMINAL_TOKEN_PATH: join(directory, "token"),
      INSPIRE_TERMINAL_STATE_PATH: join(directory, "state.json"),
    };
    probe
      .mockRejectedValueOnce(new Error("not started"))
      .mockResolvedValue(undefined);
    launch.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    await launchTerminalDaemon({
      root: directory,
      host: "127.0.0.1",
      port: 1234,
      environment,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = launch.mock.calls[0]!;
    expect(command).toBe("systemd-run");
    expect(args).toEqual(
      expect.arrayContaining([
        "--setenv=PATH",
        "--setenv=USER_EXPORT",
        "--setenv=NODE_ENV",
      ]),
    );
    expect(args.join(" ")).not.toContain("synthetic-private-value");
    expect(args).not.toContain("--setenv=INVOCATION_ID");
    expect(args).not.toContain("--setenv=NOTIFY_SOCKET");
    expect(options.env).toEqual(environment);
    expect(probe).toHaveBeenCalledTimes(2);
  },
);
