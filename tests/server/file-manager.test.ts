import { describe, expect, it, vi } from "vitest";
import { showInFileManager } from "../../server/file-manager.js";

describe("desktop file manager integration", () => {
  it.each([false, true])(
    "uses a checked Linux %s request with an encoded path",
    async (directory) => {
      const run = vi.fn().mockResolvedValue({ stdout: "()", stderr: "" });
      await showInFileManager(
        "/tmp/file 'quoted', $(command); #%.txt",
        directory,
        {
          platform: "linux",
          environment: { WAYLAND_DISPLAY: "wayland-0" },
          run,
        },
      );
      const [command, args, options] = run.mock.calls[0]!;
      expect(command).toBe("gdbus");
      expect(args).toContain(
        `org.freedesktop.FileManager1.${directory ? "ShowFolders" : "ShowItems"}`,
      );
      expect(JSON.parse(args.at(-2))).toEqual([
        "file:///tmp/file%20'quoted',%20$(command);%20%23%25.txt",
      ]);
      expect(options).not.toHaveProperty("shell");
      expect(options.timeout).toBe(10_000);
    },
  );

  it("fails before spawning when Linux has no desktop", async () => {
    const run = vi.fn();
    await expect(
      showInFileManager("/tmp/file", false, {
        platform: "linux",
        environment: {},
        run,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "No desktop is available to show this item",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", 1])(
    "does not report success for a failed opener (%s)",
    async (code) => {
      const run = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("desktop failed"), { code }),
        );
      await expect(
        showInFileManager("/tmp/file", false, {
          platform: "linux",
          environment: { DISPLAY: ":0" },
          run,
        }),
      ).rejects.toMatchObject({ status: 503 });
    },
  );

  it.each([false, true])(
    "uses Finder reveal or directory open (%s)",
    async (directory) => {
      const run = vi.fn().mockResolvedValue({});
      const path = "/tmp/a $(command);.command";
      await showInFileManager(path, directory, { platform: "darwin", run });
      expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
        "/usr/bin/open",
        directory ? ["-a", "Finder", path] : ["-R", path],
      ]);
    },
  );

  it.each([false, true])(
    "passes Windows paths as data, with checked Shell selection (%s)",
    async (directory) => {
      const run = vi.fn().mockResolvedValue({});
      const path = "C:\\project\\foo', $(Start-Process calc).ps1";
      await showInFileManager(path, directory, {
        platform: "win32",
        environment: {},
        run,
      });
      const [command, args, options] = run.mock.calls[0]!;
      expect(command).toMatch(/pwsh\.exe$/u);
      expect(args).toContain("-STA");
      expect(args.at(-1)).not.toContain(path);
      expect(args.at(-1)).toContain(
        directory ? "Explore($env:INSPIRE_REVEAL_PATH)" : "ThrowExceptionForHR",
      );
      expect(options.env.INSPIRE_REVEAL_PATH).toBe(path);
      expect(options).not.toHaveProperty("shell");
    },
  );

  it("reports unsupported operating systems explicitly", async () => {
    const run = vi.fn();
    await expect(
      showInFileManager("/tmp/file", false, { platform: "aix", run }),
    ).rejects.toMatchObject({ status: 501 });
    expect(run).not.toHaveBeenCalled();
  });
});
