import { type ComponentProps, useId } from "react";
import { shallowEqual, useAppState } from "../store";

/** Navigation entrances share unread attention while their session list is hidden. */
export function NavigationToggle({
  selectedSessionId,
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  selectedSessionId?: string | null;
}) {
  const descriptionId = useId();
  const { count, urgent } = useAppState((state) => {
    const selected =
      selectedSessionId === undefined ? state.sessionId : selectedSessionId;
    let count = 0;
    let urgent = false;
    for (const [id, status] of Object.entries(state.sessionStatuses)) {
      if (id === selected) continue;
      if (status.indicator === "completed") count += 1;
      else if (
        status.indicator === "failed" ||
        status.indicator === "attention"
      ) {
        count += 1;
        urgent = true;
      }
    }
    return { count, urgent };
  }, shallowEqual);

  return (
    <button
      {...props}
      type="button"
      className={`navigation-toggle ${className ?? ""}`}
      aria-describedby={count > 0 ? descriptionId : undefined}
    >
      {children}
      {count > 0 ? (
        <span
          id={descriptionId}
          className={`navigation-toggle__attention${urgent ? " navigation-toggle__attention--urgent" : ""}`}
        >
          <span aria-hidden>{count > 9 ? "9+" : count}</span>
          <span className="sr-only">
            {count === 1
              ? "1 other session needs attention"
              : `${count} other sessions need attention`}
          </span>
        </span>
      ) : null}
    </button>
  );
}
