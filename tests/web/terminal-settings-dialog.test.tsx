// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalServiceSettings } from "../../shared/terminal-contracts";
import type { createApi } from "../../src/api";
import { TerminalSettingsDialog } from "../../src/components/TerminalSettingsDialog";
import { DEFAULT_TERMINAL_UI_SETTINGS } from "../../src/terminal-settings";
import { installLocalStorage } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const service = { persistOutput: true, historyRetentionDays: 30 };
const api = {
  terminalSettings: vi.fn(),
  updateTerminalSettings: vi.fn(),
  clearTerminalHistory: vi.fn(),
};
function Dialog() {
  const [settings, setSettings] = useState(DEFAULT_TERMINAL_UI_SETTINGS);
  return (
    <TerminalSettingsDialog
      api={api as unknown as ReturnType<typeof createApi>}
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

describe("Terminal settings categories", () => {
  it("exposes one category and lands at the top on switches and reselection", async () => {
    render(<Dialog />);
    await act(async () => {});
    const content = screen.getByRole("main");
    expect(screen.getByRole("region", { name: "Appearance" })).toBeVisible();
    expect(
      screen.queryByRole("switch", { name: "Protect terminal paste" }),
    ).toBeNull();
    content.scrollTop = 240;
    const interaction = navigate("Interaction");
    expect(content.scrollTop).toBe(0);
    expect(screen.getByRole("region", { name: "Interaction" })).toBeVisible();
    expect(
      screen.queryByRole("group", { name: "Terminal font size" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Persist terminal output" }),
    ).toBeNull();
    fireEvent.scroll(content, { target: { scrollTop: 120 } });
    expect(interaction).toHaveAttribute("aria-current", "location");
    navigate("Interaction");
    expect(content.scrollTop).toBe(0);
    expect(
      screen.getByRole("button", { name: "Restore browser defaults" }),
    ).toBeVisible();
  });

  it("keeps immediate browser changes across categories and resets only browser defaults", async () => {
    render(<Dialog />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Increase terminal font size" }),
    );
    navigate("Interaction");
    fireEvent.click(
      screen.getByRole("switch", { name: "Protect terminal paste" }),
    );
    navigate("Saved output");
    expect(
      screen.getByRole("switch", { name: "Persist terminal output" }),
    ).toBeChecked();
    navigate("Appearance");
    expect(
      screen.getByText(`${DEFAULT_TERMINAL_UI_SETTINGS.fontSize + 1}px`),
    ).toBeVisible();
    navigate("Interaction");
    expect(
      screen.getByRole("switch", { name: "Protect terminal paste" }),
    ).not.toBeChecked();
    expect(
      JSON.parse(
        window.localStorage.getItem("inspire:terminal-ui-settings:v1")!,
      ),
    ).toMatchObject({
      fontSize: DEFAULT_TERMINAL_UI_SETTINGS.fontSize + 1,
      pasteProtection: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore browser defaults" }),
    );
    expect(
      screen.getByRole("switch", { name: "Protect terminal paste" }),
    ).toBeChecked();
    expect(api.updateTerminalSettings).not.toHaveBeenCalled();
    expect(api.clearTerminalHistory).not.toHaveBeenCalled();
  });

  it("completes Host loading and saves while their category is hidden", async () => {
    const read = deferred<TerminalServiceSettings>();
    const save = deferred<TerminalServiceSettings>();
    api.terminalSettings.mockReturnValue(read.promise);
    api.updateTerminalSettings.mockReturnValue(save.promise);
    render(<Dialog />);
    navigate("Saved output");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading Host settings",
    );
    navigate("Appearance");
    await act(async () => read.resolve(service));
    navigate("Saved output");
    fireEvent.click(
      screen.getByRole("combobox", { name: "Terminal output retention" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "90 days" }));
    expect(api.updateTerminalSettings).toHaveBeenCalledWith({
      historyRetentionDays: 90,
    });
    navigate("Interaction");
    navigate("Saved output");
    expect(
      screen.getByRole("combobox", { name: "Terminal output retention" }),
    ).toBeDisabled();
    navigate("Interaction");
    await act(async () =>
      save.resolve({ ...service, historyRetentionDays: 90 }),
    );
    navigate("Saved output");
    expect(
      screen.getByRole("combobox", { name: "Terminal output retention" }),
    ).toHaveTextContent("90 days");
    expect(
      screen.getByRole("combobox", { name: "Terminal output retention" }),
    ).toBeEnabled();
    expect(api.terminalSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps clear progress and its failure visible after switching away", async () => {
    const clear = deferred<{ ok: boolean }>();
    api.clearTerminalHistory.mockReturnValue(clear.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Dialog />);
    await act(async () => {});
    navigate("Saved output");
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    navigate("Appearance");
    navigate("Saved output");
    expect(screen.getByRole("button", { name: "Clearing…" })).toBeDisabled();
    navigate("Appearance");
    await act(async () => clear.reject(new Error("Host unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Host unavailable");
    navigate("Saved output");
    expect(screen.getByRole("button", { name: "Clear history" })).toBeEnabled();
    confirm.mockRestore();
  });
});
