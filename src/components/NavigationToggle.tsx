import { type ComponentProps, useId } from "react";
import { presentSessionActivity } from "../session-activity-presentation";
import { shallowEqual, useAppState } from "../store";

/** Navigation entrances share unread attention while their session list is hidden. */
export function NavigationToggle({
  className,
  children,
  ...props
}: ComponentProps<"button">) {
  const descriptionId = useId();
  const { selected, managed, external } = useAppState(
    (state) => ({
      selected: state.sessionId,
      managed: state.sessionStatuses,
      external: state.externalSessionActivities,
    }),
    shallowEqual,
  );
  let count = 0;
  let urgent = false;
  for (const id of new Set([
    ...Object.keys(managed),
    ...Object.keys(external),
  ])) {
    if (id === selected) continue;
    const { indicator } = presentSessionActivity(managed[id], external[id]);
    if (!indicator || indicator === "running") continue;
    count++;
    if (indicator !== "completed") urgent = true;
  }

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
