// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadingDwell } from "../../src/use-reading-dwell";

function Feedback({
  revision = 1,
  duration = 8_000,
  dismiss,
}: {
  revision?: number;
  duration?: number | null;
  dismiss: (revision: number) => void;
}) {
  const close = useCallback(() => dismiss(revision), [dismiss, revision]);
  const { ref, leaving } = useReadingDwell<HTMLDivElement>(duration, close);
  return (
    <div ref={ref} data-testid="feedback" data-leaving={leaving}>
      Reading feedback <button type="button">Copy</button>
      <button type="button">Close</button>
    </div>
  );
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function pointer(node: Element, type: string, pointerType = "mouse") {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(node, event);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("feedback reading dwell", () => {
  it("fades only after the dwell, and cancels an obsolete expiry on renewal/unmount", () => {
    const dismiss = vi.fn();
    const view = render(<Feedback dismiss={dismiss} />);
    const node = screen.getByTestId("feedback");
    advance(8_000);
    expect(node).toHaveAttribute("data-leaving", "true");
    expect(dismiss).not.toHaveBeenCalled();
    view.rerender(<Feedback revision={2} dismiss={dismiss} />);
    expect(screen.getByTestId("feedback")).toBe(node);
    expect(node).toHaveAttribute("data-leaving", "false");
    advance(8_149);
    expect(dismiss).not.toHaveBeenCalled();
    advance(1);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
    view.rerender(<Feedback revision={3} dismiss={dismiss} />);
    view.unmount();
    advance(8_150);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it.each(["hover", "focus", "press", "hidden"] as const)(
    "pauses while %s and gives three seconds to finish after a near-expiry pause",
    (mode) => {
      const dismiss = vi.fn();
      render(<Feedback dismiss={dismiss} />);
      const node = screen.getByTestId("feedback");
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      advance(7_900);
      if (mode === "hover") pointer(node, "pointerenter");
      if (mode === "press") pointer(node, "pointerdown", "touch");
      if (mode === "focus") {
        act(() => screen.getByRole("button", { name: "Copy" }).focus());
        act(() => screen.getByRole("button", { name: "Close" }).focus());
      }
      if (mode === "hidden") {
        hidden.mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      }
      advance(20_000);
      expect(dismiss).not.toHaveBeenCalled();
      expect(node).toHaveAttribute("data-leaving", "false");
      if (mode === "hover") pointer(node, "pointerleave");
      if (mode === "press") pointer(document.body, "pointerup", "touch");
      if (mode === "focus")
        act(() => (document.activeElement as HTMLElement).blur());
      if (mode === "hidden") {
        hidden.mockReturnValue(false);
        fireEvent(document, new Event("visibilitychange"));
      }
      advance(2_999);
      expect(node).toHaveAttribute("data-leaving", "false");
      advance(1);
      expect(node).toHaveAttribute("data-leaving", "true");
      advance(150);
      expect(dismiss).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

  it("preserves an active press across renewal and does not treat touch entry as hover", () => {
    const dismiss = vi.fn();
    const view = render(<Feedback dismiss={dismiss} />);
    const node = screen.getByTestId("feedback");
    pointer(node, "pointerenter", "touch");
    pointer(node, "pointerdown", "touch");
    view.rerender(<Feedback revision={2} dismiss={dismiss} />);
    advance(20_000);
    expect(dismiss).not.toHaveBeenCalled();
    pointer(node, "pointercancel", "touch");
    advance(8_150);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("resumes remaining reading time, not a fresh full dwell", () => {
    const dismiss = vi.fn();
    render(<Feedback duration={30_000} dismiss={dismiss} />);
    const node = screen.getByTestId("feedback");
    advance(10_000);
    pointer(node, "pointerenter");
    advance(40_000);
    pointer(node, "pointerleave");
    advance(20_000);
    expect(node).toHaveAttribute("data-leaving", "true");
    advance(150);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps persistent feedback and skips only the exit motion when motion is reduced", () => {
    const dismiss = vi.fn();
    const view = render(<Feedback duration={null} dismiss={dismiss} />);
    advance(120_000);
    expect(dismiss).not.toHaveBeenCalled();
    const media = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...media(query),
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    view.rerender(<Feedback dismiss={dismiss} />);
    advance(7_999);
    expect(dismiss).not.toHaveBeenCalled();
    advance(1);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(1);
  });
});
