import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  constrainImage,
  fitImage,
  imageFitScale,
  type ImageGeometry,
  type ImagePoint,
  type ImageSize,
  type ImageView,
  resizeImage,
  zoomImage,
} from "./image-viewport";

const EMPTY: ImageGeometry = {
  image: { width: 1, height: 1 },
  viewport: { width: 1, height: 1 },
};
const PAN_THRESHOLD = 6;
const midpoint = (a: ImagePoint, b: ImagePoint) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const distance = (a: ImagePoint, b: ImagePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

interface Gesture {
  points: ImagePoint[];
  view: ImageView;
  moved: boolean;
  multiple: boolean;
  empty: boolean;
  started: number;
}

export function useImageViewport(src: string, onBackdrop: () => void) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const geometry = useRef<ImageGeometry>(EMPTY);
  const current = useRef<ImageView>(fitImage(EMPTY));
  const [view, setView] = useState(current.current);
  const [size, setSize] = useState<ImageSize | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const ready = useRef(false);
  const pointers = useRef(new Map<number, ImagePoint>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ point: ImagePoint; time: number } | null>(null);
  const lastTouch = useRef(-Infinity);
  const [panning, setPanning] = useState(false);
  const backdrop = useRef(onBackdrop);
  backdrop.current = onBackdrop;

  const update = useCallback((next: ImageView) => {
    current.current = next;
    setView(next);
  }, []);
  const clearGesture = useCallback(() => {
    pointers.current.clear();
    gesture.current = null;
    lastTap.current = null;
    setPanning(false);
  }, []);

  useLayoutEffect(() => {
    ready.current = false;
    setSize(null);
    setStatus("loading");
    clearGesture();
    update(fitImage(geometry.current));
  }, [src, clearGesture, update]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      geometry.current = {
        ...geometry.current,
        viewport: { width: rect.width, height: rect.height },
      };
      clearGesture();
      update(resizeImage(current.current, geometry.current));
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", clearGesture);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", clearGesture);
    };
  }, [clearGesture, update]);

  const position = useCallback(
    (point: { clientX: number; clientY: number }): ImagePoint => {
      const rect = canvasRef.current!.getBoundingClientRect();
      return {
        x: point.clientX - rect.left - rect.width / 2,
        y: point.clientY - rect.top - rect.height / 2,
      };
    },
    [],
  );
  const zoom = useCallback(
    (scale: number, anchor?: ImagePoint) => {
      if (ready.current)
        update(zoomImage(current.current, geometry.current, scale, anchor));
    },
    [update],
  );
  const fit = useCallback(() => {
    clearGesture();
    if (ready.current) update(fitImage(geometry.current));
  }, [clearGesture, update]);
  const toggle = (anchor: ImagePoint) => {
    if (current.current.scale > imageFitScale(geometry.current) * 1.01) fit();
    else zoom(Math.max(1, imageFitScale(geometry.current) * 2), anchor);
  };
  const pan = useCallback(
    (x: number, y: number) => {
      if (!ready.current) return;
      update(
        constrainImage(
          {
            ...current.current,
            x: current.current.x + x,
            y: current.current.y + y,
          },
          geometry.current,
        ),
      );
    },
    [update],
  );

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!ready.current) return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? geometry.current.viewport.height
            : 1;
      if (event.ctrlKey || event.metaKey) {
        zoom(
          current.current.scale * Math.exp(-event.deltaY * unit * 0.01),
          position(event),
        );
      } else if (event.shiftKey && !event.deltaX) {
        pan(-event.deltaY * unit, 0);
      } else {
        pan(-event.deltaX * unit, -event.deltaY * unit);
      }
    };
    // Safari's desktop trackpad uses gesture events instead of Ctrl+wheel.
    // Touch PointerEvents remain authoritative when actual fingers are down.
    let nativePinch: { view: ImageView; anchor: ImagePoint } | null = null;
    const safariGesture = (event: Event) => {
      event.preventDefault();
      if (!ready.current || pointers.current.size >= 2) return;
      const pinch = event as Event & {
        scale: number;
        clientX?: number;
        clientY?: number;
      };
      const anchor =
        typeof pinch.clientX === "number" && typeof pinch.clientY === "number"
          ? position({ clientX: pinch.clientX, clientY: pinch.clientY })
          : { x: 0, y: 0 };
      if (event.type === "gesturestart")
        nativePinch = { view: current.current, anchor };
      else if (event.type === "gestureend") nativePinch = null;
      else if (nativePinch && Number.isFinite(pinch.scale) && pinch.scale > 0)
        update(
          zoomImage(
            nativePinch.view,
            geometry.current,
            nativePinch.view.scale * pinch.scale,
            nativePinch.anchor,
            anchor,
          ),
        );
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"])
      canvas.addEventListener(type, safariGesture, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", wheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"])
        canvas.removeEventListener(type, safariGesture);
    };
  }, [pan, zoom, update, position]);

  const insideImage = (point: ImagePoint) =>
    Math.abs(point.x - current.current.x) <=
      (geometry.current.image.width * current.current.scale) / 2 &&
    Math.abs(point.y - current.current.y) <=
      (geometry.current.image.height * current.current.scale) / 2;
  const rebase = (empty = false) => {
    gesture.current = {
      points: [...pointers.current.values()],
      view: current.current,
      moved: gesture.current?.moved ?? false,
      multiple:
        pointers.current.size > 1 || (gesture.current?.multiple ?? false),
      empty,
      started: performance.now(),
    };
  };
  const finish = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    if (!pointers.current.has(event.pointerId)) return;
    const active = gesture.current;
    const point = position(event);
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size) {
      rebase();
      return;
    }
    gesture.current = null;
    setPanning(false);
    if (cancelled || !active || active.moved || active.multiple) {
      lastTap.current = null;
      return;
    }
    if (active.empty && !insideImage(point)) {
      backdrop.current();
      return;
    }
    if (
      event.pointerType === "touch" &&
      performance.now() - active.started < 350
    ) {
      const previous = lastTap.current;
      if (
        previous &&
        performance.now() - previous.time < 300 &&
        distance(point, previous.point) < 28
      ) {
        toggle(point);
        lastTap.current = null;
      } else {
        lastTap.current = { point, time: performance.now() };
      }
    }
  };

  return {
    canvasRef,
    view,
    size,
    status,
    minScale: Math.min(0.1, imageFitScale(geometry.current)),
    panning,
    zoom,
    fit,
    pan,
    onLoad(image: HTMLImageElement) {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const next = { width: image.naturalWidth, height: image.naturalHeight };
      geometry.current = { ...geometry.current, image: next };
      ready.current = true;
      setSize(next);
      setStatus("ready");
      update(fitImage(geometry.current));
    },
    onError() {
      ready.current = false;
      setStatus("error");
      clearGesture();
    },
    onDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
      if (ready.current && performance.now() - lastTouch.current > 500)
        toggle(position(event));
    },
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (!ready.current || event.button !== 0) return;
      if (event.pointerType === "touch") lastTouch.current = performance.now();
      event.currentTarget.focus({ preventScroll: true });
      const point = position(event);
      pointers.current.set(event.pointerId, point);
      rebase(!insideImage(point));
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const active = gesture.current;
      if (!active || !pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, position(event));
      const points = [...pointers.current.values()];
      if (points.length >= 2 && active.points.length >= 2) {
        const startDistance = distance(active.points[0]!, active.points[1]!);
        if (startDistance < 1) return;
        active.moved = true;
        update(
          zoomImage(
            active.view,
            geometry.current,
            (active.view.scale * distance(points[0]!, points[1]!)) /
              startDistance,
            midpoint(active.points[0]!, active.points[1]!),
            midpoint(points[0]!, points[1]!),
          ),
        );
      } else {
        const delta = {
          x: points[0]!.x - active.points[0]!.x,
          y: points[0]!.y - active.points[0]!.y,
        };
        if (!active.moved && Math.hypot(delta.x, delta.y) < PAN_THRESHOLD)
          return;
        active.moved = true;
        update(
          constrainImage(
            {
              ...active.view,
              x: active.view.x + delta.x,
              y: active.view.y + delta.y,
            },
            geometry.current,
          ),
        );
      }
      setPanning(true);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finish(event),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) =>
      finish(event, true),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) =>
      finish(event, true),
  };
}
