import { Check, Copy } from "lucide-react";
import { type CopyLoader, copyLoader } from "../content-copy";
import { store } from "../store";
import { useCopied } from "../use-copied";
import { PiLoader } from "./PiLoader";

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
      {copying ? (
        <PiLoader size={iconSize} aria-hidden />
      ) : copied ? (
        <Check size={iconSize} aria-hidden />
      ) : (
        <Copy size={iconSize} aria-hidden />
      )}
    </button>
  );
}
