// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHelp } from "../../src/components/CommandHelp";

const installedPiChangelog = vi.hoisted(() => vi.fn());
const preferences = vi.hoisted(() => ({
  desktopSendKey: "enter" as "enter" | "mod-enter",
}));
vi.mock("../../src/store", () => ({
  store: { installedPiChangelog },
  useAppState: (select: (state: unknown) => unknown) =>
    select({ prefs: preferences }),
}));
vi.mock("../../src/components/ProgressiveRichText", () => ({
  ProgressiveRichText: ({ text }: { text: string }) => <div>{text}</div>,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  installedPiChangelog.mockReset();
  preferences.desktopSendKey = "enter";
});
afterEach(cleanup);

describe("release-note dialog states", () => {
  it("uses shared loading/error states, then retries into the installed document", async () => {
    const first = deferred<{ version: string; markdown: string }>();
    const retry = deferred<{ version: string; markdown: string }>();
    installedPiChangelog
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    render(<CommandHelp mode="changelog" onClose={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveClass("res__state");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading installed release notes",
    );
    await act(async () =>
      first.reject(new Error("The installed package could not be read.")),
    );
    const error = screen.getByRole("alert");
    expect(error).toHaveClass("res__state");
    expect(error).toHaveTextContent("Release notes unavailable");
    expect(error).toHaveTextContent("The installed package could not be read.");
    const button = within(error).getByRole("button", { name: "Retry" });
    expect(button).toHaveClass("button--quiet", "res__state-action");
    fireEvent.click(button);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toBeVisible();
    await act(async () =>
      retry.resolve({ version: "1.2.3", markdown: "Installed release text" }),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Pi 1.2.3 release notes" }),
    ).toBeVisible();
    expect(screen.getByText("Installed release text")).toBeVisible();
    expect(installedPiChangelog).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the generic unavailable title as its hint", async () => {
    installedPiChangelog.mockRejectedValue(null);
    render(<CommandHelp mode="changelog" onClose={vi.fn()} />);
    const error = await screen.findByRole("alert");
    expect(error.querySelector(".res__state-hint")).toBeNull();
    expect(within(error).getByText("Release notes unavailable")).toBeVisible();
  });
});

describe("shortcut help", () => {
  it.each(["enter", "mod-enter"] as const)(
    "shows one complete chord per keycap with %s send mode",
    (mode) => {
      preferences.desktopSendKey = mode;
      render(<CommandHelp mode="hotkeys" onClose={vi.fn()} />);
      const composer = within(
        screen.getByRole("heading", { name: "Composer" }).closest("section")!,
      );
      const send = composer
        .getByText("Send with the selected delivery mode (desktop)")
        .closest("div")!;
      expect(
        Array.from(send.querySelectorAll("kbd"), (node) => node.textContent),
      ).toEqual([mode === "enter" ? "Enter" : "Ctrl/⌘+Enter"]);
      const lineBreak = composer
        .getByText("Insert a line break (Alt+Enter also works)")
        .closest("div")!;
      expect(
        Array.from(
          lineBreak.querySelectorAll("kbd"),
          (node) => node.textContent,
        ),
      ).toEqual(mode === "enter" ? ["Shift+Enter"] : ["Enter", "Shift+Enter"]);
      const completion = composer
        .getByText("Choose and insert a completion")
        .closest("div")!;
      expect(
        Array.from(
          completion.querySelectorAll(".command-help__key-step"),
          (step) =>
            Array.from(
              step.querySelectorAll("kbd"),
              (node) => node.textContent,
            ),
        ),
      ).toEqual([
        ["↑", "↓"],
        ["Enter", "Tab"],
      ]);
      expect(screen.getByText("Ctrl/⌘+K", { selector: "kbd" })).toBeVisible();
      const terminal = screen
        .getByRole("heading", { name: "Project terminal" })
        .closest("section")!;
      expect(
        Array.from(
          terminal.querySelectorAll("kbd"),
          (node) => node.textContent,
        ),
      ).toEqual([
        "Ctrl/⌘+F",
        "Ctrl/⌘+PgUp",
        "Ctrl/⌘+PgDn",
        "Alt+1–9",
        "Ctrl/⌘+Shift+`",
        "←",
        "→",
        "Ctrl/⌘+Shift+←",
        "Ctrl/⌘+Shift+→",
        "Ctrl+Shift+Esc",
        "Ctrl/⌘+C",
        "Ctrl/⌘+V",
        "Enter",
        "Shift+Enter",
      ]);
      expect(
        screen.getByText("Alt+Shift+M", { selector: "kbd" }),
      ).toBeVisible();
      expect(
        screen.getByText("Alt+Shift+P", { selector: "kbd" }),
      ).toBeVisible();
    },
  );

  it("keeps shortcut help synchronous and independent of release-note states", () => {
    render(<CommandHelp mode="hotkeys" onClose={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    expect(
      screen.getByText("IME composition: Enter confirms, never submits.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    expect(installedPiChangelog).not.toHaveBeenCalled();
  });
});
