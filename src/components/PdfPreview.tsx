import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Minus,
  Plus,
  Search,
  X,
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
import {
  markOccurrence,
  normalizeFindQuery,
  type PdfFindMatch,
  type PdfOutlineEntry,
  pageMatches,
} from "../pdf-find";
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
  hit = null,
  onHit,
}: {
  loaded: LoadedPdf;
  index: number;
  zoom: number;
  width: number;
  top: number;
  height: number;
  onDimensions: (index: number, dimensions: PageDimensions) => void;
  /** The current find occurrence when it lies on this page. */
  hit?: { needle: string; occurrence: number } | null;
  onHit?: (span: HTMLElement) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const hitNeedle = hit?.needle ?? "";
  const hitOccurrence = hit?.occurrence ?? -1;
  useEffect(() => {
    const layer = rootRef.current?.querySelector(".pdf-preview__text-layer");
    if (!layer || status !== "ready") return;
    const span = markOccurrence(
      layer,
      hitNeedle,
      hitOccurrence,
      "pdf-preview__hit",
    );
    if (span) onHit?.(span);
  }, [status, hitNeedle, hitOccurrence, onHit]);
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
                ? "Download to open in another reader."
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
  hit = null,
}: {
  loaded: LoadedPdf;
  zoom: number;
  navigationRef: Ref<PdfNavigation>;
  onPageChange: (number: number) => void;
  hit?: (PdfFindMatch & { needle: string }) | null;
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
  // Bring a find hit to the upper third of the reader without scrolling any
  // ancestor (scrollIntoView would also move clipped outer panes).
  const revealHit = useCallback((span: HTMLElement) => {
    const root = scrollRef.current;
    if (!root) return;
    const spanBox = span.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    if (
      spanBox.top >= rootBox.top + 24 &&
      spanBox.bottom <= rootBox.bottom - 24
    )
      return;
    root.scrollTop += spanBox.top - rootBox.top - root.clientHeight / 3;
  }, []);
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
              hit={hit && hit.page === page.index + 1 ? hit : null}
              onHit={revealHit}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

async function readOutline(
  document: PDFDocumentProxy,
): Promise<PdfOutlineEntry[]> {
  const outline = await document.getOutline();
  const entries: PdfOutlineEntry[] = [];
  const visit = async (
    items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>,
    depth: number,
  ) => {
    for (const item of items ?? []) {
      if (entries.length >= 200) return;
      try {
        const destination =
          typeof item.dest === "string"
            ? await document.getDestination(item.dest)
            : item.dest;
        const target = destination?.[0];
        const index =
          typeof target === "number"
            ? target
            : target
              ? await document.getPageIndex(target)
              : null;
        const title = item.title.replace(/\s+/gu, " ").trim();
        if (index !== null && title)
          entries.push({ title, page: index + 1, depth });
      } catch {
        // External links and broken destinations are not contents entries.
      }
      if (depth < 2) await visit(item.items, depth + 1);
    }
  };
  await visit(outline, 0);
  return entries;
}

export function PdfPreview({ blob, name }: { blob: Blob; name: string }) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const navigationRef = useRef<PdfNavigation>(null);
  const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PdfFindMatch[] | null>(null);
  const [current, setCurrent] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const pageText = useRef(new Map<number, string[]>());
  const needle = normalizeFindQuery(query);
  useEffect(() => {
    pageText.current = new Map();
    setOutline([]);
    setContentsOpen(false);
    setFindOpen(false);
    setQuery("");
    if (!loaded) return;
    let retired = false;
    void readOutline(loaded.document)
      .then((entries) => {
        if (!retired) setOutline(entries);
      })
      .catch(() => {});
    return () => {
      retired = true;
    };
  }, [loaded]);
  useEffect(() => {
    setMatches(null);
    setCurrent(0);
    if (!loaded || !findOpen || !needle) return;
    let retired = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const found: PdfFindMatch[] = [];
        for (let page = 1; page <= loaded.document.numPages; page += 1) {
          let items = pageText.current.get(page);
          if (!items) {
            const content = await (
              await loaded.document.getPage(page)
            ).getTextContent();
            items = content.items.flatMap((item) =>
              "str" in item ? [item.str] : [],
            );
            pageText.current.set(page, items);
          }
          if (retired) return;
          found.push(...pageMatches(page, items, needle));
        }
        if (retired) return;
        setMatches(found);
        if (found[0]) navigationRef.current?.scrollToPage(found[0].page);
      })().catch(() => {
        if (!retired) setMatches([]);
      });
    }, 160);
    return () => {
      retired = true;
      window.clearTimeout(timer);
    };
  }, [findOpen, loaded, needle]);
  const step = (delta: number) => {
    if (!matches?.length) return;
    const next = (current + delta + matches.length) % matches.length;
    setCurrent(next);
    navigationRef.current?.scrollToPage(matches[next]!.page);
  };
  const openFind = () => {
    setContentsOpen(false);
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  };
  const closeFind = () => {
    setFindOpen(false);
    setQuery("");
  };
  const hit =
    findOpen && matches?.[current] ? { ...matches[current]!, needle } : null;
  // The last contents entry starting at or before the visible page.
  let currentContentsIndex = -1;
  outline.forEach((entry, index) => {
    if (entry.page <= number) currentContentsIndex = index;
  });
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
          ? "Password required. Download to open in another reader."
          : "Download to open in another reader.",
      );
    });
    return () => {
      retired = true;
      // Retiring the loading task also terminates its dedicated worker.
      void task?.destroy().catch(() => {});
    };
  }, [blob]);
  return (
    <div
      className="pdf-preview"
      role="document"
      aria-label={`Preview ${name}`}
      onKeyDown={(event) => {
        if (
          loaded &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          openFind();
        }
      }}
    >
      {loaded && findOpen ? (
        <div
          className="pdf-preview__toolbar pdf-preview__toolbar--find"
          role="search"
          aria-label="Find in PDF"
        >
          <Search size={14} className="pdf-preview__find-icon" aria-hidden />
          <input
            ref={findInputRef}
            className="pdf-preview__find-input"
            type="search"
            value={query}
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              }
            }}
          />
          <span className="pdf-preview__page-number" aria-live="polite">
            {!needle
              ? ""
              : matches === null
                ? "…"
                : matches.length === 0
                  ? "No matches"
                  : `${current + 1} / ${matches.length}`}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Previous match"
            disabled={!matches?.length}
            onClick={() => step(-1)}
          >
            <ChevronUp size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next match"
            disabled={!matches?.length}
            onClick={() => step(1)}
          >
            <ChevronDown size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close find"
            onClick={closeFind}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      ) : null}
      {loaded ? (
        <>
          <div
            className="pdf-preview__toolbar"
            role="group"
            aria-label="PDF controls"
            style={findOpen ? { display: "none" } : undefined}
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
            {outline.length > 0 ? (
              <button
                type="button"
                className="pdf-preview__fit pdf-preview__page-number"
                aria-haspopup="true"
                aria-expanded={contentsOpen}
                aria-label={`Page ${number} of ${loaded.document.numPages}. Show contents`}
                title="Contents"
                onClick={() => setContentsOpen(!contentsOpen)}
              >
                {number} / {loaded.document.numPages}
              </button>
            ) : (
              <span className="pdf-preview__page-number" aria-live="polite">
                {number} / {loaded.document.numPages}
              </span>
            )}
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
            <span className="pdf-preview__spacer" />
            <button
              type="button"
              className="icon-button"
              aria-label="Find in PDF"
              title="Find (Ctrl+F)"
              onClick={openFind}
            >
              <Search size={16} aria-hidden />
            </button>
          </div>
          {contentsOpen ? (
            <nav
              className="reader-contents reader-contents--pdf"
              aria-label="PDF contents"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setContentsOpen(false);
                }
              }}
            >
              {outline.map((entry, index) => (
                <button
                  key={index}
                  type="button"
                  className="reader-contents__entry"
                  style={{ paddingInlineStart: `${12 + entry.depth * 14}px` }}
                  aria-current={
                    index === currentContentsIndex ? "location" : undefined
                  }
                  onClick={() => {
                    setContentsOpen(false);
                    navigationRef.current?.scrollToPage(entry.page);
                  }}
                >
                  <span>{entry.title}</span>
                  <span className="reader-contents__meta">{entry.page}</span>
                </button>
              ))}
            </nav>
          ) : null}
          <PdfPages
            loaded={loaded}
            zoom={zoom}
            navigationRef={navigationRef}
            onPageChange={setNumber}
            hit={hit}
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
