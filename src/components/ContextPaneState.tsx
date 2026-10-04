import type { ReactNode } from "react";

export function ContextPaneState({
  icon,
  title,
  hint,
  children,
  className,
  role = "status",
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
  className?: string;
  role?: "status" | "alert";
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
    </div>
  );
}
