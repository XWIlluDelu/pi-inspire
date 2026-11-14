// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionRuntimeStatus } from "../../shared/contracts";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import { createComposerFixture, typeDraft } from "./fixtures/composer";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  TEST_HOST_AUTHORITY,
} from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => vi.unstubAllGlobals());

function publish(status: SessionRuntimeStatus) {
  const snapshot = activeSnapshot();
  snapshot.sessionStatuses.s1 = status;
  act(() => FakeWebSocket.instances.at(-1)!.emitSnapshot(snapshot));
}

it("routes queued work and compaction through the same delivery controls while keeping Send mounted", async () => {
  render(<Composer />);
  const input = screen.getByLabelText("Message");
  const send = screen.getByRole("button", { name: "Send message" });
  typeDraft("steer queued work");
  send.focus();
  for (const runState of [
    "running",
    "retrying",
    "queued",
    "compacting",
  ] as const) {
    publish({ runState });
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
  expect(input).toHaveAttribute("placeholder", "Guide the current task…");
  typeDraft("steer through compaction");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(host.promptBodies.at(-1)).toMatchObject({
      sessionId: "s1",
      message: "steer through compaction",
      behavior: "steer",
    }),
  );
  expect(input).toHaveValue("");
  publish({ runState: "queued" });
  expect(screen.getByRole("button", { name: "Steer" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  typeDraft("steer queued work");
  fireEvent.keyDown(input, { key: "Enter" });
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
    expect(host.abortBodies).toEqual([
      {
        sessionId: "s1",
        expectedViewId: "view-s1",
        authorityId: TEST_HOST_AUTHORITY,
        operationId: expect.any(String),
      },
    ]),
  );
  publish({ runState: "idle" });
  expect(screen.getByRole("button", { name: "Send message" })).toBe(send);
  expect(
    screen.queryByRole("button", { name: "Abort running task" }),
  ).toBeNull();
  publish({ runState: "conflict" });
  expect(screen.getAllByRole("button").at(-1)).toHaveAccessibleName(
    "Recover session",
  );
  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
});

it("keeps the composer available after Pi settles while a Compact request is still in flight", async () => {
  const receipt = deferred<Response>();
  const fetchFixture = globalThis.fetch;
  const compact = vi.fn(() => receipt.promise);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/control/native-command"
      ? compact()
      : fetchFixture(input, init),
  );
  render(<Composer />);
  try {
    await act(async () => {
      await store.sendPrompt("/compact");
    });
    expect(compact).toHaveBeenCalledOnce();
    publish({ runState: "compacting" });
    expect(
      screen.getByRole("button", { name: "Cancel context compaction" }),
    ).toBeVisible();
    publish({ runState: "idle" });
    typeDraft("next task");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(host.promptBodies.at(-1)).toMatchObject({ message: "next task" }),
    );
  } finally {
    await act(async () =>
      receipt.resolve(
        Response.json({
          command: "compact",
          outcome: "completed",
          message: "Context compacted.",
        }),
      ),
    );
  }
  expect(
    screen.getByRole("button", { name: "Send message" }),
  ).toBeInTheDocument();
});

it("announces unknown context occupancy and above-capacity usage with the known capacity", () => {
  const update = (tokens: number | null, percent: number | null) =>
    act(() =>
      FakeWebSocket.instances.at(-1)!.emitSnapshot(
        activeSnapshot({
          stats: { contextUsage: { tokens, contextWindow: 131_072, percent } },
        }),
      ),
    );
  update(null, null);
  render(<Composer />);
  const meter = screen.getByLabelText("Context usage unknown");
  expect(meter).not.toHaveAttribute("aria-valuenow");
  fireEvent.pointerEnter(meter);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("— / 131,072 tokens");
  expect(tooltip).toHaveTextContent("Updates after the next reply");
  update(196_608, 150);
  const overflow = screen.getByRole("meter");
  expect(overflow).toHaveAttribute("aria-valuenow", "100");
  expect(overflow).toHaveAttribute("aria-valuetext", "150%");
  expect(tooltip).toHaveTextContent("150% · 196,608 / 131,072 tokens");
  expect(tooltip).not.toHaveTextContent("Updates after the next reply");
});

it("keeps attached Pi controls available and targets only supported thinking choices", async () => {
  const status = { runState: "running", external: true } as const;
  publish(status);
  render(<Composer />);
  const input = screen.getByLabelText("Message");
  const model = screen.getByRole("button", { name: "Model" });
  const thinking = screen.getByRole("combobox", { name: "Thinking level" });
  expect(input).toBeEnabled();
  expect(model).toBeEnabled();
  expect(thinking).toBeEnabled();
  await act(async () => {
    await store.sendPrompt("/thinking");
  });
  expect(thinking).toHaveFocus();
  expect(
    within(thinking).getByRole("option", { name: "High" }),
  ).toBeInTheDocument();
  expect(
    within(thinking).queryByRole("option", { name: /xhigh|thinking:/i }),
  ).toBeNull();
  const plain = activeSnapshot({
    model: { provider: "native", id: "plain", reasoning: false },
  });
  plain.sessionStatuses.s1 = status;
  act(() => FakeWebSocket.instances.at(-1)!.emitSnapshot(plain));
  expect(model).toBeEnabled();
  expect(thinking).toBeDisabled();
});
