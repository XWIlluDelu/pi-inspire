import type { CopyLoader } from "../content-copy";
import { store } from "../store";
import { useCopied } from "../use-copied";
import { CopyFeedback } from "./CopyFeedback";

interface CopyActionProps {
  text?: string;
  getContent?: CopyLoader;
  label: string;
  className: string;
  iconSize?: number;
  copiedLabel?: string;
  copyLabel?: string;
  disabled?: boolean;
  onError?: (message: string) => void;
}

/** Shared content action; availability never depends on a text-only projection. */
export function CopyAction({
  text,
  getContent,
  label,
  className,
  iconSize = 13,
  copiedLabel = `${label} copied`,
  copyLabel = `Copy ${label.toLowerCase()}`,
  disabled = false,
  onError = store.reportCopyError,
}: CopyActionProps) {
  const { copied, copying, copy } = useCopied({
    onError,
    scope: text,
  });
  if (text === undefined && !getContent) return null;
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={
        copying
          ? `Loading ${label.toLowerCase()}`
          : copied
            ? copiedLabel
            : copyLabel
      }
      title={copying ? "Loading" : copied ? "Copied" : copyLabel}
      disabled={disabled || copying}
      onClick={() => void copy(getContent ?? text ?? "", store.copyOwnership())}
    >
      <CopyFeedback copied={copied} copying={copying} size={iconSize} />
    </button>
  );
}
