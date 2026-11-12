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
    child.emit("error", error);
    child.emit("exit", 1, null);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(spawn).toHaveBeenCalledWith(
      "xdg-open",
      ["http://127.0.0.1:4587"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports a nonzero opener exit without affecting the Host", () => {
    const child = new FakeChild();
    const onError = vi.fn();
    openBrowser(
      "http://127.0.0.1:4587/?token=launch-token",
      onError,
      "linux",
      () => child,
    );

    child.emit("exit", 3, null);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "EXIT_3" });
    expect(onError.mock.calls[0]?.[0].message).not.toContain("launch-token");
  });

  it("reports a synchronous spawn failure", () => {
    const error = new Error("invalid spawn options");
    const onError = vi.fn();
    openBrowser("http://127.0.0.1:4587", onError, "linux", () => {
      throw error;
    });
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("uses the native macOS opener", () => {
    const url = "http://127.0.0.1:4587";
    const spawn = vi.fn(() => new FakeChild());
    openBrowser(url, vi.fn(), "darwin", spawn, {});
    expect(spawn).toHaveBeenCalledWith("open", [url], expect.any(Object));
  });

  it("uses copied SystemRoot and forwards the complete URL as one argument", () => {
    const spawn = vi.fn<NonNullable<Parameters<typeof openBrowser>[3]>>(
      () => new FakeChild(),
    );
    const url = "http://127.0.0.1:4587/?token=value&next=files";
    openBrowser(url, vi.fn(), "win32", spawn, { systemroot: "C:\\Windows" });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      expect.any(Object),
    );
    expect(spawn.mock.calls[0]?.[2]?.shell).toBeFalsy();
  });
});
