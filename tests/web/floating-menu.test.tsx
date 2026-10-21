import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

describe("floating menu coordinate ownership", () => {
  it.each([0, 80])(
    "keeps a downward menu at its viewport anchor with overlay scroll %s",
    (scroll) => {
      const placement = menuInOverlay({ scroll }).current!;
      expect(placement.direction).toBe("down");
      expect(placement.left + 18 - scroll).toBe(120);
      expect(placement.top! + 32 - scroll).toBe(232 + constraints.gap);
      expect(placement.maxHeight).toBe(300);
    },
  );

  it.each([0, 80])(
    "converts bottom offsets independently for upward menus with overlay scroll %s",
    (scroll) => {
      const anchorTop = window.innerHeight - 80;
      const placement = menuInOverlay({ anchorTop, scroll }).current!;
      expect(placement.direction).toBe("up");
      expect(window.innerHeight - placement.bottom! - scroll).toBe(
        anchorTop - constraints.gap,
      );
      expect(placement.left + 18 - scroll).toBe(120);
    },
  );

  it("bounds an upward menu below the titlebar, not the viewport origin", () => {
    const placement = menuInOverlay({ top: 40, bottom: 420, anchorTop: 240 })
      .current!;
    expect(placement.direction).toBe("up");
    expect(placement.maxHeight).toBe(188);
    expect(420 - placement.bottom! - placement.maxHeight).toBe(48);
  });

  it("keeps viewport coordinates for a body portal even when its anchor is in a dialog", () => {
    const placement = menuInOverlay({ portalInOverlay: false }).current!;
    expect(placement.left).toBe(120);
    expect(placement.top).toBe(236);
  });
});
