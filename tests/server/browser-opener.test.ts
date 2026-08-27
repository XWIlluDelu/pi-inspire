import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openBrowser } from "../../server/browser-opener.js";

class FakeChild extends EventEmitter {
  readonly unref = vi.fn();
}

describe("openBrowser", () => {
  it("observes an asynchronous missing-opener error without throwing", () => {
    const child = new FakeChild();
    const onError = vi.fn();
    const spawn = vi.fn(() => child);
    openBrowser("http://127.0.0.1:4587", onError, "linux", spawn);

    const error = Object.assign(new Error("spawn xdg-open ENOENT"), {
      code: "ENOENT",
    });
    expect(() => child.emit("error", error)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
    expect(spawn).toHaveBeenCalledWith("xdg-open", ["http://127.0.0.1:4587"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports a nonzero opener exit without affecting the Host", () => {
    const child = new FakeChild();
    const onError = vi.fn();
    openBrowser("http://127.0.0.1:4587", onError, "linux", () => child);

    child.emit("exit", 3, null);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "EXIT_3" });
    expect(onError.mock.calls[0]?.[0].message).not.toContain("127.0.0.1");
  });

  it("reports a synchronous spawn failure", () => {
    const error = new Error("invalid spawn options");
    const onError = vi.fn();
    openBrowser("http://127.0.0.1:4587", onError, "linux", () => {
      throw error;
    });
    expect(onError).toHaveBeenCalledWith(error);
  });

  it.each([
    ["darwin", "open", ["http://127.0.0.1:4587"]],
    [
      "win32",
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "http://127.0.0.1:4587"],
    ],
  ] as const)("uses the native %s opener", (platform, command, args) => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    openBrowser("http://127.0.0.1:4587", vi.fn(), platform, spawn, {});

    expect(spawn).toHaveBeenCalledWith(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("uses the system Windows opener without shell-interpreting the URL", () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const url = "http://127.0.0.1:4587/?token=value&next=calc.exe";
    openBrowser(url, vi.fn(), "win32", spawn, {
      SystemRoot: "C:\\Windows",
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  });
});
