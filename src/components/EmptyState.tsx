import type { ReactNode } from "react";

export function EmptyState({
  title,
  hint,
  icon,
  className,
  role,
  children,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  className?: string;
  role?: "status" | "alert";
  children?: ReactNode;
}) {
  return (
    <div
      className={className ? `empty-state ${className}` : "empty-state"}
      role={role}
    >
      {icon}
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
      {children}
    </div>
  );
}
