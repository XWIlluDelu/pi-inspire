// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContent } from "../../src/components/Settings";
import { SettingsDialog } from "../../src/components/SettingsDialog";

function Settings({ onClose }: { onClose: () => void }) {
  return (
    <SettingsDialog onClose={onClose}>
      <SettingsContent />
    </SettingsDialog>
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Settings component UX and navigation", () => {
  it("uses five purpose-level categories without a redundant search surface", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });

    for (const name of [
      "Display",
      "Conversation",
      "Behavior",
      "Models",
      "System",
    ])
      expect(
        within(navigation).getByRole("button", { name }),
      ).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole("button", { name: "System" }));
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("marks and scrolls to the selected category", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });
    const conversation = within(navigation).getByRole("button", {
      name: "Conversation",
    });

    fireEvent.click(conversation);
    const section = screen.getByRole("region", { name: "Conversation" });
    expect(section).toBeVisible();
    expect(conversation).toHaveAttribute("aria-current", "location");
    expect(section.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
  });

  it("keeps all categories in one continuous settings document", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });
    const system = within(navigation).getByRole("button", { name: "System" });
    fireEvent.click(system);
    expect(system).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("region", { name: "Versions" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Conversation" })).toBeVisible();
  });

  it("presents the complete settings contract in its owning groups", () => {
    render(<Settings onClose={() => undefined} />);

    for (const name of [
      "Theme",
      "Color palette",
      "Content text size",
      "Reading width",
      "Project location",
      "Reasoning detail",
      "Tool activity",
      "Activity groups",
      "Assistant turn details",
      "Send key",
      "On launch",
      "Completion alerts",
      "Steering delivery",
      "Follow-up delivery",
      "Automatic context compaction",
      "Automatic retry",
    ])
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
  });

  it("explains every Activity groups density in the selector", () => {
    render(<Settings onClose={() => undefined} />);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings categories" }),
      ).getByRole("button", { name: "Conversation" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Activity groups" }));

    for (const description of [
      "Adjusts as live activity starts and finishes.",
      "Loads and shows every activity card.",
      "Shows up to the latest 24 cards.",
      "Shows only the group entry until opened.",
    ])
      expect(screen.getByText(description)).toBeInTheDocument();
  });

  it("provides Pi references in System and keeps reset in the utility footer", () => {
    render(<Settings onClose={() => undefined} />);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Settings categories" }),
      ).getByRole("button", { name: "System" }),
    );
    expect(screen.getByRole("link", { name: "Pi docs" })).toHaveAttribute(
      "href",
      "https://github.com/earendil-works/pi",
    );
    expect(screen.getByRole("link", { name: "Changelog" })).toHaveAttribute(
      "href",
      "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md",
    );
    expect(
      screen.getByRole("button", { name: "Reset preferences" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "About" })).toBeNull();
  });
});
