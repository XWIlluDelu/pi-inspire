// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PI_LOADING_VARIANTS, PiLoader } from "../../src/components/PiLoader";
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

it.each(PI_LOADING_VARIANTS)(
  "keeps the seven-cell Π and caller's slot/accessible label for %s",
  (variant) => {
    const { container, getByLabelText } = render(
      <PiLoader
        size={12}
        variant={variant}
        aria-label="Loading content"
        className="status-icon"
      />,
    );
    const icon = getByLabelText("Loading content");
    expect(icon).toHaveAttribute("width", "12");
    expect(icon).toHaveAttribute("height", "12");
    expect(icon).not.toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("status-icon");
    expect(icon).not.toHaveClass("spin");
    const points = [...container.querySelectorAll("rect")].map((dot) => [
      Number(dot.getAttribute("x")) + Number(dot.getAttribute("width")) / 2,
      Number(dot.getAttribute("y")) + Number(dot.getAttribute("height")) / 2,
    ]);
    expect(points).toEqual([
      [3.1, 3.1],
      [8, 3.1],
      [12.9, 3.1],
      [3.1, 8],
      [12.9, 8],
      [3.1, 12.9],
      [12.9, 12.9],
    ]);
    const random = vi.spyOn(Math, "random");
    const boundary = new Event("webkitAnimationIteration", { bubbles: true });
    Object.assign(boundary, { animationName: "pi-loading-cycle" });
    fireEvent(icon, boundary);
    expect(icon).toHaveAttribute("data-variant", variant);
    expect(random).not.toHaveBeenCalled();
    const xs = points.map(([x]) => x!);
    const ys = points.map(([, y]) => y!);
    const ratio =
      (Math.max(...xs) - Math.min(...xs) + 2) /
      (Math.max(...ys) - Math.min(...ys) + 2);
    expect(ratio).toBeCloseTo(1);
  },
);

it.each(["success", "error"] as const)(
  "keeps %s static and aligned with the loading slot",
  (status) => {
    const { container, getByLabelText } = render(
      <PiStatus size={12} status={status} aria-label={status} />,
    );
    const icon = getByLabelText(status);
    expect(icon).toHaveAttribute("width", "12");
    expect(icon).toHaveAttribute("viewBox", "0 0 16 16");
    expect(icon).not.toHaveClass("pi-loading");
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelectorAll("rect")).toHaveLength(
      status === "success" ? 3 : 5,
    );
    expect(container.querySelector("path")).toHaveAttribute(
      "stroke",
      "currentColor",
    );
  },
);

it("can stay decorative alongside an existing status label", () => {
  const { container } = render(<PiLoader />);
  expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
});
