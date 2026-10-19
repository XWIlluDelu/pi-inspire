import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { copyLoader, imageSourceBlob } from "../content-copy";
import { MAX_IMAGE_SCALE } from "../image-viewport";
import { useImageViewport } from "../use-image-viewport";
import { useModalFocus } from "../use-modal-focus";
import { CopyAction } from "./CopyAction";
import { PiLoader } from "./PiLoader";

export interface PreviewImage {
  src: string;
  alt: string;
  name?: string;
}

const BACKGROUNDS = ["Checkerboard", "White", "Black"] as const;

export function ImageLightbox({
  image,
  index = 0,
  count = 1,
  onNavigate,
  onClose,
}: {
  image: PreviewImage;
  index?: number;
  count?: number;
  onNavigate?: (index: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(true, true, onClose);
  const instructions = useId();
  const [background, setBackground] =
    useState<(typeof BACKGROUNDS)[number]>("Checkerboard");
  const [copyError, setCopyError] = useState<{
    src: string;
    message: string;
  } | null>(null);
  const viewport = useImageViewport(image.src, onClose);
  const { view, size, status } = viewport;
  const ready = status === "ready";
  const name =
    image.name ||
    (image.alt === "Attached image" ? "Image" : image.alt) ||
    "Image";
  const percent = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: view.scale < 0.1 ? 1 : 0,
  }).format(view.scale * 100);
  const error = copyError?.src === image.src ? copyError.message : null;
  const navigate = (next: number) => {
    // Two figures can share one document-owned URL. Navigation still resets the
    // view, without refetching/redecoding the same bytes or changing background.
    viewport.fit();
    onNavigate?.(next);
  };

  return createPortal(
    <div
      className="overlay image-lightbox"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="image-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            (event.target as HTMLElement).closest("select, input, textarea")
          )
            return;
          let handled = true;
          const step = event.shiftKey ? 240 : 60;
          switch (event.key) {
            case "+":
            case "=":
              viewport.zoom(view.scale * 1.25);
              break;
            case "-":
              viewport.zoom(view.scale / 1.25);
              break;
            case "0":
              viewport.fit();
              break;
            case "1":
              viewport.zoom(1);
              break;
            case "ArrowLeft":
              viewport.pan(step, 0);
              break;
            case "ArrowRight":
              viewport.pan(-step, 0);
              break;
            case "ArrowUp":
              viewport.pan(0, step);
              break;
            case "ArrowDown":
              viewport.pan(0, -step);
              break;
            case "PageUp":
              if (index > 0) navigate(index - 1);
              break;
            case "PageDown":
              if (index < count - 1) navigate(index + 1);
              break;
            default:
              handled = false;
          }
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <header className="image-lightbox__header">
          <div className="image-lightbox__identity">
            <div className="image-lightbox__name" title={name}>
              {name}
            </div>
            <div className="image-lightbox__dimensions">
              {size
                ? `${size.width.toLocaleString()} × ${size.height.toLocaleString()}`
                : status === "error"
                  ? "Image unavailable"
                  : "Loading image…"}
            </div>
          </div>
          <div
            className="image-lightbox__actions"
            onClickCapture={() => setCopyError(null)}
            role="group"
            aria-label="Image actions"
          >
            <CopyAction
              key={image.src}
              getContent={copyLoader(
                async (signal) => ({
                  text: "",
                  images: [await imageSourceBlob(image.src, signal)],
                }),
                { text: false, image: true },
              )}
              label="image"
              className="image-lightbox__control"
              disabled={!ready}
              onError={(message) => setCopyError({ src: image.src, message })}
            />
            <a
              className="image-lightbox__control"
              href={image.src}
              download={image.name || "image"}
              aria-label="Download image"
              title="Download original"
            >
              <Download size={18} aria-hidden />
            </a>
            <button
              type="button"
              className="image-lightbox__control"
              onClick={onClose}
              aria-label="Close image preview"
              title="Close (Escape)"
              data-modal-autofocus
            >
              <X size={18} aria-hidden />
            </button>
          </div>
        </header>
        {error ? (
          <div className="image-lightbox__error" role="alert">
            {error}
          </div>
        ) : null}
        <div
          ref={viewport.canvasRef}
          className={`image-lightbox__canvas ${panningClass(viewport.panning)}`}
          role="region"
          aria-label="Image canvas"
          aria-describedby={instructions}
          tabIndex={0}
          onDoubleClick={viewport.onDoubleClick}
          onPointerDown={viewport.onPointerDown}
          onPointerMove={viewport.onPointerMove}
          onPointerUp={viewport.onPointerUp}
          onPointerCancel={viewport.onPointerCancel}
          onLostPointerCapture={viewport.onLostPointerCapture}
          onDragStart={(event) => event.preventDefault()}
        >
          <img
            key={image.src}
            className="image-surface"
            data-background={background.toLowerCase()}
            src={image.src}
            alt={image.alt}
            draggable={false}
            style={{
              visibility: ready ? "visible" : "hidden",
              width: size?.width,
              height: size?.height,
              transform: `translate(-50%, -50%) translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
            }}
            onLoad={(event) => viewport.onLoad(event.currentTarget)}
            onError={viewport.onError}
            onDragStart={(event) => event.preventDefault()}
          />
          {status !== "ready" ? (
            <div className="image-lightbox__status" role="status">
              {status === "loading" ? (
                <>
                  <PiLoader size={24} aria-hidden />
                  <span>Loading image…</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={24} aria-hidden />
                  <span>This image could not be displayed.</span>
                  <span>Download the original file to inspect it.</span>
                </>
              )}
            </div>
          ) : null}
        </div>
        <footer className="image-lightbox__toolbar">
          {count > 1 ? (
            <div
              className="image-lightbox__navigation"
              role="group"
              aria-label="Image navigation"
            >
              <button
                type="button"
                className="image-lightbox__control"
                disabled={index === 0}
                onClick={() => navigate(index - 1)}
                aria-label="Previous image"
                title="Previous image (Page Up)"
              >
                <ChevronLeft size={18} aria-hidden />
              </button>
              <span aria-live="polite" aria-atomic="true">
                {index + 1} / {count}
              </span>
              <button
                type="button"
                className="image-lightbox__control"
                disabled={index === count - 1}
                onClick={() => navigate(index + 1)}
                aria-label="Next image"
                title="Next image (Page Down)"
              >
                <ChevronRight size={18} aria-hidden />
              </button>
            </div>
          ) : null}
          <div className="image-lightbox__view-controls">
            <div
              className="image-lightbox__zoom"
              role="group"
              aria-label="Image zoom"
            >
              <button
                type="button"
                className="image-lightbox__control"
                disabled={!ready || view.scale <= viewport.minScale}
                onClick={() => viewport.zoom(view.scale / 1.25)}
                aria-label="Zoom out"
                title="Zoom out (−)"
              >
                <Minus size={18} aria-hidden />
              </button>
              <button
                type="button"
                className="image-lightbox__control image-lightbox__scale"
                disabled={!ready}
                onClick={() => viewport.zoom(1)}
                aria-label="Actual size"
                aria-describedby={`${instructions}-zoom`}
                title="Actual size · 100% (1)"
              >
                <span
                  id={`${instructions}-zoom`}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {ready ? `${percent}%` : "—"}
                </span>
              </button>
              <button
                type="button"
                className="image-lightbox__control"
                disabled={!ready || view.scale >= MAX_IMAGE_SCALE}
                onClick={() => viewport.zoom(view.scale * 1.25)}
                aria-label="Zoom in"
                title="Zoom in (+ or Ctrl/⌘ + scroll)"
              >
                <Plus size={18} aria-hidden />
              </button>
              <button
                type="button"
                className="image-lightbox__control"
                disabled={!ready}
                onClick={viewport.fit}
                aria-label="Fit image to window"
                title="Fit to window (0)"
              >
                <Maximize size={18} aria-hidden />
              </button>
            </div>
            <label
              className="image-lightbox__background"
              title={`Image background: ${background}`}
            >
              <span
                className="image-surface"
                data-background={background.toLowerCase()}
                aria-hidden
              />
              <select
                aria-label="Image background"
                value={background}
                onChange={(event) =>
                  setBackground(
                    event.target.value as (typeof BACKGROUNDS)[number],
                  )
                }
              >
                {BACKGROUNDS.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
        </footer>
        <p id={instructions} className="sr-only">
          Drag or scroll to pan. Pinch or Control/Command plus scroll to zoom.
          Double-click or double-tap to zoom; repeat to fit. Plus and minus
          zoom, 1 shows actual size, 0 fits to window, and arrow keys pan. Page
          Up and Page Down switch images. Escape closes the preview.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function panningClass(panning: boolean) {
  return panning ? "image-lightbox__canvas--panning" : "";
}
