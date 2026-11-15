import { useCallback, useState } from "react";
import { store } from "../store";
import { LoadedImagePreview } from "./ImagePreview";

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
