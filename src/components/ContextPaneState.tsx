import type { ReactNode } from "react";

export function ContextPaneState({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="res__state" role="status">
      <div className="res__state-icon">{icon}</div>
      <p className="res__state-title">{title}</p>
      <p className="res__state-hint">{hint}</p>
      {children}
    </div>
  );
}
