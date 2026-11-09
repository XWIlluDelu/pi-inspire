import { isBusyRunState } from "../shared/contracts.js";
import type {
  HerdrClient,
  HerdrWorkerPane,
  HerdrWorkerState,
} from "./herdr-client.js";
import type { RuntimeWorkerStatus } from "./runtime.js";

interface ObserverClient extends Pick<HerdrClient, "reportWorker"> {}

interface HerdrWorkerObserverOptions {
  client: ObserverClient;
  onError?: (error: unknown) => void;
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
}
