// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContent } from "../../src/components/Settings";
import { SettingsDialog } from "../../src/components/SettingsDialog";

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
});
