import { Check, Copy } from "lucide-react";
import { useCopied } from "../use-copied";

interface CopyActionProps {
  text: string;
  label: string;
  className: string;
}

/** A compact clipboard control with in-place confirmation. */
export function CopyAction({ text, label, className }: CopyActionProps) {
  const { copied, copy } = useCopied();
  if (!text) return null;
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      title={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      onClick={() => void copy(text)}
    >
      {copied ? (
        <Check size={13} aria-hidden />
      ) : (
        <Copy size={13} aria-hidden />
      )}
    </button>
  );
}
