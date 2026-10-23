import { type CopyLoader, copyLoader } from "../content-copy";
import { store } from "../store";
import { useCopied } from "../use-copied";
import { CopyFeedback } from "./CopyFeedback";

interface CopyActionProps {
  text?: string;
  getText?: () => Promise<string | null>;
  getContent?: CopyLoader;
  label: string;
  className: string;
  iconSize?: number;
  disabled?: boolean;
  onError?: (message: string) => void;
}

/** Shared content action; availability never depends on a text-only projection. */
export function CopyAction({
  text,
  getText,
  getContent,
  label,
  className,
  iconSize = 13,
  disabled = false,
  onError = store.reportCopyError,
}: CopyActionProps) {
  const { copied, copying, copy } = useCopied({
    onError,
    scope: text,
  });
  if (!text && !getText && !getContent) return null;
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={
        copying
          ? `Loading ${label.toLowerCase()}`
          : copied
            ? `${label} copied`
            : `Copy ${label.toLowerCase()}`
      }
      title={
        copying ? "Loading" : copied ? "Copied" : `Copy ${label.toLowerCase()}`
      }
      disabled={disabled || copying}
      onClick={() =>
        void copy(
          getContent ?? (getText ? copyLoader(getText) : (text ?? "")),
          store.copyOwnership(),
        )
      }
    >
      <CopyFeedback copied={copied} copying={copying} size={iconSize} />
    </button>
  );
}
