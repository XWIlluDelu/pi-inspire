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
    <div
      className={className ? `res__state ${className}` : "res__state"}
      role={role}
    >
      <div className="res__state-icon">{icon}</div>
      <p className="res__state-title">{title}</p>
      {hint ? <p className="res__state-hint">{hint}</p> : null}
      {children}
      {onRetry && (
        <button
          type="button"
          className="res__more button--quiet res__state-action"
          onClick={onRetry}
        >
          <RotateCw size={12} aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}
