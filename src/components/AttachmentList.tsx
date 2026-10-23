import { AlertTriangle, RotateCw, X } from "lucide-react";
import type { PendingAttachment } from "../controllers/composer-controller";
import { fileIconForPath } from "../file-icons";
import { formatBytes } from "../format";
import { transcriptProjectionKey } from "../transcript-projection-key";
import { ImageGallery } from "./ImageGallery";
import { ImagePreview, PersistedImage } from "./ImagePreview";
import { PiLoader } from "./PiLoader";

export function AttachmentList({
  sessionId,
  items,
  disabled = false,
  onRemove,
  onRetry,
}: {
  sessionId: string | null;
  items: readonly PendingAttachment[];
  disabled?: boolean;
  onRemove: (localId: string) => void;
  onRetry?: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ImageGallery>
      <ul className="composer__attachments" aria-label="Attachments">
        {items.map((item) => {
          const image = item.kind === "image";
          const FileIcon = fileIconForPath(item.fileName);
          const fileDetails =
            item.recalledArtifact?.type === "file"
              ? item.recalledArtifact.fileKind === "project"
                ? "project file"
                : "recalled file"
              : `${item.mimeType} · ${formatBytes(item.size)}`;
          return (
            <li
              key={item.localId}
              className={`attachment attachment--${item.status} ${image ? "attachment--image" : ""}`}
              title={
                image
                  ? item.error
                  : [item.fileName, fileDetails, item.error]
                      .filter(Boolean)
                      .join("\n")
              }
            >
              {image ? (
                item.recalledArtifact?.type === "image" && sessionId ? (
                  <PersistedImage
                    sessionId={sessionId}
                    viewId={item.recalledArtifact.viewId}
                    projectionKey={transcriptProjectionKey(
                      item.recalledArtifact.viewId,
                      item.recalledArtifact.incarnation,
                    )}
                    reference={item.recalledArtifact.reference}
                    name={item.fileName}
                    className="image-preview--attachment"
                  />
                ) : (
                  <ImagePreview
                    src={item.previewUrl}
                    name={item.fileName}
                    className="image-preview--attachment"
                    loading={item.status === "uploading" || item.previewLoading}
                    error={item.error ?? null}
                  />
                )
              ) : (
                <>
                  <FileIcon size={13} aria-hidden />
                  <span className="attachment__name">{item.fileName}</span>
                </>
              )}
              {item.status === "uploading" ? (
                <PiLoader
                  size={12}
                  className="attachment__status"
                  aria-label="Uploading"
                />
              ) : null}
              {item.status === "error" ? (
                <AlertTriangle
                  size={12}
                  className="status-error attachment__status"
                  aria-label="Upload failed"
                  aria-description={item.error}
                />
              ) : null}
              {item.status === "error" && item.retryable && onRetry ? (
                <button
                  type="button"
                  className="attachment__remove attachment__retry"
                  disabled={disabled}
                  onClick={() => onRetry(item.localId)}
                  aria-label={`Retry uploading ${item.fileName}`}
                  title="Retry upload"
                >
                  <RotateCw size={12} aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                className="attachment__remove"
                disabled={disabled}
                onClick={() => onRemove(item.localId)}
                aria-label={
                  image ? "Remove attached image" : `Remove ${item.fileName}`
                }
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </ImageGallery>
  );
}
