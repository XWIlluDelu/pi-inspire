import { useCallback, useState } from "react";
import { store } from "../store";
import { useImageUrl } from "../use-image-url";
import { ImagePreview } from "./ImagePreview";

export function HistoryImage({
  targetId,
  index,
}: {
  targetId: string;
  index: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const loadImage = useCallback(
    (signal: AbortSignal) => store.readBranchImage(targetId, index, signal),
    [targetId, index, attempt],
  );
  const { src: url, error } = useImageUrl(loadImage);
  return error ? (
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
  ) : url ? (
    <ImagePreview
      className="history-detail__image"
      src={url}
      alt="image in this history entry"
    />
  ) : (
    <span role="status">Loading image…</span>
  );
}
