import { useEffect, useRef } from "react";

/**
 * Overlay scrollbar riding a pane boundary (technique learned from the
 * docdoki panel library): the native bar is hidden and a fixed-position
 * thumb straddles the pane's edge — the nav's right border, the context
 * pane's left border — or, for the reading column, floats in the margin
 * beside the text. It is purely a pointer affordance: wheel and keyboard
 * scrolling stay native, so it renders aria-hidden and never takes focus.
 */
export function ScrollRail({
  container,
  scroller,
  variant,
  onUserScroll,
}: {
  /** Stable ancestor that defines the boundary and hosts the scroller. */
  container: React.RefObject<HTMLElement | null>;
  /** Selector resolving the scroller inside container; omit when the
   * container scrolls itself. Re-resolved on every sync, so swapped
   * elements (preview kinds) rebind automatically. */
  scroller?: string;
  variant: "nav" | "ctx" | "reading";
  /** Called before this overlay directly moves the scroller. */
  onUserScroll?: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const thumb = thumbRef.current;
    const root = container.current;
    if (!rail || !thumb || !root) return;

    let el: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let hideTimer: number | null = null;
    let frame: number | null = null;
    let drag: { y: number; top: number; maxTop: number; range: number } | null =
      null;
    let geo: { maxTop: number; range: number } | null = null;

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(sync);
    };

    const resolve = () => {
      const next = scroller ? root.querySelector<HTMLElement>(scroller) : root;
      if (next === el) return;
      resizeObserver?.disconnect();
      resizeObserver = null;
      el = next;
      if (el) {
        resizeObserver = new ResizeObserver(schedule);
        resizeObserver.observe(el);
      }
    };

    /** Thumb center line x plus travel top/height, in viewport coordinates. */
    const geometry = () => {
      const rect = el!.getBoundingClientRect();
      if (variant === "nav") {
        return {
          x: root.getBoundingClientRect().right,
          top: rect.top + 6,
          height: rect.height - 12,
        };
      }
      if (variant === "ctx") {
        return {
          x: root.getBoundingClientRect().left,
          top: rect.top + 6,
          height: rect.height - 12,
        };
      }
      // reading: a mid-height rail floating in the margin right of the
      // reading column — offset grows with the available whitespace so it
      // never crowds the text, and the long travel keeps dragging precise.
      const column = el!
        .querySelector(".transcript__column")
        ?.getBoundingClientRect();
      const columnRight = column ? column.right : rect.left + rect.width / 2;
      const gap = rect.right - columnRight;
      const height = Math.max(
        280,
        Math.min(rect.height * 0.62, rect.height - 120),
      );
      const x = Math.min(
        columnRight + Math.max(28, Math.min(gap * 0.5, 72)),
        rect.right - 14,
      );
      return { x, top: rect.top + (rect.height - height) / 2, height };
    };

    const sync = () => {
      frame = null;
      resolve();
      if (!el || !el.isConnected) {
        rail.style.display = "none";
        geo = null;
        return;
      }
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      const g = geometry();
      if (sh <= ch + 1 || g.height < 64) {
        rail.style.display = "none";
        geo = null;
        return;
      }
      const minThumb = variant === "reading" ? 48 : 32;
      const th = Math.min(
        g.height,
        Math.max(minThumb, Math.round((g.height * ch) / sh)),
      );
      const maxTop = g.height - th;
      rail.style.display = "block";
      rail.style.left = `${Math.round(g.x)}px`;
      rail.style.top = `${Math.round(g.top)}px`;
      rail.style.height = `${Math.round(g.height)}px`;
      thumb.style.height = `${th}px`;
      thumb.style.top = `${Math.round((el.scrollTop / (sh - ch)) * maxTop)}px`;
      geo = { maxTop, range: sh - ch };
    };

    const reveal = () => {
      rail.classList.add("srail--show");
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (!drag) rail.classList.remove("srail--show");
      }, 900);
    };

    // scroll does not bubble but reaches document in the capture phase, so
    // one listener follows the scroller even after it is swapped out.
    const onScroll = (event: Event) => {
      if (event.target === el) {
        schedule();
        reveal();
      }
    };
    const onThumbDown = (event: MouseEvent) => {
      if (event.button !== 0 || !geo || geo.maxTop <= 0) return;
      event.preventDefault();
      onUserScroll?.();
      drag = {
        y: event.clientY,
        top: thumb.offsetTop,
        maxTop: geo.maxTop,
        range: geo.range,
      };
      rail.classList.add("srail--drag");
      document.body.classList.add("srail-dragging");
    };
    const onMove = (event: MouseEvent) => {
      if (!drag || !el) return;
      onUserScroll?.();
      const top = Math.max(
        0,
        Math.min(drag.maxTop, drag.top + event.clientY - drag.y),
      );
      el.scrollTop = (top / drag.maxTop) * drag.range;
    };
    const onUp = () => {
      if (!drag) return;
      drag = null;
      rail.classList.remove("srail--drag");
      document.body.classList.remove("srail-dragging");
      reveal();
    };
    // The thumb sits above the scroller, so hand wheel gestures through.
    const onWheel = (event: WheelEvent) => {
      if (!el) return;
      event.preventDefault();
      onUserScroll?.();
      el.scrollTop += event.deltaY;
    };

    // Content growth, row insertion, and scroller swaps all surface as
    // subtree mutations of the container.
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    thumb.addEventListener("mousedown", onThumbDown);
    thumb.addEventListener("wheel", onWheel, { passive: false });
    sync();

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      thumb.removeEventListener("mousedown", onThumbDown);
      thumb.removeEventListener("wheel", onWheel);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      document.body.classList.remove("srail-dragging");
    };
  }, [container, scroller, variant, onUserScroll]);

  return (
    <div className="srail" ref={railRef} aria-hidden="true">
      <div className="srail__thumb" ref={thumbRef} />
    </div>
  );
}
