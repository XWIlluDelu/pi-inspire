import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { signalProcessTree } from "./process-tree.mjs";

/** A writer fence, not a kill deadline. Signals and watchdogs cannot prove exit.
 * In particular, an `error` on an already spawned child may just be a failed kill.
 */
export async function stopPiRpcChild(
  child: ChildProcessWithoutNullStreams,
  graceful: boolean,
  diagnostic: (event: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  if (!child.pid) return; // spawn failed: there was never a writer
  const startedAt = Date.now();
  let onExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    onExit = resolve;
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  const signal = async (name: NodeJS.Signals) => {
    diagnostic("worker_stop_signal", { signal: name });
    try {
      await signalProcessTree(child, name, { isolated: true });
    } catch {
      // Failed signalling is not exit evidence. Keep waiting for the child.
      diagnostic("worker_stop_signal_failed", { signal: name });
    }
  };
  const watchdog = setInterval(() => {
    diagnostic("worker_stop_overdue", { elapsedMs: Date.now() - startedAt });
  }, 2_500);
  watchdog.unref();
  let escalation: NodeJS.Timeout | undefined;
  try {
    if (graceful && child.exitCode === null && child.signalCode === null) {
      const soft = signal("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          escalation = setTimeout(resolve, 1_500);
          escalation.unref();
        }),
      ]);
      if (escalation) clearTimeout(escalation);
      // Reap descendants even if their leader exited during the grace period.
      // Await both operations: Windows taskkill may take longer than escalation.
      await Promise.all([soft, signal("SIGKILL")]);
    } else {
      await signal("SIGKILL");
    }
    await exited;
  } finally {
    clearInterval(watchdog);
    if (escalation) clearTimeout(escalation);
    child.off("exit", onExit);
  }
}
