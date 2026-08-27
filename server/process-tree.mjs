import { spawn } from "node:child_process";
import { join } from "node:path";

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(child, signal) {
  if (exited(child)) return;
  try {
    child.kill(signal);
  } catch {
    // The process may have exited after the final observation.
  }
}

async function signalWindowsTree(child, signal, environment, timeoutMs) {
  if (!child.pid) return true;
  const taskkill = environment.SystemRoot
    ? join(environment.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  const args = ["/pid", String(child.pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");

  return new Promise((resolveSignal) => {
    let settled = false;
    const killer = spawn(taskkill, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSignal(succeeded);
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Completion below selects the direct-child fallback.
      }
      finish(false);
    }, timeoutMs);
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

export function isolatedProcessOptions(platform = process.platform) {
  return {
    detached: platform !== "win32",
    windowsHide: true,
  };
}

/** Signal one child and its descendants. `isolated` must describe how that
 * child was spawned: POSIX group signalling is safe only for a process-group
 * leader created with isolatedProcessOptions(). Windows always uses taskkill's
 * explicit descendant-tree operation. */
export async function signalProcessTree(
  child,
  signal,
  suppliedOptions = {},
) {
  if (!child.pid) return;
  const platform = suppliedOptions.platform ?? process.platform;
  if (platform === "win32") {
    const signalled = await signalWindowsTree(
      child,
      signal,
      suppliedOptions.environment ?? process.env,
      suppliedOptions.timeoutMs ?? 5_000,
    ).catch(() => false);
    if (!signalled) signalChild(child, signal);
    return;
  }
  if (suppliedOptions.isolated) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      if (exited(child)) return;
    }
  }
  if (!exited(child)) signalChild(child, signal);
}
