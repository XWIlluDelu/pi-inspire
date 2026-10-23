import { ApiError } from "./api";

/** Bounded timing only: callers must own and authorize each retry. */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export function isTransientFailure(error: unknown): boolean {
  return (
    !(error instanceof ApiError) ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  );
}

export class RecoveryBackoff {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private cancelWait: (() => void) | null = null;

  /** Keep a read's promise and loading/viewport ownership through backoff.
   * Cancellation settles the wait; the caller still authorizes every attempt. */
  wait(signal: AbortSignal): Promise<boolean> {
    this.cancel();
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const abort = () => this.cancel();
      const finish = (retry: boolean) => {
        signal.removeEventListener("abort", abort);
        this.cancelWait = null;
        resolve(retry);
      };
      this.cancelWait = () => finish(false);
      signal.addEventListener("abort", abort, { once: true });
      if (!this.schedule(() => finish(true))) finish(false);
    });
  }

  schedule(read: () => void): boolean {
    if (this.timer !== null) return true;
    const delay = RETRY_DELAYS_MS[this.attempt];
    if (delay === undefined) return false;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      read();
    }, delay);
    return true;
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const cancelWait = this.cancelWait;
    this.cancelWait = null;
    cancelWait?.();
  }

  reset(): void {
    this.cancel();
    this.attempt = 0;
  }
}
