// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTouchKeys } from "../../src/components/TerminalTouchKeys";
import { NO_TERMINAL_MODIFIERS } from "../../src/terminal-input";

afterEach(cleanup);

describe("terminal touch keys", () => {
  it("separates fixed arrows from scrollable keys while retaining key and modifier intents", () => {
    const onKey = vi.fn();
    const onToggleModifier = vi.fn();
    const { container, rerender } = render(
      <TerminalTouchKeys
        disabled={false}
        modifiers={NO_TERMINAL_MODIFIERS}
        onKey={onKey}
        onToggleModifier={onToggleModifier}
      />,
    );
    const arrows = screen.getByRole("group", { name: "Arrow keys" });
    for (const [name, key] of [
      ["Arrow left", "ArrowLeft"],
      ["Arrow up", "ArrowUp"],
      ["Arrow down", "ArrowDown"],
      ["Arrow right", "ArrowRight"],
    ]) {
      const button = screen.getByRole("button", { name });
      expect(arrows).toContainElement(button);
      fireEvent.click(button);
      expect(onKey).toHaveBeenLastCalledWith(key);
    }
    const scroll = container.querySelector(".terminal-touch-keys__scroller")!;
    for (const [name, key] of [
      ["Esc", "Escape"],
      ["Ctrl+C", "Interrupt"],
      ["Tab", "Tab"],
      ["Home", "Home"],
      ["End", "End"],
      ["PgUp", "PageUp"],
      ["PgDn", "PageDown"],
    ]) {
      const button = screen.getByRole("button", { name });
      expect(scroll).toContainElement(button);
      fireEvent.click(button);
      expect(onKey).toHaveBeenLastCalledWith(key);
    }
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    expect(onToggleModifier).toHaveBeenLastCalledWith("ctrl");
    rerender(
      <TerminalTouchKeys
        disabled={false}
        modifiers={{ ctrl: true, alt: false }}
        onKey={onKey}
        onToggleModifier={onToggleModifier}
      />,
    );
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Alt" }));
    expect(onToggleModifier).toHaveBeenLastCalledWith("alt");
    rerender(
      <TerminalTouchKeys
        disabled={true}
        modifiers={NO_TERMINAL_MODIFIERS}
        onKey={onKey}
        onToggleModifier={onToggleModifier}
      />,
    );
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
    const pointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    screen.getByRole("group", { name: "Terminal keys" }).dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
  });

  it("fits complete key slots and shows cues only toward hidden keys", () => {
    const { container } = render(
      <TerminalTouchKeys
        disabled={false}
        modifiers={NO_TERMINAL_MODIFIERS}
        onKey={() => {}}
        onToggleModifier={() => {}}
      />,
    );
    const scroll = container.querySelector<HTMLElement>(
      ".terminal-touch-keys__scroller",
    )!;
    const extras = container.querySelector(".terminal-touch-keys__extras")!;
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 118 },
      scrollWidth: { configurable: true, value: 400 },
    });
    fireEvent.scroll(scroll);
    expect(extras).toHaveStyle({ "--visible-keys": "2" });
    expect(extras).toHaveAttribute("data-scroll-start", "false");
    expect(extras).toHaveAttribute("data-scroll-end", "true");
    Object.defineProperty(scroll, "clientWidth", { value: 188 });
    fireEvent.scroll(scroll);
    expect(extras).toHaveStyle({ "--visible-keys": "3" });
    scroll.scrollLeft = 50;
    fireEvent.scroll(scroll);
    expect(extras).toHaveAttribute("data-scroll-start", "true");
    expect(extras).toHaveAttribute("data-scroll-end", "true");
    scroll.scrollLeft = 300;
    fireEvent.scroll(scroll);
    expect(extras).toHaveAttribute("data-scroll-end", "false");
    scroll.scrollLeft = 0;
    Object.defineProperty(scroll, "clientWidth", { value: 400 });
    fireEvent.scroll(scroll);
    expect(extras).toHaveAttribute("data-scroll-start", "false");
    expect(extras).toHaveAttribute("data-scroll-end", "false");
  });
});
