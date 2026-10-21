import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";

/** Local disclosure inside a readable body; the native summary owns toggling. */
export function DetailSummary({
  children,
  className = "",
  ...props
}: ComponentProps<"summary">) {
  return (
    <summary className={`detail-summary ${className}`} {...props}>
      <ChevronRight size={12} aria-hidden className="detail-summary__chevron" />
      <span>{children}</span>
    </summary>
  );
}
