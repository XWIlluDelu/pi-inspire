// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContent } from "../../src/components/Settings";
import { SettingsDialog } from "../../src/components/SettingsDialog";
import { store } from "../../src/store";

function Settings({ onClose }: { onClose: () => void }) {
  return (
    <SettingsDialog onClose={onClose}>
      <SettingsContent workspaceOwner={{}} />
    </SettingsDialog>
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Settings component UX and navigation", () => {
  it("shows only the selected category and lands at its content top", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });
    const conversation = within(navigation).getByRole("button", {
      name: "Conversation",
    });

    const content = screen.getByRole("main");
    content.scrollTop = 240;
    fireEvent.click(conversation);
    expect(screen.getByRole("region", { name: "Conversation" })).toBeVisible();
    expect(conversation).toHaveAttribute("aria-current", "location");
    expect(content.scrollTop).toBe(0);
    expect(screen.queryByRole("region", { name: "Display" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "On launch" })).toBeNull();

    content.scrollTop = 80;
    fireEvent.click(conversation);
    expect(content.scrollTop).toBe(0);
    fireEvent.scroll(content, { target: { scrollTop: 120 } });
    expect(conversation).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("region", { name: "Conversation" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Display" })).toBeNull();
  });

  it("orders sections and controls from everyday preferences to runtime and host-level settings", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });

    const displayRegions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("id"));
    expect(displayRegions).toEqual(["settings-section-display"]);
    const displayLabels = Array.from(
      document.querySelectorAll(
        '[data-category="display"] .settings__field-label',
      ),
      (el) => el.textContent,
    );
    expect(displayLabels).toEqual([
      "Theme",
      "Color palette",
      "Content text size",
      "Reading width",
      "Project location",
      "Titlebar needles",
    ]);

    fireEvent.click(
      within(navigation).getByRole("button", { name: "Conversation" }),
    );
    const conversationRegions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("id"));
    expect(conversationRegions).toEqual(["settings-section-conversation"]);

    fireEvent.click(
      within(navigation).getByRole("button", { name: "Behavior" }),
    );
    const behaviorRegions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("id"));
    expect(behaviorRegions).toEqual([
      "settings-section-behavior",
      "settings-section-session-actions",
      "settings-section-pi-settings",
    ]);

    fireEvent.click(within(navigation).getByRole("button", { name: "System" }));
    const systemHeadings = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(systemHeadings).toEqual(["Versions", "Host"]);
  });

  it("requires confirmation before restoring interface preferences", () => {
    const restore = vi
      .spyOn(store, "restoreDefaultSettings")
      .mockImplementation(() => undefined);
    render(<Settings onClose={() => undefined} />);
    const reset = screen.getByRole("button", { name: "Reset preferences" });
    fireEvent.click(reset);
    const confirm = screen.getByRole("alertdialog", {
      name: "Reset preferences?",
    });
    expect(confirm).toHaveTextContent(
      "Restore Display, Conversation, Behavior, and Herdr preferences to their defaults.",
    );
    expect(confirm).toHaveTextContent(
      "Pi session settings, models, credentials, MCP servers, and pinned or hidden sessions stay unchanged.",
    );
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("alertdialog", { name: "Reset preferences?" }),
    ).toBeNull();
    expect(restore).not.toHaveBeenCalled();

    fireEvent.click(reset);
    const reopened = screen.getByRole("alertdialog", {
      name: "Reset preferences?",
    });
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Reset preferences" }),
    );
    expect(restore).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("alertdialog", { name: "Reset preferences?" }),
    ).toBeNull();
  });
});
