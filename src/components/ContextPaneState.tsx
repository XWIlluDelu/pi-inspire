import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";

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
    <EmptyState
      title={title}
      hint={hint}
      icon={icon}
      className={className ? `res__state ${className}` : "res__state"}
      role={role}
    >
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
    </EmptyState>
  );
}
