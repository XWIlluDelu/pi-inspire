// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/components/Settings";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Settings component UX and navigation", () => {
  it("uses three purpose-level categories without a redundant search surface", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });

    for (const name of ["Display", "Conversation", "Behavior"])
      expect(
        within(navigation).getByRole("button", { name }),
      ).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("marks and scrolls to the selected category", async () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });
    const conversation = within(navigation).getByRole("button", {
      name: "Conversation",
    });

    fireEvent.click(conversation);
    const section = screen.getByRole("region", { name: "Conversation" });
    await waitFor(() => expect(section.scrollIntoView).toHaveBeenCalled());
    expect(conversation).toHaveAttribute("aria-current", "true");
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
      "Desktop send key",
      "On launch",
      "Completion alerts",
    ])
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);

    expect(
      screen.getByText(
        "Set how grouped activity is loaded and shown by default.",
      ),
    ).toBeInTheDocument();
  });

  it("explains every Activity groups density in the selector", () => {
    render(<Settings onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Activity groups" }));

    for (const description of [
      "Adjusts as live activity starts and finishes.",
      "Loads and shows every activity card.",
      "Shows up to the latest 24 cards.",
      "Shows only the group entry until opened.",
    ])
      expect(screen.getByText(description)).toBeInTheDocument();
  });

  it("keeps About and reset actions in the utility footer", () => {
    render(<Settings onClose={() => undefined} />);
    expect(
      screen.getByRole("link", { name: "Pi Coding Agent" }),
    ).toHaveAttribute("href", "https://github.com/earendil-works/pi");
    expect(
      screen.getByRole("button", { name: "Restore defaults" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "About" })).toBeNull();
  });
});
