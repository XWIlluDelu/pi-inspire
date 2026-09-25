import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isBusyRunState } from "../shared/contracts.js";
import type {
  HerdrClient,
  HerdrPaneProcessInfo,
  HerdrSessionReference,
  HerdrWorkerPane,
  HerdrWorkerState,
} from "./herdr-client.js";
import { requestError } from "./request-error.js";
import type { RuntimeWorkerStatus } from "./runtime.js";

interface ObserverClient
  extends Pick<
    HerdrClient,
    "reportWorker" | "inspectSessions" | "inspectPaneProcess"
  > {}

interface HerdrWorkerObserverOptions {
  client: ObserverClient;
  onError?: (error: unknown) => void;
}

async function canonicalPath(value: string): Promise<string> {
  const path = resolve(value);
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
}

function nativePiReference(
  reference: HerdrSessionReference | null,
): reference is HerdrSessionReference {
  // Inspire's bridge reports a separate custom agent; it must never be
  // mistaken for an external native Pi TUI or Herdr's resumable Pi agent.
  return reference?.agent === "pi" && reference.source === "herdr:pi";
}

export interface HerdrWorkerProjection {
  update(status: RuntimeWorkerStatus): void;
  dispose(): Promise<void>;
}

/** Herdr receives only a display/state projection of an Inspire-owned RPC
 * worker. It is not a native Pi TUI and Herdr does not own its session writer.
 */
export class HerdrWorkerObserver {
  constructor(private readonly options: HerdrWorkerObserverOptions) {}

  observe(workerPane: () => HerdrWorkerPane | null): HerdrWorkerProjection {
    let active = true;
    let sequence = Date.now() * 1_000;
    let sessionId: string | undefined;
    let state: HerdrWorkerState = "idle";
    let published: {
      state: HerdrWorkerState;
      sessionId: string | undefined;
    } | null = null;
    let wanted = false;
    let draining: Promise<void> | null = null;
    const report = () => {
      if (!active) return;
      // Distinct Runtime run states can map to the same Herdr status. Skip
      // redundant reports, but retain changes during an in-flight report.
      if (
        !draining &&
        published?.state === state &&
        published.sessionId === sessionId
      )
        return;
      wanted = true;
      if (draining) return;
      draining = (async () => {
        while (active && wanted) {
          wanted = false;
          const pane = workerPane();
          if (!pane) continue;
          const next = { state, sessionId };
          if (
            published?.state === next.state &&
            published.sessionId === next.sessionId
          )
            continue;
          try {
            await this.options.client.reportWorker(pane, {
              state: next.state,
              seq: ++sequence,
              ...(next.sessionId ? { sessionId: next.sessionId } : {}),
            });
            published = next;
          } catch (error) {
            this.options.onError?.(error);
          }
        }
      })().finally(() => {
        draining = null;
        if (active && wanted) report();
      });
    };
    let disposed: Promise<void> | null = null;
    return {
      update(status) {
        sessionId = status.sessionId;
        state = status.needsInput
          ? "blocked"
          : isBusyRunState(status.runState)
            ? "working"
            : "idle";
        report();
      },
      dispose() {
        if (disposed) return disposed;
        active = false;
        wanted = false;
        // Retirement alone does not prove Pi exited. Leave the metadata until
        // the transport verifies process termination and closes its pane.
        disposed = draining ?? Promise.resolve();
        return disposed;
      },
    };
  }

  /** A native Pi reference or first-party RPC token is only a candidate.
   * Herdr's live foreground process must independently show Pi in that pane
   * and server incarnation; stale historical metadata cannot block a writer.
   */
  async assertWritable(
    sessionId: string | undefined,
    sessionFile: string,
  ): Promise<void> {
    if (!isAbsolute(sessionFile))
      throw new Error("Existing Pi session file must be an absolute path");
    const observed = await this.options.client.inspectSessions();
    if (!observed) return;
    const sessionPath = await canonicalPath(sessionFile);
    for (const pane of observed.panes) {
      const ref = pane.session;
      const native =
        pane.agent === "pi" &&
        nativePiReference(ref) &&
        (ref.kind === "id"
          ? Boolean(sessionId && ref.value === sessionId)
          : isAbsolute(ref.value) &&
            (await canonicalPath(ref.value)) === sessionPath);
      const inspire =
        pane.agent === "inspire-rpc" &&
        Boolean(sessionId && pane.inspireSessionId === sessionId);
      if (!native && !inspire) continue;
      const info = await this.options.client.inspectPaneProcess(
        observed.serverId,
        pane.paneId,
      );
      if (this.liveForegroundPi(info)) {
        throw requestError(
          "This Pi session is already running elsewhere. Stop that process before continuing it in Inspire",
          409,
          { code: "EXTERNAL_PI_WRITER_ACTIVE" },
        );
      }
    }
  }

  private liveForegroundPi(info: HerdrPaneProcessInfo): boolean {
    if (!info.foregroundProcessGroupId) return false;
    // Pi sets process.title='pi' and erases its original node/CLI argv, even
    // for RPC. The identity above comes from Herdr's native Pi report or the
    // separate Inspire reporter; this checks a current Pi process, not a name
    // or cwd guess used to discover sessions.
    return info.foregroundProcesses.some(
      (process) => process.name === "pi" && process.argv?.[0] === "pi",
    );
  }
}
