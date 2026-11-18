import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { openBrowser } from "../../server/browser-opener.mjs";

const url = "http://127.0.0.1:4587/#inspire-bootstrap=transfer";
function child() {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

it.each([
  ["darwin", "open", [url]],
  [
    "win32",
    "C:\\Windows\\System32\\rundll32.exe",
    ["url.dll,FileProtocolHandler", url],
  ],
] as const)(
  "passes the pairing URL as one argument on %s",
  async (platform, command, args) => {
    const opener = child();
    const spawn = vi.fn(() => opener);
    const result = openBrowser(url, platform, spawn, {
      systemroot: "C:\\Windows",
    });
    expect(spawn).toHaveBeenCalledWith(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    opener.emit("exit", 0, null);
    await result;
  },
);

it("tries gio when xdg-open is missing and reports a failed exit without the pairing URL", async () => {
  const spawn = vi.fn((command: string) => {
    const opener = child();
    queueMicrotask(() => {
      if (command === "xdg-open")
        opener.emit("error", Object.assign(new Error(), { code: "ENOENT" }));
      else opener.emit("exit", 3, null);
    });
    return opener;
  });
  await expect(openBrowser(url, "linux", spawn)).rejects.toMatchObject({
    code: "EXIT_3",
    message: "Desktop browser opener exited with status 3",
  });
  expect(spawn.mock.calls.map(([command]) => command)).toEqual([
    "xdg-open",
    "gio",
  ]);
});
