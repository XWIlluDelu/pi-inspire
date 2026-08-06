import { AlertTriangle, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { store } from "../store";
import { useModalFocus } from "../use-modal-focus";

const IMAGE_ZOOM = 2;
const PAN_THRESHOLD_PX = 6;

interface Point {
  x: number;
  y: number;
}

interface PanGesture {
  pointerId: number;
  start: Point;
  origin: Point;
  moved: boolean;
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialogRef = useModalFocus<HTMLDivElement>(true, src);
  const canvasRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const gestureRef = useRef<PanGesture | null>(null);
  const suppressClickRef = useRef(false);
  const [zoomed, setZoomed] = useState(false);
  const [panning, setPanning] = useState(false);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const constrainPan = useCallback((next: Point): Point => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return next;
    const maxX = Math.max(0, (image.clientWidth * IMAGE_ZOOM - canvas.clientWidth) / 2);
    const maxY = Math.max(0, (image.clientHeight * IMAGE_ZOOM - canvas.clientHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  const finishGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    suppressClickRef.current = gesture.moved;
    if (gesture.moved) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    gestureRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const toggleZoom = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (zoomed) setPan({ x: 0, y: 0 });
    setZoomed(!zoomed);
  };

  return createPortal(
    <div className="overlay image-lightbox" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="image-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          ref={canvasRef}
          type="button"
          className={`image-lightbox__canvas ${zoomed ? "image-lightbox__canvas--zoomed" : ""} ${panning ? "image-lightbox__canvas--panning" : ""}`}
          aria-label={zoomed ? "Fit image to window" : "Zoom image"}
          aria-pressed={zoomed}
          title={zoomed ? "Click to fit · drag to pan" : "Click to zoom"}
          onClick={toggleZoom}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            suppressClickRef.current = false;
            gestureRef.current = {
              pointerId: event.pointerId,
              start: { x: event.clientX, y: event.clientY },
              origin: pan,
              moved: false,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = gestureRef.current;
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            const delta = {
              x: event.clientX - gesture.start.x,
              y: event.clientY - gesture.start.y,
            };
            if (!gesture.moved && Math.hypot(delta.x, delta.y) < PAN_THRESHOLD_PX) return;
            gesture.moved = true;
            suppressClickRef.current = true;
            if (!zoomed) return;
            event.preventDefault();
            setPanning(true);
            setPan(constrainPan({ x: gesture.origin.x + delta.x, y: gesture.origin.y + delta.y }));
          }}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onDragStart={(event) => event.preventDefault()}
        >
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            draggable={false}
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoomed ? IMAGE_ZOOM : 1})` }}
            onDragStart={(event) => event.preventDefault()}
          />
        </button>
        <button type="button" className="image-lightbox__close" onClick={onClose} aria-label="Close image preview" title="Close">
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function ImagePreview({
  src,
  alt = "Attached image",
  className = "",
  loading = false,
  error = null,
}: {
  src?: string;
  alt?: string;
  className?: string;
  loading?: boolean;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`image-preview ${className}`}
        disabled={!src}
        onClick={() => src && setOpen(true)}
        aria-label={src ? "Preview attached image" : error ? "Attached image unavailable" : "Attached image loading"}
        title={error ?? (src ? "Open image preview" : "Loading image")}
      >
        {src ? <img src={src} alt={alt} draggable={false} onDragStart={(event) => event.preventDefault()} /> : null}
        {!src && loading ? <Loader2 size={16} className="spin" aria-hidden /> : null}
        {!src && error ? <AlertTriangle size={16} aria-hidden /> : null}
      </button>
      {open && src ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function PersistedImage({
  sessionId,
  viewId,
  reference,
}: {
  sessionId: string;
  viewId: string;
  reference: string;
}) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let objectUrl: string | undefined;
    setSrc(undefined);
    setError(null);
    void store.loadEmbeddedImage(sessionId, viewId, reference, request.signal).then(
      (blob) => {
        if (request.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      },
      (reason: unknown) => {
        if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : "Image unavailable");
      },
    );
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reference, sessionId, viewId]);

  return <ImagePreview src={src} className="image-preview--message" loading={!src && !error} error={error} />;
}
