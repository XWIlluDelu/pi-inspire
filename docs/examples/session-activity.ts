/**
 * Optional, read-only Pi activity reporter for Inspire.
 * Enable explicitly with: pi install /absolute/path/to/this/file.ts
 * No tools, prompts, UI changes, network access or session-file writes.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const ACTIVITY_HEARTBEAT_MS = 2_000;
export const ACTIVITY_STALE_MS = 8_000;

/** Independent of the launcher and Pi agent directory, shared by this OS user. */
export function piActivityDirectory(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const cache = process.env.LOCALAPPDATA || process.env.APPDATA;
    return join(
      cache && isAbsolute(cache) ? cache : join(home, "AppData", "Local"),
      "Inspire", "Cache", "pi-activity",
    );
  }
  if (process.platform === "darwin")
    return join(home, "Library", "Caches", "Inspire", "pi-activity");
  const cache = process.env.XDG_CACHE_HOME;
  return join(
    cache && isAbsolute(cache) ? cache : join(home, ".cache"),
    "inspire", "pi-activity",
  );
}

export interface PiActivityRecord {
  version: 1;
  pid: number;
  sessionId: string;
  sessionFile: string;
  activity: "working" | "blocked" | "idle";
  updatedAt: number;
}

export default function (pi: ExtensionAPI) {
  const file = join(piActivityDirectory(), `${process.pid}-${randomUUID()}.json`);
  const temporary = `${file}.tmp`;
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let waiting = false;
  let writes = Promise.resolve();

  const publish = (): Promise<void> => {
    if (!context) return writes;
    let record: PiActivityRecord | undefined;
    try {
      const sessionFile = context.sessionManager.getSessionFile();
      if (sessionFile) {
        record = {
          version: 1,
          pid: process.pid,
          sessionId: context.sessionManager.getSessionId(),
          sessionFile: resolve(context.cwd, sessionFile),
          activity: waiting
            ? "blocked"
            : running || !context.isIdle() ? "working" : "idle",
          updatedAt: Date.now(),
        };
      }
    } catch {
      // A retired runtime can no longer be queried. Shutdown removes its report.
      return writes;
    }
    // Serialize transitions with heartbeats. A delayed write must not resurrect
    // work after settlement, session replacement or shutdown.
    writes = writes.then(async () => {
      if (!record) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(piActivityDirectory(), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, file);
    }).catch(async () => {
      // Reporting failure must never fail a Pi turn.
      await rm(temporary, { force: true }).catch(() => {});
    });
    return writes;
  };

  const stop = async (): Promise<void> => {
    if (timer) clearInterval(timer);
    timer = undefined;
    context = undefined;
    running = false;
    waiting = false;
    await writes;
    await Promise.all([
      rm(file, { force: true }).catch(() => {}),
      rm(temporary, { force: true }).catch(() => {}),
    ]);
  };

  pi.on("session_start", async (_event, ctx) => {
    await stop();
    // Inspire already owns its RPC workers' state. Report terminal sessions,
    // regardless of terminal, launcher, process name, cwd or parent process.
    if (ctx.mode !== "tui") return;
    context = ctx;
    running = !ctx.isIdle();
    await publish();
    timer = setInterval(() => { void publish(); }, ACTIVITY_HEARTBEAT_MS);
    timer.unref();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!context) return;
    context = ctx;
    running = true;
    return publish();
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!context) return;
    context = ctx;
    running = true;
    return publish();
  });
  // agent_end is not final: retries, compaction and queued work may follow.
  pi.on("agent_settled", (_event, ctx) => {
    if (!context) return;
    context = ctx;
    running = false;
    return publish();
  });
  // Pi exposes aggregate blocking-prompt boundaries, including custom UI.
  pi.on("ui_prompt_start", () => {
    if (!context) return;
    waiting = true;
    return publish();
  });
  pi.on("ui_prompt_end", () => {
    if (!context) return;
    waiting = false;
    return publish();
  });
  pi.on("session_shutdown", stop);
}
