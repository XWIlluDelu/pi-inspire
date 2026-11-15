import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";

export function ContextPaneState({
  icon,
  title,
  hint,
  children,
  className,
  role = "status",
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
  className?: string;
  role?: "status" | "alert";
  action?: { label?: string; run: () => void };
}) {
  return (
    <div className={`empty-state res__state ${className ?? ""}`} role={role}>
      {icon}
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
      {children}
      {action && (
        <button
          type="button"
          className="button button--quiet"
          onClick={action.run}
        >
          {!action.label && <RotateCw size={12} aria-hidden />}
          {action.label ?? "Retry"}
        </button>
      )}
    </div>
  );
}
