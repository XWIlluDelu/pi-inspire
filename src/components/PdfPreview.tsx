import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  TextLayer,
} from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { ContextPaneState } from "./ContextPaneState";
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

function PdfPage({
  loaded,
  number,
  zoom,
}: {
  loaded: LoadedPdf;
  number: number;
  zoom: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<{
    number: number;
    scale: number;
    top: number;
    left: number;
  } | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resize = () => setWidth(Math.max(0, root.clientWidth - 24));
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => observer.disconnect();
  }, []);
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
    let scale = 1;
    const sheet = document.createElement("div");
    sheet.className = "pdf-preview__sheet";
    sheet.hidden = true;
    root.replaceChildren(sheet);
    root.scrollTop = 0;
    root.scrollLeft = 0;
    setStatus("loading");
    void (async () => {
      page = await loaded.document.getPage(number);
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
      scale = size.scale;
      const viewport = page.getViewport({ scale });
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
      const position = positionRef.current;
      if (position?.number === number) {
        const ratio = scale / position.scale;
        root.scrollTop = position.top * ratio;
        root.scrollLeft = position.left * ratio;
      }
      setStatus("ready");
    })().catch(() => {
      if (!retired) setStatus("error");
    });
    return () => {
      retired = true;
      render?.cancel();
      text?.cancel();
      if (!sheet.hidden)
        positionRef.current = {
          number,
          scale,
          top: root.scrollTop,
          left: root.scrollLeft,
        };
      sheet.remove();
      // The proxy remains cached by PDF.js, but release this page's decoded
      // images/fonts as soon as its cancelled render settles.
      void Promise.resolve(render?.promise)
        .catch(() => {})
        .then(() => page?.cleanup());
    };
  }, [loaded, number, width, zoom]);
  return (
    <div className="pdf-preview__page" aria-busy={status === "loading"}>
      <div
        ref={rootRef}
        className="pdf-preview__scroll"
        role="region"
        aria-label={`PDF page ${number}`}
        tabIndex={0}
        data-pane-scroll-active="true"
      />
      {status !== "ready" ? (
        <div className="pdf-preview__state">
          <ContextPaneState
            icon={
              status === "loading" ? (
                <Loader2 size={17} className="spin" aria-hidden />
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

export function PdfPreview({ blob, name }: { blob: Blob; name: string }) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
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
              onClick={() => setNumber(number - 1)}
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
              onClick={() => setNumber(number + 1)}
            >
              <ChevronRight size={16} aria-hidden />
            </button>
            <span className="pdf-preview__spacer" />
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out PDF"
              disabled={zoom <= 0.5}
              onClick={() => setZoom(zoom - 0.25)}
            >
              <Minus size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="pdf-preview__fit"
              aria-label="Fit PDF to width"
              title="Fit to width"
              onClick={() => setZoom(1)}
            >
              {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in PDF"
              disabled={zoom >= 3}
              onClick={() => setZoom(zoom + 0.25)}
            >
              <Plus size={15} aria-hidden />
            </button>
          </div>
          <PdfPage loaded={loaded} number={number} zoom={zoom} />
        </>
      ) : (
        <ContextPaneState
          icon={
            error ? (
              <AlertTriangle size={17} aria-hidden />
            ) : (
              <Loader2 size={17} className="spin" aria-hidden />
            )
          }
          title={error ? "PDF preview unavailable" : "Loading PDF"}
          hint={error ?? undefined}
        />
      )}
    </div>
  );
}
