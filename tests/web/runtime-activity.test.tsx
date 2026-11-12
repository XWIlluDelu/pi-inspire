// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ActivityBar } from "../../src/components/ActivityBar";
import { CommandActivity } from "../../src/components/CommandActivity";
import { emptyEventSlice, reduceEvent } from "../../src/events";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
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
      <ActivityBar onJumpToPending={() => undefined} />
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
    if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
    return undefined;
  });
  await store.init();
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
afterEach(() => vi.useRealTimers());

describe("runtime-owned activity", () => {
  it("renews one query readout and keeps it readable through runtime progress and keyboard focus", async () => {
    vi.useFakeTimers();
    render(<CommandActivity />);
    await act(() => store.sendPrompt("/session"));
    act(() => vi.advanceTimersByTime(7_000));
    await act(() => store.sendPrompt("/session"));
    act(() =>
      socket().emit({
        type: "agent_start",
        sessionId: store.getState().sessionId,
      }),
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("/session")).toBeVisible();

    const dock = screen.getByRole("region", { name: "Command activity" });
    act(() => dock.focus());
    expect(dock).toHaveFocus();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("/session")).toBeVisible();
    act(() => dock.blur());
    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.queryByText("/session")).toBeNull();
  });

  it.each(["receipt first", "end event first"] as const)(
    "takes compaction progress from the Host with the %s",
    async (order) => {
      renderActivity();
      const completeCommand = async () => {
        await act(async () =>
          nativeResult.resolve({
            command: "compact",
            outcome: "completed",
            message: "Context compacted.",
          }),
        );
        expect(store.getState().notices.at(-1)?.text).toBe(
          "Context compacted.",
        );
      };
      act(() => {
        void store.sendPrompt("/compact");
      });
      expect(progress()).not.toBeInTheDocument();
      snapshot.runState = "compacting";
      start("manual");
      expect(progress()).toHaveTextContent("Compacting context");

      if (order === "receipt first") {
        await completeCommand();
        expect(progress()).toHaveTextContent("Compacting context");
      }
      snapshot.runState = "idle";
      finish("manual", { result: { summary: "Pi-owned summary" } });
      expect(progress()).not.toBeInTheDocument();
      if (order === "end event first") await completeCommand();
      expect(progress()).not.toBeInTheDocument();
    },
  );

  it("ignores background compaction and keeps the active session's failure through resync", async () => {
    renderActivity();
    start("overflow", "background");
    act(() =>
      socket().emit({
        type: "compaction_end",
        reason: "overflow",
        sessionId: "background",
        sessionStatus: { runState: "failed" },
        errorMessage: "background quota failure",
      }),
    );
    expect(store.getState().notices).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("background quota failure"),
      }),
    );
    expect(progress()).not.toBeInTheDocument();

    start("threshold");
    expect(progress()).toHaveTextContent("Compacting context");
    finish("threshold", {
      result: null,
      errorMessage: "Provider quota exceeded",
    });
    await waitFor(() => expect(store.getState().runState).toBe("idle"));
    expect(progress()).not.toBeInTheDocument();
    expect(store.getState().notices.at(-1)).toMatchObject({
      kind: "error",
      text: "Automatic context compaction failed: Provider quota exceeded",
    });
  });

  it("renders retry detail from a snapshot and discards it when switching sessions", () => {
    const emitSnapshot = () =>
      act(() => socket().emit({ type: "snapshot", data: snapshot }));
    renderActivity();
    snapshot.runState = "retrying";
    snapshot.retry = retry;
    emitSnapshot();
    expect(retryStatus()).toHaveTextContent("Retry 2/3 — Provider overloaded");
    snapshot.retry = { ...retry, attempt: 99 };
    emitSnapshot();
    expect(retryStatus()).toHaveTextContent(/^Retrying$/);
    snapshot = { ...activeSnapshot({ sessionId: "other-session" }), retry };
    emitSnapshot();
    expect(retryStatus()).not.toBeInTheDocument();
  });

  it("shows a live retry until the run settles", () => {
    renderActivity();
    const emit = (event: Record<string, unknown>) =>
      act(() =>
        socket().emit({ sessionId: snapshot.active!.sessionId, ...event }),
      );
    emit({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      errorMessage: "rate limited",
    });
    expect(retryStatus()).toHaveTextContent("Retry 2/3 — rate limited");
    emit({ type: "agent_settled", sessionStatus: { runState: "failed" } });
    expect(retryStatus()).not.toBeInTheDocument();
  });

  it("restores compaction backoff on entry and retires it as attempts resume or finish", async () => {
    snapshot.runState = "compacting";
    snapshot.summarizationRetry = retry;
    act(() => socket().emit({ type: "snapshot", data: snapshot }));
    renderActivity();
    expect(progress()).toHaveTextContent(
      "Compaction retry 2/3 — waiting — Provider overloaded",
    );

    const update = (type: string, detail: Record<string, unknown> = {}) =>
      act(() =>
        socket().emit({
          type,
          sessionId: snapshot.active!.sessionId,
          sessionStatus: { runState: "compacting" },
          ...detail,
        }),
      );
    update("summarization_retry_attempt_start");
    expect(progress()).toHaveTextContent("Compacting context");
    update("summarization_retry_scheduled", { attempt: 99, maxAttempts: 3 });
    expect(progress()).toHaveTextContent("Compacting context");
    update("summarization_retry_scheduled", {
      attempt: 3,
      maxAttempts: 3,
      errorMessage: "Still overloaded",
    });
    expect(progress()).toHaveTextContent("Compaction retry 3/3");
    expect(retryStatus()).not.toBeInTheDocument();
    update("summarization_retry_finished");
    expect(progress()).toHaveTextContent("Compacting context");

    snapshot.runState = "failed";
    finish("manual", {
      errorMessage: "Summary provider unavailable",
      result: null,
      sessionStatus: { runState: "failed" },
    });
    await waitFor(() => expect(store.getState().runState).toBe("failed"));
    expect(progress()).not.toBeInTheDocument();
    expect(store.getState().notices.at(-1)?.text).toContain(
      "Summary provider unavailable",
    );
  });

  it("keeps a cancelled command receipt available after work resumes", async () => {
    renderActivity();
    act(() => {
      void store.sendPrompt("/compact");
    });
    await act(async () =>
      nativeResult.resolve({
        command: "compact",
        outcome: "cancelled",
        message: "Compaction cancelled.",
      }),
    );
    await screen.findByText("Cancelled");
    act(() =>
      socket().emit({
        type: "agent_start",
        sessionId: snapshot.active!.sessionId,
        sessionStatus: { runState: "running" },
      }),
    );
    expect(screen.getByText("/compact")).toBeVisible();
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
  ])("adopts the Host failure on $type", (event) => {
    const { slice } = reduceEvent(
      { ...emptyEventSlice(), runState: "running" },
      new Set(),
      { ...event, sessionStatus: { runState: "failed", indicator: "failed" } },
    );
    expect(slice.runState).toBe("failed");
  });

  it.each([
    {
      reason: "overflow",
      result: null,
      aborted: true,
      notice: { kind: "info", text: "Automatic context compaction cancelled." },
    },
    {
      reason: "overflow",
      result: null,
      notice: {
        kind: "warning",
        text: "Automatic context compaction ended without a result.",
      },
    },
    {
      reason: "manual",
      result: null,
      aborted: true,
      notice: { kind: "info", text: "Context compaction cancelled." },
    },
    {
      reason: "overflow",
      result: { summary: "canonical summary" },
      sessionStatus: { runState: "running", indicator: "running" },
      willRetry: true,
      notice: null,
    },
  ] as const)(
    "reports the $reason outcome $notice without synthesizing history",
    ({ notice, sessionStatus = { runState: "idle" }, ...event }) => {
      const { slice, resync } = reduceEvent(
        {
          ...emptyEventSlice(),
          runState: "compacting",
          summarizationRetry: retry,
        },
        new Set(),
        {
          type: "compaction_end",
          sessionStatus,
          ...event,
        },
      );
      expect(resync).toBe(true);
      expect(slice.runState).toBe(sessionStatus.runState);
      expect(slice.summarizationRetry).toBeNull();
      expect(slice.messages).toEqual([]);
      expect(slice.notices).toEqual(
        notice ? [expect.objectContaining(notice)] : [],
      );
    },
  );
});
