// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import { createComposerFixture, typeDraft } from "./fixtures/composer";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  type RouteResponse,
  TEST_HOST_AUTHORITY,
} from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("composer-adjacent status and queued controls", () => {
  it("treats queued work as busy for steer, follow-up, and abort", async () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    const queued = activeSnapshot();
    queued.runState = "queued";
    queued.sessionStatuses = { s1: { runState: "queued" } };
    act(() => socket.emit({ type: "snapshot", data: queued }));

    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    expect(screen.getByRole("button", { name: "Steer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    typeDraft("steer queued work");
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(host.promptBodies.at(-1)).toMatchObject({
        sessionId: "s1",
        message: "steer queued work",
        behavior: "steer",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    typeDraft("follow up queued work");
    fireEvent.click(
      screen.getByRole("button", { name: "Queue after current task" }),
    );
    await waitFor(() =>
      expect(host.promptBodies.at(-1)).toMatchObject({
        sessionId: "s1",
        message: "follow up queued work",
        behavior: "followUp",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Abort running task" }));
    await waitFor(() =>
      expect(host.abortBodies.at(-1)).toEqual({
        sessionId: "s1",
        expectedViewId: "view-s1",
        authorityId: TEST_HOST_AUTHORITY,
        operationId: expect.any(String),
      }),
    );

    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
  });

  it("does not let a late compact HTTP receipt lock the composer after Pi settles", async () => {
    const compactReceipt = deferred<RouteResponse>();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (String(input).startsWith("/api/control/native-command"))
        return compactReceipt.promise.then(
          (route) =>
            new Response(JSON.stringify(route.body), {
              status: route.status ?? 200,
              headers: { "Content-Type": "application/json" },
            }),
        );
      return previousFetch(input, init);
    };
    try {
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
      render(<Composer />);
      await store.sendPrompt("/compact");
      const compacting = activeSnapshot();
      compacting.runState = "compacting";
      compacting.sessionStatuses.s1 = { runState: "compacting" };
      act(() => socket.emit({ type: "snapshot", data: compacting }));
      await waitFor(() =>
        expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
          command: "compact",
          status: "running",
        }),
      );
      act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
      typeDraft("next task");
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(host.promptBodies.at(-1)).toMatchObject({
          message: "next task",
        }),
      );
    } finally {
      compactReceipt.resolve({
        body: {
          command: "compact",
          outcome: "completed",
          message: "Context compacted.",
        },
      });
      globalThis.fetch = previousFetch;
      act(() =>
        FakeWebSocket.instances
          .at(-1)!
          .emit({ type: "snapshot", data: activeSnapshot() }),
      );
    }
  });

  it("accepts steer during compaction and keeps cancellation available", async () => {
    const before = host.promptBodies.length;
    const socket = FakeWebSocket.instances.at(-1)!;
    const compacting = activeSnapshot();
    compacting.runState = "compacting";
    compacting.sessionStatuses = {
      s1: { runState: "compacting", indicator: "running" },
    };
    act(() => socket.emit({ type: "snapshot", data: compacting }));

    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    expect(textarea).toHaveAttribute("placeholder", "Guide the current task…");
    expect(
      screen.getByRole("group", { name: "Message delivery" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel context compaction" }),
    ).toBeInTheDocument();

    typeDraft("steer during the checkpoint");
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(host.promptBodies).toHaveLength(before + 1));
    expect(host.promptBodies.at(-1)).toMatchObject({
      message: "steer during the checkpoint",
      behavior: "steer",
    });
    expect(textarea).toHaveValue("");

    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
  });
});
describe("composer meta row", () => {
  it("keeps Send last and mounted as Stop appears, with recovery still exclusive", () => {
    render(<Composer />);
    typeDraft("Follow-up");
    const send = screen.getByRole("button", { name: "Send message" });
    const socket = FakeWebSocket.instances.at(-1)!;
    send.focus();

    for (const runState of [
      "running",
      "queued",
      "retrying",
      "compacting",
    ] as const) {
      const snapshot = activeSnapshot();
      snapshot.runState = runState;
      snapshot.sessionStatuses = { s1: { runState } };
      act(() => socket.emit({ type: "snapshot", data: snapshot }));
      const stop = screen.getByRole("button", {
        name:
          runState === "compacting"
            ? "Cancel context compaction"
            : "Abort running task",
      });
      expect(screen.getByRole("button", { name: "Send as steer" })).toBe(send);
      expect(screen.getAllByRole("button").slice(-2)).toEqual([stop, send]);
      expect(send).toHaveFocus();
    }

    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
    expect(screen.getByRole("button", { name: "Send message" })).toBe(send);
    expect(
      screen.queryByRole("button", { name: "Abort running task" }),
    ).toBeNull();

    const conflict = activeSnapshot();
    conflict.runState = "conflict";
    conflict.sessionStatuses = { s1: { runState: "conflict" } };
    act(() => socket.emit({ type: "snapshot", data: conflict }));
    expect(screen.getAllByRole("button").at(-1)).toHaveAccessibleName(
      "Recover session",
    );
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("preserves known capacity when occupancy is unknown and announces overflow accurately", () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    const update = (tokens: number | null, percent: number | null) =>
      act(() =>
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({
            stats: {
              contextUsage: { tokens, contextWindow: 131_072, percent },
            },
          }),
        }),
      );
    update(null, null);
    render(<Composer />);
    const meter = screen.getByLabelText("Context usage unknown");
    expect(meter).toHaveTextContent("—");
    expect(meter).not.toHaveAttribute("aria-valuenow");
    fireEvent.pointerEnter(meter);
    expect(screen.getByRole("tooltip")).toHaveTextContent("— / 131,072 tokens");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Updates after the next reply",
    );
    update(196_608, 150);
    const overflow = screen.getByRole("meter");
    expect(overflow).toHaveAttribute("aria-valuenow", "100");
    expect(overflow).toHaveAttribute("aria-valuetext", "150%");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "150% · 196,608 / 131,072 tokens",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(
      "Updates after the next reply",
    );
  });

  it("keeps attached terminal Pi model controls independent of Pi activity, gated only by model reasoning", () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    const snapshot = activeSnapshot();
    snapshot.runState = "running";
    snapshot.sessionStatuses.s1 = { runState: "running", external: true };
    act(() => socket.emit({ type: "snapshot", data: snapshot }));
    render(<Composer />);
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Model" })).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toBeEnabled();
    snapshot.active!.model = {
      provider: "native",
      id: "plain",
      reasoning: false,
    };
    act(() => socket.emit({ type: "snapshot", data: snapshot }));
    expect(screen.getByRole("button", { name: "Model" })).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toBeDisabled();
  });

  it("opens the supported thinking choices with keyboard focus for /thinking", async () => {
    render(<Composer />);
    await act(async () => {
      await store.sendPrompt("/thinking");
    });

    const listbox = await screen.findByRole("listbox", {
      name: "Thinking level",
    });
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveFocus();
    expect(within(listbox).getByRole("option", { name: "High" })).toBeVisible();
    expect(
      within(listbox).queryByRole("option", { name: /xhigh|thinking:/i }),
    ).toBeNull();
  });
});
