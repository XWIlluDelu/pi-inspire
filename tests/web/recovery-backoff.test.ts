import { afterEach, expect, it, vi } from "vitest";
import { RecoveryBackoff } from "../../src/recovery-backoff";

afterEach(() => vi.useRealTimers());

it("settles waits on cancellation and renews the bounded retry window", async () => {
  vi.useFakeTimers();
  const recovery = new RecoveryBackoff();
  const request = new AbortController();
  const cancelled = recovery.wait(request.signal);
  request.abort();
  await expect(cancelled).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  recovery.reset();
  for (const delay of [1_000, 3_000, 10_000]) {
    const waiting = recovery.wait(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(delay);
    await expect(waiting).resolves.toBe(true);
  }
  await expect(recovery.wait(new AbortController().signal)).resolves.toBe(
    false,
  );

  recovery.reset();
  const retired = recovery.wait(new AbortController().signal);
  recovery.reset();
  await expect(retired).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
