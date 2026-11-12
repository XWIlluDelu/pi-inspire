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
    "/private/var/folders/ab/123456789012345678901234567890/T",
    "/tmp/" + "目录".repeat(40),
  ])("bounds Darwin socket bytes with temporary root %s", (temporary) => {
    const paths = { platform: "darwin" as const, environment: {}, temporary };
    const address = defaultTerminalDaemonAddress(
      "/app",
      "127.0.0.1",
      4587,
      paths,
    );
    expect(Buffer.byteLength(address)).toBeLessThanOrEqual(103);
  });

  it("scopes Windows pipes to the account and the case-insensitive state directory", () => {
    const address = (local: string) =>
      defaultTerminalDaemonAddress(
        "C:\\Program Files\\Inspire",
        "127.0.0.1",
        4587,
        { platform: "win32", environment: { LOCALAPPDATA: local } },
      );
    const local = "C:\\Shared\\State";
    const alice = address(local);
    expect(alice).toBe(address(local.toLowerCase()));
    expect(alice).not.toBe(address("C:\\Users\\Alice\\AppData\\Local"));
    expect(alice.startsWith("\\\\.\\pipe\\inspire-terminal-")).toBe(true);
    const original = { ...account };
    try {
      account.username = "Bob";
      account.homedir = "C:\\Users\\Bob";
      expect(address(local)).not.toBe(alice);
    } finally {
      Object.assign(account, original);
    }
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
