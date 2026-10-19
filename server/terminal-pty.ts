import { signalProcessTree } from "./process-tree.mjs";
import {
  TerminalProcessTree,
  type TerminalTreeInspector,
  terminalTreeInspector,
} from "./terminal-process-tree.js";
import type { TerminalPty } from "./terminal-session-manager.js";

const WINDOWS_CONTROL_TIMEOUT_MS = 1_000;

/** Bind native exit observation before any caller can request cleanup. */
export function trackedTerminalPty(
  pty: TerminalPty,
  environment: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  inspector: TerminalTreeInspector = terminalTreeInspector,
): TerminalPty {
  let exited: { exitCode: number; signal?: number } | null = null;
  let nativeClosing = false;
  const inspections = new Set<AbortController>();
  const abortInspections = () => {
    for (const controller of inspections) controller.abort();
  };
  pty.onExit((event) => {
    exited = event;
    abortInspections();
  });
  const tree =
    platform === "win32"
      ? null
      : new TerminalProcessTree(pty.pid, () => exited !== null, inspector);

  // A pending startup lookup is never on the close path. Its late result must
  // not grant PID authority once native shutdown has begun.
  let windowsBirth: { pid: number; birth: string } | null = null;
  if (platform === "win32") {
    void (async () => {
      while (!exited && !nativeClosing && pty.pid === 0)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10).unref();
        });
      if (exited || nativeClosing) return;
      const pid = pty.pid;
      const controller = new AbortController();
      inspections.add(controller);
      try {
        const birth = await inspector.identity(pid, controller.signal);
        if (
          birth !== null &&
          !exited &&
          !nativeClosing &&
          !controller.signal.aborted
        )
          windowsBirth = { pid, birth };
      } catch {
        /* Unknown startup identity permits native close only. */
      } finally {
        inspections.delete(controller);
      }
    })();
  }

  const nativeKill = () => {
    nativeClosing = true;
    abortInspections();
    if (!exited) pty.kill(); // Native ConPTY instance, never a numeric PID.
    return true;
  };

  return {
    get pid() {
      return pty.pid;
    },
    get process() {
      return pty.process;
    },
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(listener),
    resize: (cols, rows) => pty.resize(cols, rows),
    write: (data) => pty.write(data),
    pause: () => pty.pause?.(),
    resume: () => pty.resume?.(),
    kill: (signal) => {
      if (platform === "win32") nativeKill();
      else if (!exited)
        void tree!
          .signal((signal ?? "SIGHUP") as NodeJS.Signals)
          .catch(() => {});
    },
    waitForTreeExit: tree
      ? (timeoutMs) => tree.waitForExit(timeoutMs)
      : undefined,
    async killTree(signal = "SIGHUP") {
      if (tree) return tree.signal(signal as NodeJS.Signals);
      if (exited) return;
      const expected = windowsBirth;
      if (pty.pid === 0 || nativeClosing || expected === null) {
        nativeKill();
        return;
      }
      const deadline = Date.now() + WINDOWS_CONTROL_TIMEOUT_MS;
      const controller = new AbortController();
      inspections.add(controller);
      let timer: NodeJS.Timeout | undefined;
      let matches = false;
      try {
        const current = await Promise.race([
          inspector.identity(expected.pid, controller.signal),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve(null);
            }, WINDOWS_CONTROL_TIMEOUT_MS);
          }),
        ]);
        matches =
          current === expected.birth &&
          pty.pid === expected.pid &&
          !controller.signal.aborted;
      } catch {
        /* Unknown/slow identity permits native close only. */
      } finally {
        clearTimeout(timer);
        inspections.delete(controller);
      }
      if (exited) return;
      const remaining = deadline - Date.now();
      if (!matches || nativeClosing || remaining <= 0) {
        nativeKill();
        return;
      }
      await signalProcessTree(
        {
          get pid() {
            return pty.pid;
          },
          get exitCode() {
            return exited?.exitCode ?? null;
          },
          get signalCode() {
            return exited?.signal ? ("SIGTERM" as const) : null;
          },
          kill: nativeKill,
        },
        signal as NodeJS.Signals,
        { environment, platform: "win32", timeoutMs: remaining },
      );
    },
  };
}
