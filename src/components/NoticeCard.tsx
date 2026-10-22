import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import type { Ref } from "react";
import type { Notice } from "../events";
import { CopyAction } from "./CopyAction";

function noticeTitle(kind: Notice["kind"]): string {
  switch (kind) {
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Notice";
  }
}

/** Shared notification presentation; callers retain placement and lifetime. */
export function NoticeCard({
  kind,
  text,
  onDismiss,
  dismissLabel = "Dismiss notification",
  className = "",
  compact = false,
  ref,
}: {
  kind: Notice["kind"];
  text: string;
  onDismiss: () => void;
  dismissLabel?: string;
  className?: string;
  compact?: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  const match = /^\(([^)]+)\):\s*(.+)$/s.exec(text);
  const label = noticeTitle(kind);
  const title = match ? `${label} · ${match[1]}` : label;
  const Icon =
    kind === "warning" ? AlertTriangle : kind === "error" ? XCircle : Info;
  return (
    <div
      ref={ref}
      className={`notice notice--${kind}${compact ? " notice--compact" : ""}${className ? ` ${className}` : ""}`}
      role={kind === "error" ? "alert" : "status"}
      aria-label={compact ? label : undefined}
    >
      <div className="notice__head">
        <span className="notice__title">
          <Icon size={14} aria-hidden />
          <span>{title}</span>
        </span>
        <div className="notice__actions">
          <CopyAction text={text} label={label} className="notice__copy" />
          <button
            type="button"
            className="notice__dismiss"
            onClick={onDismiss}
            aria-label={dismissLabel}
            title="Dismiss"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
      <div className="notice__text">
        {compact ? text : match ? match[2] : text}
      </div>
    </div>
  );
}
