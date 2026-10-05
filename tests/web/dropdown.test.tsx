// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dropdown } from "../../src/components/Dropdown";

describe("dropdown navigation highlight", () => {
  it("clears pointer highlight on leave and keeps selection separate from keyboard navigation", () => {
    const change = vi.fn();
    render(
      <Dropdown
        label="Effort"
        value="medium"
        options={["low", "medium", "high"].map((value) => ({
          value,
          label: value,
        }))}
        onChange={change}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Effort" });
    trigger.focus();
    fireEvent.click(trigger);
    const [low, medium, high] = screen.getAllByRole("option");
    expect(medium).toHaveClass("dropdown__option--active");
    expect(medium).toHaveAttribute("aria-selected", "true");

    fireEvent.pointerMove(high!, { pointerType: "mouse" });
    fireEvent.pointerLeave(high!);
    for (const option of [low, medium, high])
      expect(option).not.toHaveClass("dropdown__option--active");
    expect(trigger).toHaveFocus();
    expect(trigger).not.toHaveAttribute("aria-activedescendant");
    expect(medium).toHaveAttribute("aria-selected", "true");
    expect(high).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(medium).toHaveClass("dropdown__option--active");
    expect(trigger).toHaveAttribute("aria-activedescendant", medium!.id);
    fireEvent.pointerLeave(screen.getByRole("listbox"));
    expect(medium).toHaveClass("dropdown__option--active");
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(low).toHaveClass("dropdown__option--active");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("low");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("portals outside a clipped field and flips/clamps a bottom-edge trigger", () => {
    const rect = new DOMRect(950, 700, 60, 32);
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(rect);
    const view = render(
      <div style={{ overflow: "hidden" }}>
        <Dropdown
          label="Delivery"
          value="all"
          options={[
            { value: "all", label: "All at once" },
            { value: "one", label: "One at a time" },
          ]}
          onChange={vi.fn()}
        />
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "Delivery" });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole("listbox", { name: "Delivery" });
    expect(view.container).not.toContainElement(menu);
    expect(menu).toHaveAttribute("data-placement", "up");
    expect(menu).toHaveStyle({
      width: "148px",
      left: "860px",
      bottom: "72px",
      maxHeight: "300px",
    });
    expect(trigger).toHaveFocus();
    fireEvent.pointerDown(menu);
    expect(menu).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(menu).not.toBeInTheDocument();
    bounds.mockRestore();
  });
});
