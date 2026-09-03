import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTerminalActions,
  clearTerminalInsertions,
  hasTerminalInsertion,
  queueTerminalAction,
  queueTerminalInsertion,
  subscribeTerminalActions,
  subscribeTerminalInsertion,
  takeTerminalInsertion,
} from "../../src/terminal-actions";

describe("terminal insertion queue", () => {
  beforeEach(() => {
    clearTerminalInsertions();
    clearTerminalActions();
  });

  it("retains code until a writable terminal consumes it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalInsertion(listener);
    queueTerminalInsertion("printf hello", "/project/a");
    expect(listener).toHaveBeenCalledOnce();
    expect(hasTerminalInsertion("/project/a")).toBe(true);
    expect(hasTerminalInsertion("/project/b")).toBe(false);
    expect(takeTerminalInsertion("/project/b")).toBeNull();
    expect(takeTerminalInsertion("/project/a")).toBe("printf hello");
    expect(hasTerminalInsertion("/project/a")).toBe(false);
    unsubscribe();
  });

  it("delivers a queued UI action to the first capable surface", () => {
    queueTerminalAction("take-control");
    const inactive = vi.fn(() => false);
    const stopInactive = subscribeTerminalActions(inactive);
    expect(inactive).toHaveBeenCalledWith("take-control");
    const active = vi.fn(() => true);
    const stopActive = subscribeTerminalActions(active);
    expect(active).toHaveBeenCalledWith("take-control");
    stopInactive();
    stopActive();
  });

  it("bounds pending inserted text", () => {
    queueTerminalInsertion("x".repeat(300_000), "/project/a");
    expect(takeTerminalInsertion("/project/a")).toHaveLength(200_000);
  });
});
