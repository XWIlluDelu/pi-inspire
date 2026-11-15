import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { PresentationAdapterSettings } from "../../src/components/PresentationAdapterSettings";
import { SettingsContent } from "../../src/components/Settings";
import { SettingsDialog } from "../../src/components/SettingsDialog";
import { configurePresentationAdapters } from "../../src/presentation-adapters";
import { store } from "../../src/store";
import { deferred } from "./helpers";

function Settings() {
  return (
    <SettingsDialog onClose={() => {}}>
      <SettingsContent workspaceOwner={{}} />
    </SettingsDialog>
  );
}

function openBehaviorSettings() {
  const view = render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
  return view;
}

it("allows project notification grouping when desktop notifications are unavailable", () => {
  const state = store.getState();
  vi.spyOn(store, "getState").mockReturnValue({
    ...state,
    taskAlerts: {
      ...state.taskAlerts,
      mode: "desktop",
      permission: "unavailable",
      subscribed: false,
      grouping: "session",
    },
  });
  const change = vi
    .spyOn(store, "setTaskNotificationGrouping")
    .mockResolvedValue(true);

  openBehaviorSettings();
  expect(
    screen.getByRole("button", { name: "Enable notifications" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("combobox", { name: "Notification grouping" }),
  );
  fireEvent.click(screen.getByRole("option", { name: "Project" }));
  expect(change).toHaveBeenCalledWith("project");
});

it("keeps background notification status visible while an update blocks testing", () => {
  const state = store.getState();
  const getState = vi.spyOn(store, "getState").mockReturnValue({
    ...state,
    taskAlerts: {
      ...state.taskAlerts,
      mode: "desktop",
      permission: "granted",
      subscribed: true,
      busy: true,
    },
  });
  const { rerender } = openBehaviorSettings();
  const feedback = screen.getByRole("group", { name: "Notification status" });
  const testNotification = screen.getByRole("button", {
    name: "Send test notification",
  });
  expect(feedback).toHaveTextContent("Background notifications enabled");
  expect(testNotification).toBeDisabled();

  getState.mockReturnValue({
    ...getState(),
    taskAlerts: { ...getState().taskAlerts, busy: false },
  });
  rerender(<Settings />);
  expect(feedback).toHaveTextContent("Background notifications enabled");
  expect(testNotification).toBeEnabled();
});

describe("PresentationAdapterSettings", () => {
  afterEach(() => {
    configurePresentationAdapters(emptyToolPresentationConfiguration());
    vi.restoreAllMocks();
  });

  it("keeps an adapter save in its switch and reports failure without claiming success", async () => {
    configurePresentationAdapters(emptyToolPresentationConfiguration(), [
      { id: "example", name: "Example", enabled: true },
    ]);
    const pending = deferred<void>();
    vi.spyOn(store, "setPresentationAdapterEnabled").mockReturnValue(
      pending.promise,
    );
    render(<PresentationAdapterSettings />);
    const toggle = screen.getByRole("switch", { name: "Example" });
    fireEvent.click(toggle);
    expect(store.setPresentationAdapterEnabled).toHaveBeenCalledWith(
      "example",
      false,
    );
    expect(toggle).toBeDisabled();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    await act(async () => pending.reject(new Error("Could not save adapter")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save adapter",
    );
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute("aria-busy", "false");
  });
});
