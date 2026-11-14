// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSettingsDialog } from "../../src/components/TerminalSettingsDialog";
import {
  DEFAULT_TERMINAL_UI_SETTINGS,
  loadTerminalUiSettings,
} from "../../src/terminal-settings";
import { deferred, installLocalStorage } from "./helpers";

const service = { persistOutput: true, historyRetentionDays: 30 };
const api = {
  terminalSettings: vi.fn(),
  terminalOperation: vi.fn(),
};
function Dialog() {
  const [settings, setSettings] = useState(loadTerminalUiSettings);
  return (
    <TerminalSettingsDialog
      api={api}
      settings={settings}
      onSettingsChange={setSettings}
      onClose={() => undefined}
    />
  );
}
function navigate(name: string) {
  const button = within(
    screen.getByRole("navigation", { name: "Terminal settings categories" }),
  ).getByRole("button", { name });
  fireEvent.click(button);
  return button;
}
beforeEach(() => {
  vi.resetAllMocks();
  installLocalStorage();
  api.terminalSettings.mockResolvedValue(service);
});

afterEach(() => vi.unstubAllGlobals());

describe("Terminal notification permission", () => {
  it.each(["denied", "unavailable"] as const)(
    "explains %s permission beside the initiating control",
    async (permission) => {
      const requestPermission = vi.fn();
      vi.stubGlobal(
        "Notification",
        permission === "unavailable"
          ? undefined
          : { permission, requestPermission },
      );
      render(<Dialog />);
      await act(async () => {});
      navigate("Interaction");
      fireEvent.click(
        screen.getByRole("switch", { name: "Long task notifications" }),
      );
      await act(async () => {});
      const feedback =
        permission === "denied"
          ? "Blocked by browser"
          : "System notifications are unavailable";
      expect(screen.getByRole("status")).toHaveTextContent(feedback);
      expect(
        screen.getByRole("switch", { name: "Long task notifications" }),
      ).not.toBeChecked();
      const bell = screen.getByRole("combobox", {
        name: "Terminal bell behavior",
      });
      fireEvent.change(bell, { target: { value: "desktop" } });
      await act(async () => {});
      expect(screen.getByRole("status")).toHaveTextContent(feedback);
      expect(bell).toHaveValue("visual");
      expect(requestPermission).not.toHaveBeenCalled();
      fireEvent.change(bell, { target: { value: "off" } });
      await act(async () => {});
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("retires a permission selection when browser defaults are restored", async () => {
    const permission = deferred<NotificationPermission>();
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: () => permission.promise,
    });
    render(<Dialog />);
    await act(async () => {});
    navigate("Interaction");
    fireEvent.click(
      screen.getByRole("switch", { name: "Long task notifications" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore browser defaults" }),
    );
    await act(async () => permission.resolve("granted"));
    expect(
      screen.getByRole("switch", { name: "Long task notifications" }),
    ).not.toBeChecked();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("applies a delayed permission grant without reverting newer browser preferences", async () => {
    const permission = deferred<NotificationPermission>();
    const requestPermission = vi.fn(() => permission.promise);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    render(<Dialog />);
    await act(async () => {});
    navigate("Interaction");
    fireEvent.click(
      screen.getByRole("switch", { name: "Long task notifications" }),
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("switch", { name: "Protect terminal paste" }),
    );
    await act(async () => permission.resolve("granted"));
    expect(
      screen.getByRole("switch", { name: "Long task notifications" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Protect terminal paste" }),
    ).not.toBeChecked();
    expect(api.terminalOperation).not.toHaveBeenCalled();
  });
});

it("recovers unreadable preferences and keeps valid values in partial settings", () => {
  const key = "inspire:terminal-ui-settings:v1";
  localStorage.setItem(key, "invalid JSON");
  expect(loadTerminalUiSettings()).toEqual(DEFAULT_TERMINAL_UI_SETTINGS);
  localStorage.setItem(
    key,
    JSON.stringify({
      fontSize: 99,
      lineHeight: 0,
      cursorStyle: "invalid",
      scrollbackRows: -1,
      bell: "desktop",
      macOptionIsMeta: "true",
    }),
  );
  expect(loadTerminalUiSettings()).toEqual({
    ...DEFAULT_TERMINAL_UI_SETTINGS,
    bell: "desktop",
  });
});
