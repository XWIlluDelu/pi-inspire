import { ApiError } from "./api";

/** Bounded recovery: callers must own and authorize each retry. */
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

  /** Repeat an authorized read within this recovery budget. The caller owns
   * publication and error feedback; writes never enter this loop. */
  async read<T>(
    perform: () => Promise<T>,
    signal: AbortSignal,
    owns: () => boolean,
  ): Promise<T> {
    while (!signal.aborted && owns()) {
      try {
        return await perform();
      } catch (error) {
        if (
          signal.aborted ||
          !owns() ||
          !isTransientFailure(error) ||
          !(await this.wait(signal))
        )
          throw error;
      }
    }
    throw new DOMException("The read is no longer current", "AbortError");
  }

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

/** One cancellable owner. Each read starts a fresh retry budget. */
export function recoverableRead(owns: () => boolean) {
  const controller = new AbortController();
  const { signal } = controller;
  return {
    current: () => !signal.aborted && owns(),
    abort: () => controller.abort(),
    read: <T>(perform: (signal: AbortSignal) => Promise<T>) =>
      new RecoveryBackoff().read(() => perform(signal), signal, owns),
  };
}
