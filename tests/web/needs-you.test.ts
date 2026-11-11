import { describe, expect, it } from "vitest";
import type { SessionRuntimeStatus } from "../../shared/contracts";
import { needsYouReason, needsYouRows } from "../../src/needs-you";
import { sessionSummary } from "./helpers";

describe("Needs you", () => {
  it.each([
    [{ runState: "running", needsInput: true }, false, "attention"],
    [{ runState: "running", needsInput: true }, true, "attention"],
    [{ runState: "failed", indicator: "failed" }, false, "failed"],
    [{ runState: "idle", indicator: "completed" }, false, "completed"],
    // Viewing clears an unseen outcome, as the row's status mark does.
    [{ runState: "idle", indicator: "completed" }, true, null],
    [{ runState: "failed", indicator: "failed" }, true, null],
    // Work in progress needs nothing until it stops.
    [{ runState: "running", indicator: "running" }, false, null],
    [{ runState: "idle" }, false, null],
  ] as Array<[SessionRuntimeStatus, boolean, string | null]>)(
    "%j selected=%s needs %s",
    (status, selected, reason) => {
      expect(needsYouReason(status, undefined, selected)).toBe(reason);
    },
  );

  it("treats a native Pi blocked on input as waiting", () => {
    expect(needsYouReason(undefined, "blocked", false)).toBe("attention");
    expect(needsYouReason(undefined, "working", false)).toBeNull();
  });

  it("orders by priority and newest activity even when the input is out of order", () => {
    const sessions = ["a", "b", "c", "d", "e"].map((id, index) =>
      sessionSummary({ id, modified: new Date(index * 1000).toISOString() }),
    );
    const rows = needsYouRows(
      sessions,
      {
        a: { runState: "idle", indicator: "completed" },
        b: { runState: "failed", indicator: "failed" },
        c: { runState: "running", indicator: "running" },
        d: { runState: "running", needsInput: true },
        e: { runState: "idle", indicator: "completed" },
      },
      {},
      null,
      null,
    );
    expect(rows.map((row) => [row.session.id, row.reason])).toEqual([
      ["d", "attention"],
      ["b", "failed"],
      ["e", "completed"],
      ["a", "completed"],
    ]);
  });

  it("keeps the session opened from the list in place while it stays open", () => {
    const sessions = ["a", "b"].map((id) => sessionSummary({ id }));
    const statuses: Record<string, SessionRuntimeStatus> = {
      a: { runState: "idle", indicator: "completed" },
      b: { runState: "failed", indicator: "failed" },
    };
    const retained = { id: "a", reason: "completed" as const };
    // Opening "a" clears its unseen outcome, but the row keeps its rank.
    expect(
      needsYouRows(sessions, statuses, {}, "a", retained).map((row) => [
        row.session.id,
        row.reason,
      ]),
    ).toEqual([
      ["b", "failed"],
      ["a", null],
    ]);
    // Once another session is open, the handled one leaves the list.
    expect(
      needsYouRows(
        sessions,
        { ...statuses, a: { runState: "idle" } },
        {},
        "b",
        retained,
      ).map((row) => row.session.id),
    ).toEqual([]);
  });
});
