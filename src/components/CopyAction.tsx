import { Check, Copy, Loader2 } from "lucide-react";
import type { CopyLoader } from "../content-copy";
import { store } from "../store";
import { useCopied } from "../use-copied";

interface CopyActionProps {
  text?: string;
  getText?: () => Promise<string | null>;
  getContent?: CopyLoader;
  label: string;
  className: string;
}

/** Shared content action; availability never depends on a text-only projection. */
export function CopyAction({
  text,
  getText,
  getContent,
  label,
  className,
}: CopyActionProps) {
  const { copied, copying, copy } = useCopied({
    onError: store.reportCopyError,
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
      disabled={copying}
      onClick={() =>
        void copy(getContent ?? getText ?? text ?? "", store.copyOwnership())
      }
    >
      {copying ? (
        <Loader2 className="spin" size={13} aria-hidden />
      ) : copied ? (
        <Check size={13} aria-hidden />
      ) : (
        <Copy size={13} aria-hidden />
      )}
    </button>
  );
}
