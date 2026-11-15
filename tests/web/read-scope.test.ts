import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import { readScope, RecoveryBackoff } from "../../src/recovery-backoff";

afterEach(() => vi.useRealTimers());

it.each([
  [503, [0, 1_000, 4_000, 14_000]],
  [401, [0]],
  [403, [0]],
] as const)(
  "applies the shared read retry budget to HTTP %s",
  async (status, attempts) => {
    vi.useFakeTimers();
    const start = Date.now();
    const observed: number[] = [];
    const failure = new ApiError(status, "read failed");
    const scope = readScope(() => true);
    const rejected = expect(
      scope.read(async () => {
        observed.push(Date.now() - start);
        throw failure;
      }, new RecoveryBackoff()),
    ).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await rejected;
    expect(observed).toEqual(attempts);
  },
);

it.each(["parent", "scope"] as const)(
  "settles a paused read immediately when its %s cancels",
  async (owner) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const scope = readScope(() => true, parent.signal);
    const perform = vi.fn().mockRejectedValue(new ApiError(503, "temporary"));
    const rejected = expect(
      scope.read(perform, new RecoveryBackoff()),
    ).rejects.toThrow("temporary");
    await vi.advanceTimersByTimeAsync(0);
    if (owner === "parent") parent.abort();
    else scope.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(perform).toHaveBeenCalledOnce();
  },
);
