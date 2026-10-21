import { useCallback } from "react";
import { useInspectionHistory } from "./use-inspection-history";

/** Gallery changes reuse one inspection; Back closes it, not the conversation. */
export function useImageHistory(open: boolean, onClose: () => void) {
  useInspectionHistory(open ? 1 : 0, () => onClose(), "__inspireImagePreview");
  return useCallback(() => onClose(), [onClose]);
}
