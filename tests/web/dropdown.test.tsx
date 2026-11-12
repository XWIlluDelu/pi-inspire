// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dropdown } from "../../src/components/Dropdown";

describe("dropdown interactions", () => {
  it("focuses an opted-in trigger once without opening or selecting", () => {
    const change = vi.fn();
    const props = {
      label: "Exposure",
      value: "inherit",
      options: [{ value: "inherit", label: "Inherit" }],
      onChange: change,
      autoFocus: true,
    };
    const view = render(
      <>
        <button type="button">Another control</button>
        <Dropdown {...props} />
      </>,
    );
    const trigger = screen.getByRole("combobox", { name: "Exposure" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(change).not.toHaveBeenCalled();
    const other = screen.getByRole("button", { name: "Another control" });
    other.focus();
    view.rerender(
      <>
        <button type="button">Another control</button>
        <Dropdown {...props} disabled />
      </>,
    );
    view.rerender(
      <>
        <button type="button">Another control</button>
        <Dropdown {...props} />
      </>,
    );
    expect(other).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

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
    expect(medium).toHaveAttribute("aria-selected", "true");

    fireEvent.pointerMove(high!, { pointerType: "mouse" });
    fireEvent.pointerLeave(high!);
    expect(trigger).toHaveFocus();
    expect(trigger).not.toHaveAttribute("aria-activedescendant");
    expect(medium).toHaveAttribute("aria-selected", "true");
    expect(high).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(trigger).toHaveAttribute("aria-activedescendant", medium!.id);
    fireEvent.pointerLeave(screen.getByRole("listbox"));
    expect(trigger).toHaveAttribute("aria-activedescendant", medium!.id);
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger).toHaveAttribute("aria-activedescendant", low!.id);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("low");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses on outside clicks and keeps the value when disabled", () => {
    const change = vi.fn();
    const props = {
      label: "Delivery",
      value: "all",
      options: [
        { value: "all", label: "All at once" },
        { value: "one", label: "One at a time" },
      ],
      onChange: change,
    };
    const view = render(<Dropdown {...props} />);
    const trigger = screen.getByRole("combobox", { name: "Delivery" });
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox");
    fireEvent.pointerDown(list);
    expect(list).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(list).not.toBeInTheDocument();
    fireEvent.click(trigger);

    view.rerender(<Dropdown {...props} disabled />);
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();

    view.rerender(<Dropdown {...props} />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent("All at once");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "One at a time" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("one");
  });
});
