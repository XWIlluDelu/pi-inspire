import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
} from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  TextLayer,
} from "pdfjs-dist";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ContextPaneState } from "./ContextPaneState";
import { PiLoader } from "./PiLoader";
import "../styles/pdf-preview.css";

interface LoadedPdf {
  document: PDFDocumentProxy;
  TextLayer: typeof TextLayer;
}

export function pdfRenderSize(
  width: number,
  height: number,
  available: number,
  zoom: number,
  dpr: number,
) {
  const scale = Math.min(
    (available / width) * zoom,
    16_384 / width,
    16_384 / height,
  );
  const cssWidth = width * scale;
  const cssHeight = height * scale;
  const pixels = Math.min(
    dpr,
    2,
    8192 / cssWidth,
    8192 / cssHeight,
    Math.sqrt(4_000_000 / (cssWidth * cssHeight)),
  );
  return { scale, width: cssWidth, height: cssHeight, pixels };
}

interface PageDimensions {
  width: number;
  height: number;
}

function PdfPage({
  loaded,
  index,
  zoom,
  width,
  top,
  height,
  onDimensions,
}: {
  loaded: LoadedPdf;
  index: number;
  zoom: number;
  width: number;
  top: number;
  height: number;
  onDimensions: (index: number, dimensions: PageDimensions) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!root || width <= 0) return;
    let retired = false;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    let page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    const sheet = document.createElement("div");
    sheet.className = "pdf-preview__sheet";
    sheet.hidden = true;
    root.replaceChildren(sheet);
    setStatus("loading");
    void (async () => {
      page = await loaded.document.getPage(index + 1);
      if (retired) {
        page.cleanup();
        return;
      }
      const natural = page.getViewport({ scale: 1 });
      const size = pdfRenderSize(
        natural.width,
        natural.height,
        width,
        zoom,
        window.devicePixelRatio || 1,
      );
      onDimensions(index, natural);
      const viewport = page.getViewport({ scale: size.scale });
      sheet.style.width = `${size.width}px`;
      sheet.style.height = `${size.height}px`;
      sheet.style.setProperty("--total-scale-factor", String(size.scale));
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      canvas.width = Math.max(1, Math.floor(size.width * size.pixels));
      canvas.height = Math.max(1, Math.floor(size.height * size.pixels));
      const layer = document.createElement("div");
      layer.className = "pdf-preview__text-layer";
      sheet.append(canvas, layer);
      render = page.render({
        canvas,
        viewport,
        transform: [size.pixels, 0, 0, size.pixels, 0, 0],
      });
      text = new loaded.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport,
      });
      await Promise.all([render.promise, text.render()]);
      if (retired) return;
      sheet.hidden = false;
      setStatus("ready");
    })().catch(() => {
      if (!retired) setStatus("error");
    });
    return () => {
      retired = true;
      render?.cancel();
      text?.cancel();
      sheet.remove();
      // The proxy remains cached by PDF.js, but release this page's decoded
      // images/fonts as soon as its cancelled render settles.
      void Promise.resolve(render?.promise)
        .catch(() => {})
        .then(() => page?.cleanup());
    };
  }, [loaded, index, width, zoom, onDimensions]);
  return (
    <div
      className="pdf-preview__page"
      role="region"
      aria-label={`PDF page ${index + 1}`}
      aria-busy={status === "loading"}
      style={{ height, transform: `translateY(${top}px)` }}
    >
      <div ref={rootRef} />
      {status !== "ready" ? (
        <div className="pdf-preview__state">
          <ContextPaneState
            icon={
              status === "loading" ? (
                <PiLoader size={17} aria-hidden />
              ) : (
                <AlertTriangle size={17} aria-hidden />
              )
            }
            title={
              status === "loading" ? "Rendering page" : "PDF page unavailable"
            }
            hint={
              status === "error"
                ? "Download the file to inspect it in another reader."
                : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}

interface PdfNavigation {
  capturePosition: () => void;
  scrollToPage: (number: number) => void;
}

/** One scroll owner, with only visible pages and one neighbour on either side
 * holding canvases/text layers. Page dimensions outlive their render surfaces. */
function PdfPages({
  loaded,
  zoom,
  navigationRef,
  onPageChange,
}: {
  loaded: LoadedPdf;
  zoom: number;
  navigationRef: Ref<PdfNavigation>;
  onPageChange: (number: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dimensionsRef = useRef(new Map<number, PageDimensions>());
  const positionRef = useRef<{
    index: number;
    fraction: number;
    left: number;
    atTop: boolean;
  } | null>(null);
  const previousLayoutRef = useRef<{ width: number; zoom: number } | null>(
    null,
  );
  const restoreRef = useRef<{
    position: NonNullable<typeof positionRef.current>;
    horizontalScale: number;
  } | null>(null);
  const [width, setWidth] = useState(0);
  const heightFor = useCallback(
    (index: number) => {
      // Unvisited pages reserve a portrait estimate until PDF.js supplies their
      // actual box. Mixed page sizes are measured independently, not stretched.
      const natural = dimensionsRef.current.get(index) ?? {
        width: 1,
        height: Math.SQRT2,
      };
      return pdfRenderSize(natural.width, natural.height, width, zoom, 1)
        .height;
    },
    [width, zoom],
  );
  const pages = useVirtualizer({
    enabled: width > 0,
    count: loaded.document.numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: heightFor,
    gap: 12,
    paddingStart: 12,
    paddingEnd: 12,
    overscan: 1,
  });
  const capturePosition = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const page = pages
      .getVirtualItems()
      .find((item) => item.end > root.scrollTop);
    if (page && page.size > 0)
      positionRef.current = {
        index: page.index,
        fraction: Math.max(0, (root.scrollTop - page.start) / page.size),
        left: root.scrollLeft,
        atTop: root.scrollTop === 0,
      };
  }, [pages]);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const resize = () => {
      capturePosition();
      setWidth(Math.max(0, root.clientWidth - 24));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => observer.disconnect();
  }, [capturePosition]);
  useLayoutEffect(() => {
    if (width <= 0) return;
    const previous = previousLayoutRef.current;
    if (previous?.width !== width || previous.zoom !== zoom) {
      const position = positionRef.current;
      restoreRef.current =
        previous && position
          ? {
              position,
              horizontalScale:
                (width * zoom) / (previous.width * previous.zoom),
            }
          : null;
      previousLayoutRef.current = { width, zoom };
      pages.measure();
      return;
    }
    // measure() requests a new commit. Restore only once its new content height
    // is in the DOM; otherwise the browser clamps against the old scroll range.
    const restore = restoreRef.current;
    if (!restore) return;
    restoreRef.current = null;
    const { position, horizontalScale } = restore;
    const start = pages.getOffsetForIndex(position.index, "start")?.[0] ?? 0;
    pages.scrollToOffset(
      position.atTop
        ? 0
        : start + position.fraction * heightFor(position.index),
    );
    if (scrollRef.current)
      scrollRef.current.scrollLeft = position.left * horizontalScale;
  });
  useImperativeHandle(
    navigationRef,
    () => ({
      capturePosition,
      scrollToPage(number) {
        pages.scrollToIndex(number - 1, { align: "start" });
        onPageChange(number);
      },
    }),
    [capturePosition, pages, onPageChange],
  );
  const measurePage = useCallback(
    (index: number, natural: PageDimensions) => {
      dimensionsRef.current.set(index, {
        width: natural.width,
        height: natural.height,
      });
      pages.resizeItem(
        index,
        pdfRenderSize(natural.width, natural.height, width, zoom, 1).height,
      );
    },
    [pages, width, zoom],
  );
  return (
    <div className="pdf-preview__viewport">
      <div
        ref={scrollRef}
        className="pdf-preview__scroll"
        role="region"
        aria-label="PDF pages"
        tabIndex={0}
        data-pane-scroll-active="true"
        onScroll={() => {
          capturePosition();
          const root = scrollRef.current;
          if (!root || !positionRef.current) return;
          const atEnd =
            root.scrollTop > 0 &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
          onPageChange(
            atEnd ? loaded.document.numPages : positionRef.current.index + 1,
          );
        }}
      >
        <div
          className="pdf-preview__pages"
          style={{
            height: pages.getTotalSize(),
            width: Math.max(width, width * zoom),
          }}
        >
          {pages.getVirtualItems().map((page) => (
            <PdfPage
              key={page.key}
              loaded={loaded}
              index={page.index}
              zoom={zoom}
              width={width}
              top={page.start}
              height={page.size}
              onDimensions={measurePage}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function PdfPreview({ blob, name }: { blob: Blob; name: string }) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const navigationRef = useRef<PdfNavigation>(null);
  const changeZoom = (next: number) => {
    navigationRef.current?.capturePosition();
    setZoom(next);
  };
  useEffect(() => {
    let retired = false;
    let task: PDFDocumentLoadingTask | undefined;
    setLoaded(null);
    setError(null);
    setNumber(1);
    setZoom(1);
    void (async () => {
      const [{ loadPdf, TextLayer }, data] = await Promise.all([
        import("../pdf-renderer"),
        blob.arrayBuffer(),
      ]);
      if (retired) return;
      task = loadPdf(data);
      const document = await task.promise;
      if (!retired) setLoaded({ document, TextLayer });
    })().catch((reason: unknown) => {
      if (retired) return;
      setError(
        reason instanceof Error && reason.name === "PasswordException"
          ? "This PDF needs a password. Download it to open in another reader."
          : "The PDF could not be read. Download it to inspect the original file.",
      );
    });
    return () => {
      retired = true;
      // Retiring the loading task also terminates its dedicated worker.
      void task?.destroy().catch(() => {});
    };
  }, [blob]);
  return (
    <div className="pdf-preview" role="document" aria-label={`Preview ${name}`}>
      {loaded ? (
        <>
          <div
            className="pdf-preview__toolbar"
            role="group"
            aria-label="PDF controls"
          >
            <button
              type="button"
              className="icon-button"
              aria-label="Previous PDF page"
              disabled={number === 1}
              onClick={() => navigationRef.current?.scrollToPage(number - 1)}
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <span className="pdf-preview__page-number" aria-live="polite">
              {number} / {loaded.document.numPages}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Next PDF page"
              disabled={number === loaded.document.numPages}
              onClick={() => navigationRef.current?.scrollToPage(number + 1)}
            >
              <ChevronRight size={16} aria-hidden />
            </button>
            <span className="pdf-preview__spacer" />
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out PDF"
              disabled={zoom <= 0.5}
              onClick={() => changeZoom(zoom - 0.25)}
            >
              <Minus size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="pdf-preview__fit"
              aria-label="Fit PDF to width"
              title="Fit to width"
              onClick={() => changeZoom(1)}
            >
              {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in PDF"
              disabled={zoom >= 3}
              onClick={() => changeZoom(zoom + 0.25)}
            >
              <Plus size={16} aria-hidden />
            </button>
          </div>
          <PdfPages
            loaded={loaded}
            zoom={zoom}
            navigationRef={navigationRef}
            onPageChange={setNumber}
          />
        </>
      ) : (
        <ContextPaneState
          icon={
            error ? (
              <AlertTriangle size={17} aria-hidden />
            ) : (
              <PiLoader size={17} aria-hidden />
            )
          }
          title={error ? "PDF preview unavailable" : "Loading PDF"}
          hint={error ?? undefined}
        />
      )}
    </div>
  );
}
