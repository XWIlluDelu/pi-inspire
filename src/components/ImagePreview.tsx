import { AlertTriangle } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { store } from "../store";
import { useImageUrl } from "../use-image-url";
import { ImageGallery, ImageGalleryContext } from "./ImageGallery";
import { PiLoader } from "./PiLoader";

interface TranscriptImageOwner {
  sessionId: string;
  viewId: string;
  projectionKey: string;
}

export const TranscriptImageOwnerContext =
  createContext<TranscriptImageOwner | null>(null);

/** Both native message bodies keep the original, unfiltered part position. */
export function messageImage(
  part: unknown,
  messageIndex: number | undefined,
  partIndex: number,
  owner: TranscriptImageOwner,
  savedEntry?: string,
) {
  if (!part || typeof part !== "object") return null;
  const image = part as Record<string, unknown>;
  if (image.type !== "image") return null;
  if (savedEntry)
    return (
      <HistoryImage
        key={`saved:${partIndex}`}
        targetId={savedEntry}
        index={partIndex}
      />
    );
  if (Number.isSafeInteger(messageIndex) && owner.sessionId && owner.viewId)
    return (
      <TranscriptImage
        key={`persisted:${partIndex}`}
        {...owner}
        reference={`pi-embedded://${messageIndex}/${partIndex}`}
      />
    );
  if (
    typeof image.data !== "string" ||
    typeof image.mimeType !== "string" ||
    !/^image\//i.test(image.mimeType)
  )
    return null;
  return (
    <ImagePreview
      key={`inline:${partIndex}`}
      src={`data:${image.mimeType};base64,${image.data}`}
      className="image-preview--message"
    />
  );
}

/** Authored image links keep navigation semantics without nested buttons. */
export const ImageLinkContext = createContext(false);

export function ImagePreview(props: Parameters<typeof Thumbnail>[0]) {
  const gallery = useContext(ImageGalleryContext);
  return gallery ? (
    <Thumbnail {...props} />
  ) : (
    <ImageGallery>
      <Thumbnail {...props} />
    </ImageGallery>
  );
}

function Thumbnail({
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
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [inlineWidth, setInlineWidth] = useState<{
    src: string;
    width: number;
  } | null>(null);
  const decodeError = src && failedSource === src;
  const failure =
    error ||
    (decodeError
      ? "Image unavailable. Open the preview to download it."
      : null);

  useLayoutEffect(() => {
    const element = linked ? imageRef.current : buttonRef.current;
    if (!gallery || !src || !element) return;
    gallery.register({ id, src, alt, name, element });
    return () => gallery.unregister(id);
  }, [gallery, id, src, alt, name, linked]);

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
        if (src) gallery?.open({ id, src });
      }}
      aria-label={
        src
          ? `Preview ${name || (alt === "Attached image" ? "attached image" : alt) || "image"}`
          : error
            ? `${alt} unavailable`
            : `${alt} loading`
      }
      title={failure || title || (src ? "Open image preview" : "Loading image")}
      data-image-error={decodeError || undefined}
    >
      {image}
      {!src && loading ? <PiLoader size={16} aria-hidden /> : null}
      {failure ? <AlertTriangle size={16} aria-hidden /> : null}
    </button>
  );
}

export function LoadedImagePreview({
  load,
  unavailable,
  pending,
  ...props
}: Omit<ComponentProps<typeof ImagePreview>, "src" | "loading" | "error"> & {
  load: Parameters<typeof useImageUrl>[0];
  unavailable?: ReactNode;
  pending?: ReactNode;
}) {
  const { src, error } = useImageUrl(load);
  if (error && unavailable) return unavailable;
  const loading = !src && !error;
  if (loading && pending) return pending;
  return <ImagePreview {...props} src={src} error={error} loading={loading} />;
}

export function TranscriptImage({
  sessionId,
  viewId,
  projectionKey,
  reference,
  alt = "Attached image",
  name,
  title,
  className = "image-preview--message",
  unavailable,
}: {
  sessionId: string;
  viewId: string;
  projectionKey: string;
  reference: string;
  alt?: string;
  name?: string;
  title?: string;
  className?: string;
  unavailable?: ReactNode;
}) {
  const loadImage = useCallback(
    (signal: AbortSignal) =>
      store.resources.loadTranscriptImage(
        sessionId,
        viewId,
        projectionKey,
        reference,
        signal,
      ),
    [projectionKey, reference, sessionId, viewId],
  );
  return (
    <LoadedImagePreview
      load={loadImage}
      unavailable={unavailable}
      alt={alt}
      name={name}
      title={title}
      className={className}
    />
  );
}

export function HistoryImage({
  targetId,
  index,
}: {
  targetId: string;
  index: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const loadImage = useCallback(
    (signal: AbortSignal) => store.branches.readImage(targetId, index, signal),
    [targetId, index, attempt],
  );
  return (
    <LoadedImagePreview
      load={loadImage}
      className="history-detail__image"
      alt="image in this history entry"
      pending={<span role="status">Loading image…</span>}
      unavailable={
        <div className="history-image-error">
          <span>Image unavailable</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry image
          </button>
        </div>
      }
    />
  );
}
