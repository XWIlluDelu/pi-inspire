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
  it("keeps ordinary Send alongside shell-only Stop without model queue controls", async () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() =>
      socket.emit({
        type: "snapshot",
        data: { ...activeSnapshot(), bashRunning: true },
      }),
    );
    render(<Composer />);
    expect(
      screen.getByRole("button", { name: "Abort running task" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Send as steer" }),
    ).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "!pwd" } });
    expect(
      screen.getByRole("button", { name: "Run shell command" }),
    ).toBeEnabled();
    fireEvent.change(input, {
      target: { value: "Explicit model input during shell." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(host.promptBodies.at(-1)).toMatchObject({
      message: "Explicit model input during shell.",
    });
    expect(host.promptBodies.at(-1)?.behavior).toBeUndefined();
    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
  });

  it("treats queued work as busy for steer, follow-up, and abort", async () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    const queued = activeSnapshot();
    queued.runState = "queued";
    queued.sessionStatuses = { s1: { runState: "queued" } };
    act(() => socket.emit({ type: "snapshot", data: queued }));

    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Add direction to the running task…",
    );
    expect(screen.getByRole("button", { name: "Steer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Abort running task" }),
    ).toBeInTheDocument();

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
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Add a follow-up for after this task…",
    );
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
      expect(host.abortBodies.at(-1)).toEqual({ sessionId: "s1" }),
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
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Add direction to the running task…",
    );
    expect(
      screen.getByRole("group", { name: "Message delivery" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel context compaction" }),
    ).toBeInTheDocument();
    const meter = screen.getByRole("meter");
    fireEvent.pointerEnter(meter);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "12,640 / 131,072 tokens",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("/compact");

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
  it("reveals read-only model/context details on hover, focus and tap without moving focus", () => {
    render(<Composer />);
    const meter = screen.getByLabelText("Context 10 percent full");
    expect(meter).toHaveTextContent("10%");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.pointerEnter(meter);
    expect(screen.getByRole("tooltip")).toHaveTextContent("kimi-k3");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "12,640 / 131,072 tokens",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("/compact");
    fireEvent.pointerLeave(meter);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.pointerEnter(meter);
    act(() => screen.getByLabelText("Message").focus());
    expect(
      fireEvent.keyDown(document.activeElement!, {
        key: "Escape",
        isComposing: true,
      }),
    ).toBe(true);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(
      false,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => meter.focus());
    expect(meter).toHaveFocus();
    expect(meter).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("tooltip").id,
    );
    fireEvent.keyDown(meter, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(meter).toHaveFocus();
    act(() => meter.blur());
    fireEvent.click(meter);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText("Message"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("reports Pi occupancy above 100 percent while bounding only the ring and meter value", () => {
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          stats: {
            contextUsage: {
              tokens: 196_608,
              contextWindow: 131_072,
              percent: 150,
            },
          },
        }),
      }),
    );
    render(<Composer />);
    const meter = screen.getByRole("meter", {
      name: "Context 150 percent full",
    });
    expect(meter).toHaveTextContent("150%");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("aria-valuetext", "150%");
    const [fill, circumference] = meter
      .querySelector(".meter__ring-fill")!
      .getAttribute("stroke-dasharray")!
      .split(" ")
      .map(Number);
    expect(fill).toBe(circumference);
    fireEvent.pointerEnter(meter);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "150% · 196,608 / 131,072 tokens",
    );
  });

  it("retains unknown occupancy and known capacity after compaction, then restores Pi's next count", () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    const unknown = activeSnapshot({
      stats: {
        contextUsage: { tokens: null, contextWindow: 131_072, percent: null },
      },
    });
    act(() => socket.emit({ type: "snapshot", data: unknown }));
    render(<Composer />);
    const meter = screen.getByLabelText("Context usage unknown");
    expect(meter).toHaveTextContent("—");
    expect(meter).not.toHaveAttribute("aria-valuenow");
    fireEvent.click(meter);
    expect(screen.getByRole("tooltip")).toHaveTextContent("— / 131,072 tokens");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Updates after the next reply",
    );
    act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
    expect(screen.getByRole("meter")).toHaveTextContent("10%");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "12,640 / 131,072 tokens",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(
      "Updates after the next reply",
    );
  });

  it("opens the thinking picker with keyboard focus for /thinking", async () => {
    render(<Composer />);

    await act(async () => {
      await store.sendPrompt("/thinking");
    });

    expect(
      await screen.findByRole("listbox", { name: "Thinking level" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveFocus();
  });

  it("offers bare lowercase thinking levels", () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
    const listbox = screen.getByRole("listbox", { name: "Thinking level" });
    expect(
      within(listbox).getByRole("option", { name: "high" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", { name: "xhigh" }),
    ).not.toBeInTheDocument();
    expect(
      within(listbox).queryByRole("option", { name: /thinking:/ }),
    ).not.toBeInTheDocument();
  });
});
