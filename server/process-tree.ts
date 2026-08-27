import { spawn } from "node:child_process";

interface ProcessTreeChild {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function usesIsolatedProcessGroup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

/** Best-effort whole-tree termination. POSIX workers own a process group;
 * Windows has no negative-PID equivalent, so taskkill is used for descendants
 * before the direct child fallback. */
export function terminateProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  if (platform === "win32" && child.pid) {
    const fallback = () => {
      try {
        child.kill(signal);
      } catch {
        // The close/error listener owns settlement after a raced process exit.
      }
    };
    try {
      const args = ["/pid", String(child.pid), "/T"];
      if (signal === "SIGKILL") args.push("/F");
      const killer = spawn("taskkill.exe", args, {
        windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      const failed = () => {
        if (settled) return;
        settled = true;
        fallback();
      };
      killer.once("error", failed);
      killer.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) fallback();
      });
      killer.unref();
      return;
    } catch {
      fallback();
      return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The close/error listener owns settlement after a raced process exit.
  }
}
