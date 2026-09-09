import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ResourceDescriptor } from "../../shared/contracts";
import {
  documentResourceReference,
  DocumentImageResources,
} from "../document-resources";
import { resourceReferenceFromEventTarget } from "../resources";
import { store } from "../store";

export const DocumentResourceContext = createContext<{
  descriptor: ResourceDescriptor;
  images: DocumentImageResources | null;
} | null>(null);

/** Cell-local, validated raster MIME bundles only; never arbitrary data URLs. */
export const MarkdownAttachmentsContext = createContext<
  ReadonlyMap<string, string>
>(new Map());

function scrollToAnchor(root: HTMLElement, fragment: string): boolean {
  let id: string;
  try {
    id = `user-content-${decodeURIComponent(fragment.slice(1))}`;
  } catch {
    return false;
  }
  const target = [...root.querySelectorAll<HTMLElement>("[id]")].find(
    (node) => node.id === id,
  );
  target?.scrollIntoView({ block: "start" });
  return Boolean(target);
}

function DocumentPreviewOwner({
  descriptor,
  children,
  className,
  scrollable,
}: {
  descriptor: ResourceDescriptor;
  children: ReactNode;
  className: string;
  scrollable?: boolean;
}) {
  const [images, setImages] = useState<DocumentImageResources | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    const fragment = /#.*$/.exec(descriptor.reference)?.[0];
    if (!element || !fragment) return;
    // The renderer and images can both be deferred. Before image layout, a
    // short document may not even have enough overflow to reach its anchor.
    // Never reclaim the reader once the user has started interacting with it.
    let retired = false;
    let frame = 0;
    const interactions = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      retired = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("load", schedule, true);
      element.removeEventListener("error", schedule, true);
      for (const event of interactions)
        element.removeEventListener(event, stop, true);
    };
    const schedule = () => {
      if (retired) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          retired ||
          element.querySelector('[data-document-image-loading="true"]') ||
          [...element.querySelectorAll("img")].some((image) => !image.complete)
        )
          return;
        if (scrollToAnchor(element, fragment)) stop();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    element.addEventListener("load", schedule, true);
    element.addEventListener("error", schedule, true);
    for (const event of interactions)
      element.addEventListener(event, stop, true);
    schedule();
    return stop;
  }, [descriptor.reference]);
  useEffect(() => {
    const owner = new DocumentImageResources((reference, signal) =>
      store.loadDocumentImage(descriptor.id, reference, signal),
    );
    setImages(owner);
    return () => owner.dispose();
  }, [descriptor.id]);
  const context = useMemo(() => ({ descriptor, images }), [descriptor, images]);
  return (
    <DocumentResourceContext.Provider value={context}>
      <div
        ref={root}
        className={className}
        data-pane-scroll-active={scrollable ? "true" : undefined}
        onClick={(event) => {
          const anchor =
            event.target instanceof Element ? event.target.closest("a") : null;
          const href = anchor?.getAttribute("href");
          if (href?.startsWith("#")) {
            event.preventDefault();
            event.stopPropagation();
            scrollToAnchor(event.currentTarget, href);
            return;
          }
          const reference = resourceReferenceFromEventTarget(event.target);
          if (!reference) return;
          const resolved = documentResourceReference(descriptor, reference);
          if (!resolved) return;
          event.preventDefault();
          event.stopPropagation();
          void store.openResource(resolved);
        }}
      >
        {children}
      </div>
    </DocumentResourceContext.Provider>
  );
}

export function DocumentPreview(
  props: Parameters<typeof DocumentPreviewOwner>[0],
) {
  return <DocumentPreviewOwner key={props.descriptor.id} {...props} />;
}

/** Inline-safe even inside a Markdown link or paragraph. Neither loading nor
 * failure falls back to an unauthenticated browser URL. */
export function DocumentImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt: string;
  title?: string;
}) {
  const document = useContext(DocumentResourceContext);
  const attachments = useContext(MarkdownAttachmentsContext);
  const [loaded, setLoaded] = useState<{
    key: string;
    url?: string;
    error?: string;
  } | null>(null);
  const reference = document
    ? documentResourceReference(document.descriptor, src)
    : null;
  const attachmentName = src.startsWith("attachment:")
    ? src.slice("attachment:".length)
    : null;
  let attachment: string | undefined;
  if (attachmentName !== null) {
    try {
      attachment = attachments.get(decodeURIComponent(attachmentName));
    } catch {
      /* Invalid URL stays unavailable. */
    }
  }
  const key = `${document?.descriptor.id ?? ""}:${src}`;
  const url = attachment ?? (loaded?.key === key ? loaded.url : undefined);
  const error = loaded?.key === key ? loaded.error : undefined;
  useEffect(() => {
    if (attachmentName !== null || !reference || !document?.images) return;
    let current = true;
    void document.images.load(reference).then(
      (url) => {
        if (current) setLoaded({ key, url });
      },
      (reason: unknown) => {
        if (current)
          setLoaded({
            key,
            error:
              reason instanceof Error ? reason.message : "Image unavailable",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [attachmentName, document?.images, key, reference]);
  if (url && !error)
    return (
      <img
        className="document-image image-surface"
        src={url}
        alt={alt}
        title={title}
        onError={() => setLoaded({ key, error: "Image could not be decoded" })}
      />
    );
  const unavailable =
    error || (attachmentName !== null && !attachment) || !reference;
  return (
    <span
      className="document-image__status"
      data-document-image-loading={!unavailable ? "true" : undefined}
      role="status"
      title={error ?? title}
    >
      {alt || "Image"} · {unavailable ? "Image unavailable" : "Loading image…"}
    </span>
  );
}
