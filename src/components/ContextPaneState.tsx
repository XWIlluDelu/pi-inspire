import type { ReactNode } from "react";

export function ContextPaneState({
  icon,
  title,
  hint,
  children,
  role = "status",
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className="res__state" role={role}>
      <div className="res__state-icon">{icon}</div>
      <p className="res__state-title">{title}</p>
      {hint ? <p className="res__state-hint">{hint}</p> : null}
      {children}
    </div>
  );
}
