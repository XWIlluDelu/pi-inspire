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

  it("delivers a project-bound lazy surface action to the first capable surface", () => {
    queueTerminalAction("focus", "/project/a");
    const inactive = vi.fn(() => false);
    const stopInactive = subscribeTerminalActions(inactive);
    expect(inactive).toHaveBeenCalledWith({
      action: "focus",
      projectCwd: "/project/a",
    });
    const active = vi.fn(() => true);
    const stopActive = subscribeTerminalActions(active);
    expect(active).toHaveBeenCalledWith({
      action: "focus",
      projectCwd: "/project/a",
    });
    stopInactive();
    stopActive();
  });

  it.each(["close", "restart"] as const)(
    "ends targetless %s rather than queueing for a future terminal",
    (action) => {
      queueTerminalAction(action, "/project/a");
      const later = vi.fn(() => true);
      const stop = subscribeTerminalActions(later);
      expect(later).not.toHaveBeenCalled();
      stop();
    },
  );

  it("bounds pending inserted text", () => {
    queueTerminalInsertion("x".repeat(300_000), "/project/a");
    expect(takeTerminalInsertion("/project/a")).toHaveLength(200_000);
  });
});
