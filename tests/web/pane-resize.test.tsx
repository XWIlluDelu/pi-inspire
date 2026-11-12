// @vitest-environment jsdom
import { createEvent, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "../../src/components/PaneResizeHandle";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--ctx-w");
});

it("forwards normalized wheel input without swallowing zoom or boundary gestures", () => {
  const view = render(
    <>
      <aside className="ctx" />
      <PaneResizeHandle
        cssVar="--ctx-w"
        storageKey="inspire.ctx-wheel"
        paneSelector=".ctx"
        edge="start"
        min={320}
        max={() => 920}
        label="Resize files panel"
        wheelTargetSelector=".wheel-target[data-pane-scroll-active='true']"
      />
      <div
        className="wheel-target wheel-target--hidden"
        data-pane-scroll-active="true"
      />
      <div className="wheel-target" data-pane-scroll-active="true" />
    </>,
  );
  const target = view.container.querySelector<HTMLElement>(
    ".wheel-target:not(.wheel-target--hidden)",
  )!;
  const hiddenTarget = view.container.querySelector<HTMLElement>(
    ".wheel-target--hidden",
  )!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 100),
  );
  for (const element of [hiddenTarget, target])
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 100 },
    });
  const handle = view.getByRole("separator", {
    name: "Resize files panel",
  });

  const lineWheel = createEvent.wheel(handle, {
    clientY: 50,
    deltaY: 3,
    deltaMode: 1,
    cancelable: true,
  });
  const consumeLine = vi.spyOn(lineWheel, "preventDefault");
  fireEvent(handle, lineWheel);
  expect(consumeLine).toHaveBeenCalledOnce();
  const scrolled = target.scrollTop;
  expect(scrolled).toBeGreaterThan(3);
  expect(hiddenTarget.scrollTop).toBe(0);

  const zoomWheel = createEvent.wheel(handle, {
    clientY: 50,
    deltaY: 100,
    ctrlKey: true,
    cancelable: true,
  });
  const consumeZoom = vi.spyOn(zoomWheel, "preventDefault");
  fireEvent(handle, zoomWheel);
  expect(consumeZoom).not.toHaveBeenCalled();
  expect(target.scrollTop).toBe(scrolled);

  target.scrollTop = 900;
  const boundaryWheel = createEvent.wheel(handle, {
    clientY: 50,
    deltaY: 1,
    cancelable: true,
  });
  const consumeBoundary = vi.spyOn(boundaryWheel, "preventDefault");
  fireEvent(handle, boundaryWheel);
  expect(consumeBoundary).not.toHaveBeenCalled();
  expect(target.scrollTop).toBe(900);
});
