// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionRuntimeStatus } from "../../shared/contracts";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import { createComposerFixture, typeDraft } from "./fixtures/composer";
import { activeSnapshot, deferred, FakeWebSocket } from "./helpers";

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
  const usage = screen.getByRole("button", {
    name: "Session & usage, context unknown",
  });
  fireEvent.click(usage);
  const details = () => store.getState().commandActivities.s1?.at(-1)?.details;
  expect(details()).toContainEqual({
    id: "context",
    label: "Context",
    value: "— / 131,072 · Updates after the next reply",
  });
  update(196_608, 150);
  expect(usage).toHaveAccessibleName(
    "Session & usage, context 150 percent full",
  );
  fireEvent.click(usage);
  expect(details()).toContainEqual({
    id: "context",
    label: "Context",
    value: "196,608 / 131,072 (150%)",
  });
});
