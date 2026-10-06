import { open, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopHerdrProcessGroup } from "../../server/herdr-process-group.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: vi.fn(),
  readFile: vi.fn(),
}));

const scope = { path: "/sys/fs/cgroup/owned.scope", device: "1", inode: "2" };
const group = { pid: 12345, birth: "1", boot: "test-boot", scope };
const directory = {
  fd: 77,
  stat: vi.fn(async () => ({ dev: 1n, ino: 2n })),
  close: vi.fn(),
};

beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(readFile).mockReset();
  directory.stat.mockClear();
  directory.close.mockClear();
});

describe.skipIf(process.platform !== "linux")("Herdr scope retirement", () => {
  it.each(
    ["open", "inspect", "kill"].flatMap((phase) =>
      ["ENOENT", "ENODEV"].map((code) => ({ phase, code })),
    ),
  )("accepts kernel removal during $phase ($code)", async ({ phase, code }) => {
    const removed = Object.assign(new Error("Scope was removed"), { code });
    const killer = {
      write: vi.fn().mockRejectedValue(removed),
      close: vi.fn(),
    };
    vi.mocked(open).mockImplementation(async (path) => {
      if (path === scope.path) {
        if (phase === "open") throw removed;
        return directory as unknown as Awaited<ReturnType<typeof open>>;
      }
      expect(path).toBe("/proc/self/fd/77/cgroup.kill");
      return killer as unknown as Awaited<ReturnType<typeof open>>;
    });
    let inspected = false;
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === "/proc/sys/kernel/random/boot_id") return "test-boot";
      expect(path).toBe("/proc/self/fd/77/cgroup.events");
      if (phase === "kill" && !inspected) {
        inspected = true;
        return "populated 1\n";
      }
      throw removed;
    });

    await expect(
      stopHerdrProcessGroup(group, false, () => {}),
    ).resolves.toBeUndefined();
    expect(directory.close).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
    if (phase === "kill") {
      expect(killer.write).toHaveBeenCalledWith("1");
      expect(killer.close).toHaveBeenCalledOnce();
    }
  });

  it("retains the stop failure when scope inspection cannot prove retirement", async () => {
    const failure = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    vi.mocked(open).mockResolvedValue(
      directory as unknown as Awaited<ReturnType<typeof open>>,
    );
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path === "/proc/sys/kernel/random/boot_id") return "test-boot";
      throw failure;
    });

    await expect(stopHerdrProcessGroup(group, false, () => {})).rejects.toBe(
      failure,
    );
    expect(directory.close).toHaveBeenCalledOnce();
  });
});
