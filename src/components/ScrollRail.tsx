import { useEffect, useRef } from "react";

/** A drag target beside the reading column. Wheel and keyboard remain native. */
export function ScrollRail({
  container,
  onUserScroll,
}: {
  container: React.RefObject<HTMLElement | null>;
  onUserScroll: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const thumb = thumbRef.current;
    const el = container.current;
    if (!rail || !thumb || !el) return;
    let hideTimer: number | null = null;
    let frame: number | null = null;
    let drag: { y: number; top: number; maxTop: number; range: number } | null =
      null;
    let geo: { maxTop: number; range: number } | null = null;

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(sync);
    };

    const geometry = () => {
      const rect = el.getBoundingClientRect();
      // reading: a mid-height rail floating in the margin right of the
      // reading column — offset grows with the available whitespace so it
      // never crowds the text, and the long travel keeps dragging precise.
      const column = el
        .querySelector(".transcript__column")
        ?.getBoundingClientRect();
      const columnRight = column ? column.right : rect.left + rect.width / 2;
      const gap = rect.right - columnRight;
      const height = Math.min(
        rect.height - 16,
        Math.max(280, Math.min(rect.height * 0.62, rect.height - 120)),
      );
      const preferredX = Math.min(
        columnRight + Math.max(28, Math.min(gap * 0.5, 72)),
        rect.right - 14,
      );
      // The painted thumb is narrower than its grab band. Fit the whole band
      // into the existing gutter, including on phones with only 12px of padding;
      // neither the invisible hit area nor the thumb may cover readable content.
      const hitWidth = Math.min(16, Math.max(0, gap - 4));
      const x = Math.min(
        rect.right - 2 - hitWidth / 2,
        Math.max(columnRight + 2 + hitWidth / 2, preferredX),
      );
      return {
        x,
        top: rect.top + (rect.height - height) / 2,
        height,
        hitWidth,
      };
    };

    const sync = () => {
      frame = null;
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      const g = geometry();
      if (sh <= ch + 1 || g.height < 64 || g.hitWidth === 0) {
        rail.style.display = "none";
        geo = null;
        return;
      }
      const th = Math.min(
        g.height,
        Math.max(48, Math.round((g.height * ch) / sh)),
      );
      const maxTop = g.height - th;
      rail.style.display = "block";
      rail.style.width = `${g.hitWidth}px`;
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

    const onScroll = () => {
      schedule();
      reveal();
    };
    const onThumbDown = (event: MouseEvent) => {
      if (event.button !== 0 || !geo || geo.maxTop <= 0) return;
      event.preventDefault();
      onUserScroll();
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
      if (!drag) return;
      onUserScroll();
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
      event.preventDefault();
      onUserScroll();
      el.scrollTop += event.deltaY;
    };

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(el);
    if (el.firstElementChild) resizeObserver.observe(el.firstElementChild);
    const readingWidthObserver = new MutationObserver(schedule);
    readingWidthObserver.observe(document.documentElement, {
      attributeFilter: ["data-reading-width"],
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    thumb.addEventListener("mousedown", onThumbDown);
    thumb.addEventListener("wheel", onWheel, { passive: false });
    sync();

    return () => {
      readingWidthObserver.disconnect();
      resizeObserver.disconnect();
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      thumb.removeEventListener("mousedown", onThumbDown);
      thumb.removeEventListener("wheel", onWheel);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      document.body.classList.remove("srail-dragging");
    };
  }, [container, onUserScroll]);

  return (
    <div className="srail" ref={railRef} aria-hidden="true">
      <div className="srail__thumb" ref={thumbRef} />
    </div>
  );
}
