// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PiLoader } from "../../src/components/PiLoader";
import { PiStatus } from "../../src/components/PiStatus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps the current cycle through phase/label updates, then reselects at the outer boundary only", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const view = render(<PiLoader aria-label="generating arguments" />);
  expect(view.container.firstChild).toHaveAttribute("data-variant", "rows");
  random.mockReturnValue(0.9999);
  view.rerender(<PiLoader aria-label="running" />);
  expect(view.container.firstChild).toHaveAttribute("data-variant", "rows");
  expect(random).toHaveBeenCalledTimes(1);
  const iterate = (target: Element) => {
    // jsdom exposes WebkitAnimation but no AnimationEvent, so React listens to the prefixed event.
    const event = new Event("webkitAnimationIteration", { bubbles: true });
    Object.assign(event, { animationName: "pi-loading-cycle" });
    fireEvent(target, event);
  };
  iterate(view.container.querySelector("rect")!);
  expect(random).toHaveBeenCalledTimes(1);
  iterate(view.container.querySelector("svg")!);
  expect(random).toHaveBeenCalledTimes(2);
  expect(view.container.firstChild).toHaveAttribute("data-variant", "gather");
  iterate(view.container.querySelector("svg")!);
  expect(random).toHaveBeenCalledTimes(3);
  expect(view.container.firstChild).toHaveAttribute("data-variant", "gather");
  view.unmount();
  const next = render(<PiLoader />);
  expect(next.container.firstChild).toHaveAttribute("data-variant", "gather");
});

it("selects all seven patterns from equal random intervals", () => {
  const random = vi.spyOn(Math, "random");
  for (const [index, pattern] of [
    "rows",
    "columns",
    "trace",
    "breathe",
    "spread",
    "relay",
    "gather",
  ].entries()) {
    random.mockReturnValue((index + 0.5) / 7);
    const view = render(<PiLoader />);
    expect(view.container.firstChild).toHaveAttribute("data-variant", pattern);
    view.unmount();
  }
});

it("preserves the caller's square slot and accessible label", () => {
  const { getByLabelText } = render(
    <PiLoader size={12} aria-label="Loading content" className="status-icon" />,
  );
  const icon = getByLabelText("Loading content");
  expect(icon).toHaveAttribute("width", "12");
  expect(icon).toHaveAttribute("height", "12");
  expect(icon).not.toHaveAttribute("aria-hidden", "true");
  expect(icon).toHaveClass("status-icon");
});

it.each(["success", "error"] as const)(
  "keeps %s static and aligned with the loading slot",
  (status) => {
    const { getByLabelText } = render(
      <PiStatus size={12} status={status} aria-label={status} />,
    );
    const icon = getByLabelText(status);
    expect(icon).toHaveAttribute("width", "12");
    expect(icon).toHaveAttribute("viewBox", "0 0 16 16");
    expect(icon).not.toHaveClass("pi-loading");
    expect(icon).toHaveAttribute("height", "12");
    expect(icon).toHaveAttribute("data-status", status);
  },
);

it("can stay decorative alongside an existing status label", () => {
  const { container } = render(<PiLoader />);
  expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
});
