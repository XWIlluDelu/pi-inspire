import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import { readScope, RecoveryBackoff } from "../../src/recovery-backoff";

afterEach(() => vi.useRealTimers());

it.each([503, 401, 403])(
  "applies backoff only to transient reads (HTTP %s)",
  async (status) => {
    vi.useFakeTimers();
    const failure = new ApiError(status, "read failed");
    const perform = vi.fn().mockRejectedValue(failure);
    const rejected = expect(
      readScope(() => true).read(perform, new RecoveryBackoff()),
    ).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(perform).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await rejected;
    if (status === 503) {
      expect(perform.mock.calls.length).toBeGreaterThan(1);
      expect(perform.mock.calls.length).toBeLessThanOrEqual(6);
    } else expect(perform).toHaveBeenCalledOnce();
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
