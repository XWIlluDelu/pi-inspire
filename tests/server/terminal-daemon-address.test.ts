import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({
  username: "Alice",
  homedir: "C:\\Users\\Alice",
  uid: -1,
  gid: -1,
  shell: null,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  userInfo: () => account,
}));

import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import {
  defaultTerminalDaemonAddress,
  legacyTerminalDaemonAddress,
} from "../../server/terminal-daemon-protocol.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";

describe("native terminal IPC addresses", () => {
  it("keeps a short existing POSIX address stable", () => {
    const paths = {
      platform: "linux" as const,
      environment: { XDG_RUNTIME_DIR: "/run/user/1000" },
    };
    expect(defaultTerminalDaemonAddress("/app", "127.0.0.1", 4587, paths)).toBe(
      legacyTerminalDaemonAddress("/app", "127.0.0.1", 4587, paths),
    );
  });

  it.each([
    "/var/folders/ab/123456789012345678901234567890/T",
    "/private/var/folders/ab/123456789012345678901234567890/T",
    "/tmp/" + "目录".repeat(40),
  ])("bounds Darwin socket bytes with temporary root %s", (temporary) => {
    const paths = { platform: "darwin" as const, environment: {}, temporary };
    const legacy = legacyTerminalDaemonAddress(
      "/app",
      "127.0.0.1",
      4587,
      paths,
    );
    const address = defaultTerminalDaemonAddress(
      "/app",
      "127.0.0.1",
      4587,
      paths,
    );
    expect(Buffer.byteLength(legacy)).toBeGreaterThan(103);
    expect(Buffer.byteLength(address)).toBeLessThanOrEqual(103);
    expect(address).not.toBe(legacy);
  });

  it("scopes Windows machine-wide pipes to the current user state directory", () => {
    const address = (local: string) =>
      defaultTerminalDaemonAddress(
        "C:\\Program Files\\Inspire",
        "127.0.0.1",
        4587,
        { platform: "win32", environment: { LOCALAPPDATA: local } },
      );
    const alice = address("C:\\Users\\Alice\\AppData\\Local");
    expect(alice).toBe(address("c:\\users\\alice\\appdata\\local"));
    expect(alice).not.toBe(address("C:\\Users\\Bob\\AppData\\Local"));
    expect(alice.startsWith("\\\\.\\pipe\\inspire-terminal-")).toBe(true);
  });

  it("keeps OS accounts separate even when a shared state directory is explicitly configured", () => {
    const paths = {
      platform: "win32" as const,
      environment: { LOCALAPPDATA: "C:\\\\Shared\\\\State" },
    };
    const alice = defaultTerminalDaemonAddress(
      "C:\\\\Program Files\\\\Inspire",
      "127.0.0.1",
      4587,
      paths,
    );
    try {
      account.username = "Bob";
      account.homedir = "C:\\\\Users\\\\Bob";
      expect(
        defaultTerminalDaemonAddress(
          "C:\\\\Program Files\\\\Inspire",
          "127.0.0.1",
          4587,
          paths,
        ),
      ).not.toBe(alice);
    } finally {
      account.username = "Alice";
      account.homedir = "C:\\\\Users\\\\Alice";
    }
  });

  it("runs authenticated IPC at the actual default endpoint, including a long runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspire-default-ipc-"));
    const runtime = join(root, "目录".repeat(40));
    const address = defaultTerminalDaemonAddress(root, "127.0.0.1", 4587, {
      environment: { XDG_RUNTIME_DIR: runtime },
    });
    const manager = new TerminalSessionManager();
    const token = randomUUID();
    const owner = new TerminalDaemonServer(address, token, manager);
    const client = new TerminalDaemonClient(address, token);
    try {
      await owner.start();
      await client.probe();
      expect(await client.getSettings()).toMatchObject({
        persistOutput: false,
      });
      if (process.platform !== "win32") {
        expect(Buffer.byteLength(address)).toBeLessThanOrEqual(
          process.platform === "darwin" ? 103 : 107,
        );
      }
    } finally {
      await client.close();
      await owner.stop();
      await rm(root, { recursive: true, force: true });
    }
    // Only the fixture socket is removed; a shared per-user runtime directory
    // may contain independent terminals and is not this fixture's property.
  });

  it.skipIf(process.platform === "win32")(
    "rejects a shared parent instead of chmodding it or binding a socket",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-shared-ipc-"));
      const address = join(directory, "daemon.sock");
      const owner = new TerminalDaemonServer(
        address,
        "test",
        new TerminalSessionManager(),
      );
      try {
        await chmod(directory, 0o755);
        await expect(owner.start()).rejects.toThrow("use a private directory");
        expect((await lstat(directory)).mode & 0o777).toBe(0o755);
        await expect(lstat(address)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await owner.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an explicitly overlong socket path before binding",
    async () => {
      const manager = new TerminalSessionManager();
      const owner = new TerminalDaemonServer(
        "/tmp/" + randomUUID() + "x".repeat(120),
        "test",
        manager,
      );
      await expect(owner.start()).rejects.toThrow("socket path is too long");
      await owner.stop();
    },
  );
});
