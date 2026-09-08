// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityBar } from "../../src/components/ActivityBar";
import { CommandActivity } from "../../src/components/CommandActivity";
import { emptyEventSlice, reduceEvent } from "../../src/events";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

let snapshot = activeSnapshot();
let nativeResult = deferred<unknown>();
let sessionNumber = 0;
const socket = () => FakeWebSocket.instances.at(-1)!;
const progress = () =>
  screen.queryByRole("status", { name: "Context compaction status" });
const retryStatus = () =>
  screen.queryByRole("status", { name: "Retry status" });
const renderActivity = () =>
  render(
    <>
      <CommandActivity />
      <ActivityBar />
    </>,
  );

beforeAll(async () => {
  installFakeWebSocket();
  installFetch((url) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ snapshot }) };
    if (url.startsWith("/api/snapshot")) return { body: snapshot };
    if (url.startsWith("/api/control/native-command"))
      return nativeResult.promise.then((body) => ({ body }));
    if (url.startsWith("/api/sessions"))
      return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    return undefined;
  });
  await store.init("token");
  socket().open();
});

beforeEach(() => {
  snapshot = activeSnapshot({ sessionId: `activity-${++sessionNumber}` });
  nativeResult = deferred<unknown>();
  act(() => socket().emit({ type: "snapshot", data: snapshot }));
});

function start(
  reason: "manual" | "threshold" | "overflow",
  sessionId = store.getState().sessionId,
) {
  act(() =>
    socket().emit({
      type: "compaction_start",
      reason,
      sessionId,
      sessionStatus: { runState: "compacting", indicator: "running" },
    }),
  );
}
function finish(reason: string, extra: Record<string, unknown> = {}) {
  act(() =>
    socket().emit({
      type: "compaction_end",
      reason,
      sessionId: store.getState().sessionId,
      sessionStatus: { runState: "idle" },
      ...extra,
    }),
  );
}

const retry = { attempt: 2, maxAttempts: 3, message: "Provider overloaded" };

describe("runtime-owned activity", () => {
  it.each(["threshold", "overflow", "manual"] as const)(
    "shows identical %s compaction regardless of the trigger",
    async (reason) => {
      renderActivity();
      expect(progress()).not.toBeInTheDocument();
      start(reason);
      expect(progress()).toHaveTextContent("Compacting context");
      expect(progress()).not.toHaveTextContent("/compact");
      expect(progress()).not.toHaveTextContent("%");
      finish(reason, { result: { summary: "Pi-owned summary" } });
      expect(progress()).not.toBeInTheDocument();
      await waitFor(() => expect(store.getState().runState).toBe("idle"));
      expect(screen.queryByText("Pi-owned summary")).not.toBeInTheDocument();
    },
  );

  it("restores compaction from a snapshot and component remount without a start event", () => {
    snapshot.runState = "compacting";
    act(() => socket().emit({ type: "snapshot", data: snapshot }));
    const first = renderActivity();
    expect(progress()).toHaveTextContent("Compacting context");
    first.unmount();
    renderActivity();
    expect(progress()).toHaveTextContent("Compacting context");
  });

  it("never displays another session's phase or failure in the foreground", () => {
    renderActivity();
    start("overflow", "background");
    expect(progress()).not.toBeInTheDocument();
    const noticesBefore = store.getState().notices;
    act(() =>
      socket().emit({
        type: "compaction_end",
        reason: "overflow",
        sessionId: "background",
        sessionStatus: { runState: "failed" },
        result: null,
        errorMessage: "background quota failure",
      }),
    );
    expect(store.getState().notices).toBe(noticesBefore);
    expect(progress()).not.toBeInTheDocument();
  });

  it("keeps local /compact receipts for results without owning or extending phase display", async () => {
    renderActivity();
    act(() => {
      void store.sendPrompt("/compact");
    });
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();
    start("manual");
    expect(progress()).toHaveTextContent("Compacting context");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    finish("manual", { result: { summary: "summary" } });
    expect(progress()).not.toBeInTheDocument(); // HTTP result is still pending.
    await act(async () =>
      nativeResult.resolve({
        command: "compact",
        outcome: "completed",
        message: "Context compacted.",
      }),
    );
    await screen.findByText("Done");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    start("threshold");
    expect(progress()).toHaveTextContent("Compacting context");
  });

  it("does not lose phase display when a command result arrives before its end event", async () => {
    snapshot.runState = "compacting";
    renderActivity();
    act(() => {
      void store.sendPrompt("/compact");
    });
    start("manual");
    await act(async () =>
      nativeResult.resolve({
        command: "compact",
        outcome: "completed",
        message: "Context compacted.",
      }),
    );
    await screen.findByText("Done");
    expect(progress()).toHaveTextContent("Compacting context");
    snapshot.runState = "idle";
    finish("manual", { result: {} });
    expect(progress()).not.toBeInTheDocument();
  });

  it("keeps automatic failure feedback across transcript resync", async () => {
    renderActivity();
    start("threshold");
    finish("threshold", {
      result: null,
      errorMessage: "Provider quota exceeded",
    });
    expect(progress()).not.toBeInTheDocument();
    expect(store.getState().notices.at(-1)).toMatchObject({
      kind: "error",
      text: "Automatic context compaction failed: Provider quota exceeded",
    });
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
    expect(store.getState().notices.at(-1)?.text).toContain(
      "Provider quota exceeded",
    );
  });

  it.each([null, retry])(
    "restores retry state with optional snapshot details: %j",
    (detail) => {
      snapshot.runState = "retrying";
      snapshot.retry = detail;
      act(() => socket().emit({ type: "snapshot", data: snapshot }));
      renderActivity();
      expect(retryStatus()).toHaveTextContent(
        detail ? "Retry 2/3 — Provider overloaded" : "Retrying",
      );
      // An unrelated settings/projection snapshot must not erase retry detail.
      act(() => socket().emit({ type: "snapshot", data: snapshot }));
      expect(retryStatus()).toHaveTextContent(
        detail ? "Retry 2/3" : "Retrying",
      );
      snapshot = activeSnapshot({ sessionId: "other-session" });
      act(() => socket().emit({ type: "snapshot", data: snapshot }));
      expect(retryStatus()).not.toBeInTheDocument();
    },
  );

  it("does not render stale retry metadata outside retrying", () => {
    snapshot.retry = retry;
    act(() => socket().emit({ type: "snapshot", data: snapshot }));
    renderActivity();
    expect(retryStatus()).not.toBeInTheDocument();
    expect(store.getState().retry).toBeNull();
  });
});

describe("phase event reduction", () => {
  it.each([
    {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    },
    { type: "agent_settled" },
    { type: "session_status" },
  ])(
    "adopts failed Host state from $type rather than inferring running/idle",
    (event) => {
      const result = reduceEvent(
        { ...emptyEventSlice(), runState: "running" },
        new Set(),
        {
          ...event,
          sessionStatus: { runState: "failed", indicator: "failed" },
        },
      );
      expect(result.slice.runState).toBe("failed");
      expect(result.changed).toBe(true);
    },
  );

  it.each([
    [
      { aborted: true, result: null },
      "info",
      "Automatic context compaction cancelled.",
    ],
    [
      { result: null, errorMessage: "Quota exceeded" },
      "error",
      "Automatic context compaction failed: Quota exceeded",
    ],
    [
      { result: null },
      "warning",
      "Automatic context compaction ended without a result.",
    ],
  ] as const)(
    "reports %j and adopts Host return state before resync",
    (outcome, kind, text) => {
      const result = reduceEvent(
        { ...emptyEventSlice(), runState: "compacting" },
        new Set(),
        {
          type: "compaction_end",
          reason: "overflow",
          sessionStatus: { runState: "aborted" },
          ...outcome,
        },
      );
      expect(result.resync).toBe(true);
      expect(result.slice.runState).toBe("aborted");
      expect(result.slice.notices).toEqual([{ id: 1, kind, text }]);
    },
  );

  it("leaves successful summaries in Pi history instead of manufacturing a message", () => {
    const result = reduceEvent(emptyEventSlice(), new Set(), {
      type: "compaction_end",
      reason: "overflow",
      result: { summary: "canonical summary" },
      willRetry: true,
      sessionStatus: { runState: "running", indicator: "running" },
    });
    expect(result.resync).toBe(true);
    expect(result.slice.runState).toBe("running");
    expect(result.slice.notices).toEqual([]);
    expect(result.slice.messages).toEqual([]);
  });

  it("does not duplicate manual command error/cancellation results", () => {
    for (const outcome of [
      { aborted: true },
      { errorMessage: "manual failure" },
    ]) {
      const result = reduceEvent(emptyEventSlice(), new Set(), {
        type: "compaction_end",
        reason: "manual",
        result: null,
        ...outcome,
      });
      expect(result.slice.notices).toEqual([]);
    }
  });

  it.each([
    "agent_start",
    "agent_settled",
    "compaction_start",
    "runtime_error",
  ])("%s retires retry details", (type) => {
    const result = reduceEvent(
      { ...emptyEventSlice(), runState: "retrying", retry },
      new Set(),
      { type },
    );
    expect(result.slice.retry).toBeNull();
  });

  it("malformed retry detail never invents a 1/1 attempt", () => {
    const result = reduceEvent(emptyEventSlice(), new Set(), {
      type: "auto_retry_start",
    });
    expect(result.slice.runState).toBe("retrying");
    expect(result.slice.retry).toBeNull();
  });
});
