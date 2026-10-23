import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StatusControlDeclaration } from "../../shared/tool-presentation-config";
import { StatusChoice } from "../../src/components/StatusChoice";
import { store } from "../../src/store";
import { deferred } from "./helpers";

const control: StatusControlDeclaration = {
  id: "choice",
  slot: "thinking",
  label: "Choice",
  command: "/choice",
  state: { key: "choice", value: "value" },
  options: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retires a confirmation warning when the requested selection arrives late", async () => {
  vi.useFakeTimers();
  const initial = store.getState();
  vi.spyOn(store, "getState").mockReturnValue({ ...initial, sessionId: "s1" });
  vi.spyOn(store, "sendPreparedCommand").mockResolvedValue({
    accepted: true,
    historyEntry: null,
  });
  const props = {
    control,
    disabled: false,
    owner: "s1",
    generation: initial.transportGeneration,
  };
  const { rerender } = render(
    <StatusChoice {...props} status='{"value":"low"}' />,
  );
  const input = screen.getByRole("slider", { name: "Choice" });
  fireEvent.change(input, { target: { value: "1" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(
    screen.getByText("The selection has not been confirmed yet."),
  ).toBeVisible();
  rerender(<StatusChoice {...props} status='{"value":"high"}' />);
  expect(input).toHaveAttribute("aria-valuetext", "High");
  expect(
    screen.queryByText("The selection has not been confirmed yet."),
  ).toBeNull();
  expect(store.sendPreparedCommand).toHaveBeenCalledTimes(1);
});

it("keeps confirmed Pi state when its command observation fails later", async () => {
  const initial = store.getState();
  vi.spyOn(store, "getState").mockReturnValue({ ...initial, sessionId: "s1" });
  const pending = deferred<never>();
  vi.spyOn(store, "sendPreparedCommand").mockReturnValue(pending.promise);
  const props = {
    control,
    disabled: false,
    owner: "s1",
    generation: initial.transportGeneration,
  };
  const { rerender } = render(
    <StatusChoice {...props} status='{"value":"low"}' />,
  );
  fireEvent.change(screen.getByRole("slider", { name: "Choice" }), {
    target: { value: "1" },
  });
  rerender(<StatusChoice {...props} status='{"value":"high"}' />);
  await act(async () => {
    pending.reject(new Error("Late command observation failure"));
  });
  expect(screen.queryByText("Late command observation failure")).toBeNull();
  expect(screen.getByRole("slider", { name: "Choice" })).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
});

it("keeps missing status neutral instead of prescribing an extension reload", () => {
  render(
    <StatusChoice
      control={control}
      disabled={false}
      owner={null}
      generation={0}
    />,
  );
  expect(screen.getByRole("slider", { name: "Choice" })).toBeDisabled();
  expect(
    screen.getByText("Selection status is not available yet."),
  ).toBeVisible();
  expect(screen.queryByText(/reload/i)).toBeNull();
});
