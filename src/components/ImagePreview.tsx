import { AlertTriangle, Loader2 } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { store } from "../store";
import { useImageHistory } from "../use-image-history";
import { ImageGalleryContext } from "./ImageGallery";
import { ImageLightbox } from "./ImageLightbox";

export const EmbeddedImageOwnerContext = createContext<{
  sessionId: string;
  viewId: string;
  projectionKey: string;
} | null>(null);

/** Authored image links keep navigation semantics without nested buttons. */
export const ImageLinkContext = createContext(false);

export function ImagePreview({
  src,
  alt = "Attached image",
  name,
  title,
  className = "",
  loading = false,
  imageLoading,
  error = null,
  onError,
  inline = false,
}: {
  src?: string;
  alt?: string;
  name?: string;
  title?: string;
  className?: string;
  loading?: boolean;
  imageLoading?: "eager" | "lazy";
  error?: string | null;
  onError?: () => void;
  inline?: boolean;
}) {
  const gallery = useContext(ImageGalleryContext);
  const linked = useContext(ImageLinkContext);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [openedSource, setOpenedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [inlineWidth, setInlineWidth] = useState<{
    src: string;
    width: number;
  } | null>(null);
  const open = Boolean(src && openedSource === src);
  const close = useImageHistory(open, () => setOpenedSource(null));
  useLayoutEffect(() => {
    if (openedSource && openedSource !== src) setOpenedSource(null);
  }, [openedSource, src]);
  const decodeError = src && failedSource === src;
  const failure =
    error ||
    (decodeError
      ? "This image could not be displayed. Open the preview to download the original."
      : null);

  useLayoutEffect(() => {
    const element = linked ? imageRef.current : buttonRef.current;
    if (!gallery || !src || !element) return;
    gallery.register({ id, src, alt, name, element });
  }, [gallery, id, src, alt, name, linked]);
  useLayoutEffect(() => () => gallery?.unregister(id), [gallery, id]);
  useLayoutEffect(() => {
    if (!src) gallery?.unregister(id);
  }, [gallery, id, src]);

  const image = src ? (
    <img
      ref={imageRef}
      className={`image-surface ${inline ? "document-image" : ""}`}
      src={src}
      alt={alt}
      loading={imageLoading}
      title={title}
      draggable={false}
      onError={() => {
        setFailedSource(src);
        onError?.();
      }}
      onLoad={(event) => {
        setFailedSource(null);
        // A viewBox-only SVG has no CSS intrinsic width. Give its shrink-to-fit
        // button definite bounds; max-width still keeps it within the document.
        if (inline && !linked && event.currentTarget.naturalWidth > 0)
          setInlineWidth({ src, width: event.currentTarget.naturalWidth });
      }}
      onDragStart={(event) => event.preventDefault()}
    />
  ) : null;

  if (linked) return image;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`image-preview ${inline ? "image-preview--inline" : ""} ${className}`}
        disabled={!src}
        style={
          inline && inlineWidth && inlineWidth.src === src
            ? { width: inlineWidth.width }
            : undefined
        }
        onClick={() => {
          if (src) {
            if (gallery) gallery.open(id);
            else setOpenedSource(src);
          }
        }}
        aria-label={
          src
            ? `Preview ${name || (alt === "Attached image" ? "attached image" : alt) || "image"}`
            : error
              ? `${alt} unavailable`
              : `${alt} loading`
        }
        title={
          failure || title || (src ? "Open image preview" : "Loading image")
        }
        data-image-error={decodeError || undefined}
      >
        {image}
        {!src && loading ? (
          <Loader2 size={16} className="spin" aria-hidden />
        ) : null}
        {failure ? <AlertTriangle size={16} aria-hidden /> : null}
      </button>
      {open && src ? (
        <ImageLightbox image={{ src, alt, name }} onClose={close} />
      ) : null}
    </>
  );
}

export function PersistedImage({
  sessionId,
  viewId,
  projectionKey,
  reference,
  alt = "Attached image",
  name,
  className = "image-preview--message",
}: {
  sessionId: string;
  viewId: string;
  projectionKey: string;
  reference: string;
  alt?: string;
  name?: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let objectUrl: string | undefined;
    setSrc(undefined);
    setError(null);
    void store
      .loadEmbeddedImage(
        sessionId,
        viewId,
        projectionKey,
        reference,
        request.signal,
      )
      .then(
        (blob) => {
          if (request.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
        },
        (reason: unknown) => {
          if (!request.signal.aborted)
            setError(
              reason instanceof Error ? reason.message : "Image unavailable",
            );
        },
      );
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectionKey, reference, sessionId, viewId]);

  return (
    <ImagePreview
      src={src}
      alt={alt}
      name={name}
      className={className}
      loading={!src && !error}
      error={error}
    />
  );
}
