import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";

export function ContextPaneState({
  icon,
  title,
  hint,
  children,
  className,
  role = "status",
  onRetry,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
  className?: string;
  role?: "status" | "alert";
  onRetry?: () => void;
}) {
  return (
    <div className={`empty-state res__state ${className ?? ""}`} role={role}>
      {icon}
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
      {children}
      {onRetry && (
        <button
          type="button"
          className="button button--quiet"
          onClick={onRetry}
        >
          <RotateCw size={12} aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}
