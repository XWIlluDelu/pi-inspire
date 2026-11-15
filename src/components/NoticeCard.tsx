import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { CopyAction } from "./CopyAction";

/** Shared notification presentation; callers retain placement and lifetime. */
export function NoticeCard({
  kind,
  text = "",
  title,
  icon,
  children,
  copyText = text,
  copyLabel,
  onDismiss,
  dismissLabel = "Dismiss notification",
  dismissTitle = "Dismiss",
  className = "",
  compact = false,
  ref,
}: {
  kind: "info" | "warning" | "error" | "running" | "success" | "cancelled";
  text?: string;
  title?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  copyText?: string;
  copyLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissTitle?: string;
  className?: string;
  compact?: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  const label =
    kind === "warning" ? "Warning" : kind === "error" ? "Error" : "Notice";
  const match = !compact && !title ? /^\(([^)]+)\):\s*(.+)$/s.exec(text) : null;
  const Icon =
    kind === "warning" ? AlertTriangle : kind === "error" ? XCircle : Info;
  return (
    <div
      ref={ref}
      className={`notice notice--${kind}${compact ? " notice--compact" : ""}${className ? ` ${className}` : ""}`}
      role={kind === "error" ? "alert" : "status"}
    >
      <span className="notice__icon" aria-hidden>
        {icon ?? <Icon size={14} />}
      </span>
      {!compact && (
        <span className="notice__title">
          {title ?? (match ? `${label} · ${match[1]}` : label)}
        </span>
      )}
      {(text || children) && (
        <div className="notice__text">
          {compact && <span className="sr-only">{label}. </span>}
          {match?.[2] ?? text}
          {children}
        </div>
      )}
      {(copyText || onDismiss) && (
        <div className="notice__actions">
          <CopyAction
            text={copyText}
            label={copyLabel ?? label}
            className="notice__copy"
          />
          {onDismiss && (
            <button
              type="button"
              className="icon-button"
              onClick={onDismiss}
              aria-label={dismissLabel}
              title={dismissTitle}
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
