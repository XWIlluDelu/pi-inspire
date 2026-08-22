import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { useCopied } from "../use-copied";

interface CopyActionProps {
  text?: string;
  getText?: () => Promise<string | null>;
  label: string;
  className: string;
}

/** A compact clipboard control with in-place confirmation. */
export function CopyAction({
  text,
  getText,
  label,
  className,
}: CopyActionProps) {
  const { copied, copy } = useCopied();
  const [loading, setLoading] = useState(false);
  if (!text && !getText) return null;
  const copyResolvedText = async () => {
    if (loading) return;
    if (!getText) {
      await copy(text ?? "");
      return;
    }
    setLoading(true);
    try {
      const resolved = await getText();
      if (resolved !== null) await copy(resolved);
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={
        loading
          ? `Loading ${label.toLowerCase()}`
          : copied
            ? `${label} copied`
            : `Copy ${label.toLowerCase()}`
      }
      title={
        loading ? "Loading" : copied ? "Copied" : `Copy ${label.toLowerCase()}`
      }
      disabled={loading}
      onClick={() => void copyResolvedText()}
    >
      {loading ? (
        <Loader2 className="spin" size={13} aria-hidden />
      ) : copied ? (
        <Check size={13} aria-hidden />
      ) : (
        <Copy size={13} aria-hidden />
      )}
    </button>
  );
}
