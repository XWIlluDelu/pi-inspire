import { AlertTriangle, FileText, Loader2, X } from "lucide-react";
import type { PendingAttachment } from "../controllers/composer-controller";
import { formatBytes } from "../format";
import { ImagePreview, PersistedImage } from "./ImagePreview";

export function AttachmentList({
  sessionId,
  items,
  disabled = false,
  onRemove,
}: {
  sessionId: string | null;
  items: readonly PendingAttachment[];
  disabled?: boolean;
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="composer__attachments" aria-label="Attachments">
      {items.map((item) => {
        const image = item.kind === "image";
        return (
          <li
            key={item.localId}
            className={`attachment attachment--${item.status} ${image ? "attachment--image" : ""}`}
            title={image ? item.error : (item.error ?? item.fileName)}
          >
            {image ? (
              item.recalledArtifact?.type === "image" && sessionId ? (
                <PersistedImage
                  sessionId={sessionId}
                  viewId={item.recalledArtifact.viewId}
                  reference={item.recalledArtifact.reference}
                  className="image-preview--attachment"
                />
              ) : (
                <ImagePreview
                  src={item.previewUrl}
                  className="image-preview--attachment"
                  loading={item.status === "uploading"}
                  error={item.error ?? null}
                />
              )
            ) : (
              <>
                <FileText size={13} aria-hidden />
                <span className="attachment__name">{item.fileName}</span>
                <span className="attachment__meta">
                  {item.recalledArtifact?.type === "file"
                    ? item.recalledArtifact.fileKind === "project"
                      ? "project file"
                      : "recalled file"
                    : `${item.mimeType} · ${formatBytes(item.size)}`}
                </span>
              </>
            )}
            {item.status === "uploading" ? (
              <Loader2
                size={12}
                className="spin attachment__status"
                aria-label="Uploading"
              />
            ) : null}
            {item.status === "error" ? (
              <AlertTriangle
                size={12}
                className="status-error attachment__status"
                aria-label="Upload failed"
              />
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
  );
}
