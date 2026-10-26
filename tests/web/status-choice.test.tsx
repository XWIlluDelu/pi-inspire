import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StatusControlDeclaration } from "../../shared/tool-presentation-config";
import { StatusChoice } from "../../src/components/StatusChoice";
import { availableStatusControls } from "../../src/presentation-adapters";
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

it("uses completion command ownership rather than advertising a shadowed extension control", () => {
  expect(
    availableStatusControls(
      {
        version: 1,
        rules: {},
        mappings: {},
        controls: [control, { ...control, id: "model", command: "/model" }],
      },
      [
        { name: "choice", source: "extension" },
        { name: "model", source: "extension" },
      ],
    ),
  ).toEqual([control]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retires a confirmation warning when the requested selection arrives late", async () => {
  vi.useFakeTimers();
  const initial = store.getState();
  vi.spyOn(store, "getState").mockReturnValue({ ...initial, sessionId: "s1" });
  vi.spyOn(store, "selectStatusControl").mockImplementation(
    () =>
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The selection has not been confirmed yet.")),
          10_000,
        ),
      ),
  );
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
  expect(input).toBeDisabled();
  expect(input).toHaveAttribute("aria-valuetext", "Low");
  expect(input.closest(".status-choice")).toHaveAttribute("aria-busy", "true");
  expect(input.closest(".status-choice")?.querySelector("p")).toBeNull();
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
  expect(store.selectStatusControl).toHaveBeenCalledTimes(1);
});

it("retains meaningful option guidance while a different selection is pending", async () => {
  const state = store.getState();
  vi.spyOn(store, "getState").mockReturnValue({ ...state, sessionId: "s1" });
  const pending = deferred<boolean>();
  vi.spyOn(store, "selectStatusControl").mockReturnValue(pending.promise);
  render(
    <StatusChoice
      control={{
        ...control,
        options: [
          { ...control.options[0]!, description: "Uses standard limits." },
          control.options[1]!,
        ],
      }}
      status='{"value":"low"}'
      disabled={false}
      owner="s1"
      generation={state.transportGeneration}
    />,
  );
  fireEvent.change(screen.getByRole("slider", { name: "Choice" }), {
    target: { value: "1" },
  });
  expect(screen.getByText("Uses standard limits.")).toBeVisible();
  await act(async () => pending.resolve(false));
});

it("keeps confirmed Pi state when its command observation fails later", async () => {
  const initial = store.getState();
  vi.spyOn(store, "getState").mockReturnValue({ ...initial, sessionId: "s1" });
  const pending = deferred<never>();
  vi.spyOn(store, "selectStatusControl").mockReturnValue(pending.promise);
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

it("can choose the first draft value by keyboard without claiming a current native value", () => {
  const onSelect = vi.fn();
  render(
    <StatusChoice
      control={control}
      disabled={false}
      draft={{ value: null, onSelect }}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Choice" });
  expect(slider).toBeEnabled();
  expect(slider).toHaveAttribute("aria-valuetext", "Default");
  expect(
    document.querySelector('.status-choice__dots [data-focus-target="true"]'),
  ).not.toHaveAttribute("data-selected", "true");
  fireEvent.keyDown(slider, { key: "Home" });
  expect(onSelect).toHaveBeenCalledWith("low");
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
