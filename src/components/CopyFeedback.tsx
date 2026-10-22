import { Check, Copy } from "lucide-react";
import { PiLoader } from "./PiLoader";

/** Presentation only: the owning control keeps its copy lifetime and semantics. */
export function CopyFeedback({
  copied,
  copying = false,
  size = 13,
}: {
  copied: boolean;
  copying?: boolean;
  size?: number;
}) {
  return (
    <span
      className="copy-feedback"
      data-state={copying ? "copying" : copied ? "copied" : "idle"}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Copy className="copy-feedback__idle" size={size} />
      <Check className="copy-feedback__success" size={size} />
      {copying ? <PiLoader size={size} /> : null}
    </span>
  );
}
