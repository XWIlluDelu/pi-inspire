import { renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useFloatingMenuPlacement } from "../../src/use-floating-menu";

const constraints = {
  gap: 4,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: 520,
  maxHeight: 300,
};
const roots: HTMLElement[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.remove();
});

function menuInOverlay({
  top = 32,
  bottom = window.innerHeight,
  anchorTop = 200,
  scroll = 0,
  portalInOverlay = true,
} = {}) {
  const root = document.createElement("div");
  root.className = "overlay";
  const context = document.createElement("button");
  root.append(context);
  document.body.append(root);
  roots.push(root);
  const box = new DOMRect(18, top, window.innerWidth - 18, bottom - top);
  root.getBoundingClientRect = () => box;
  Object.defineProperties(root, {
    clientWidth: { value: box.width },
    clientHeight: { value: box.height },
  });
  root.scrollTop = scroll;
  root.scrollLeft = scroll;
  return renderHook(() =>
    useFloatingMenuPlacement(
      true,
      () => ({
        context,
        anchor: {
          left: 120,
          right: 280,
          top: anchorTop,
          bottom: anchorTop + 32,
        },
        positioningRoot: portalInOverlay ? root : undefined,
        preferredWidth: 200,
      }),
      constraints,
    ),
  ).result;
}

it("anchors a downward menu in either a body or a scrolled overlay portal", () => {
  const scroll = 80;
  const body = menuInOverlay({ scroll, portalInOverlay: false }).current!;
  const overlay = menuInOverlay({ scroll }).current!;
  expect(body).toMatchObject({ direction: "down", left: 120, top: 236 });
  expect(overlay).toMatchObject({
    direction: "down",
    left: body.left - 18 + scroll,
    top: body.top! - 32 + scroll,
  });
});

it("keeps an upward menu anchored and below the titlebar in a scrolled overlay", () => {
  const scroll = 80;
  const placement = menuInOverlay({
    top: 40,
    bottom: 420,
    anchorTop: 240,
    scroll,
  }).current!;
  expect(placement.direction).toBe("up");
  const bottom = 420 - placement.bottom! - scroll;
  expect(bottom).toBe(240 - constraints.gap);
  expect(bottom - placement.maxHeight).toBe(40 + constraints.verticalMargin);
});
