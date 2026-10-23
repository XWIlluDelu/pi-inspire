import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  CircleX,
  Download,
  Info,
  TerminalSquare,
  X,
} from "lucide-react";
import { memo, type RefObject, useCallback, useRef } from "react";
import {
  type NativeCommandActivity as Activity,
  isCommandQuery,
} from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import { readingDwellMs, useReadingDwell } from "../use-reading-dwell";
import { PiLoader } from "./PiLoader";
import { ScrollRail } from "./ScrollRail";

function ActivityIcon({ status }: { status: Activity["status"] }) {
  if (status === "running") return <PiLoader size={14} aria-hidden />;
  if (status === "success") return <CheckCircle2 size={14} aria-hidden />;
  if (status === "error") return <CircleX size={14} aria-hidden />;
  if (status === "warning") return <AlertTriangle size={14} aria-hidden />;
  if (status === "cancelled") return <CircleStop size={14} aria-hidden />;
  return <Info size={14} aria-hidden />;
}

function SessionFacts({
  details,
}: {
  details: NonNullable<Activity["details"]>;
}) {
  if (!details.length) return <p>Usage information is unavailable.</p>;
  return (
    <dl className="command-activity__session">
      {details.map((detail) => (
        <div key={detail.id} className="command-activity__usage-cell">
          <dt>{detail.label}</dt>
          <dd>{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CommandActivityItem({
  activity,
  dockRef,
}: {
  activity: Activity;
  dockRef: RefObject<HTMLElement | null>;
}) {
  const dismiss = useCallback(
    () => store.dismissCommandActivity(activity.sessionId, activity.id),
    [activity.sessionId, activity.id],
  );
  const { ref, leaving } = useReadingDwell<HTMLElement>(
    isCommandQuery(activity)
      ? activity.command === "session"
        ? 8_000
        : readingDwellMs(activity.message ?? "")
      : null,
    dismiss,
    dockRef,
  );
  const isSession =
    activity.command === "session" && activity.status === "info";
  return (
    <article
      ref={ref}
      className={`command-activity__item command-activity__item--${activity.status}${leaving ? " feedback--leaving" : ""}`}
      role={activity.status === "error" ? "alert" : "status"}
    >
      <div className="command-activity__icon">
        <ActivityIcon status={activity.status} />
      </div>
      <div className="command-activity__body">
        <div className="command-activity__heading">
          <code>{activity.title}</code>
          <span className="command-activity__state">
            {activity.status === "running"
              ? "Running"
              : activity.status === "success"
                ? "Done"
                : activity.status === "cancelled"
                  ? "Cancelled"
                  : activity.status === "error"
                    ? "Failed"
                    : activity.status === "warning"
                      ? "Needs attention"
                      : "Info"}
          </span>
        </div>
        {isSession ? (
          <SessionFacts details={activity.details ?? []} />
        ) : (
          <>
            {activity.message ? <p>{activity.message}</p> : null}
            {activity.details?.length ? (
              <dl className="command-activity__details">
                {activity.details.map((detail, index) => (
                  <div key={`${detail.label}:${index}`}>
                    <dt>{detail.label}</dt>
                    <dd title={detail.value}>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        )}
        {activity.download ? (
          <button
            type="button"
            className="command-activity__action"
            onClick={() =>
              void store.downloadCommandExport(activity.sessionId, activity.id)
            }
          >
            <Download size={13} aria-hidden /> Download
          </button>
        ) : null}
        {activity.action ? (
          <button
            type="button"
            className="command-activity__action"
            onClick={() =>
              void store.runCommandActivityAction(
                activity.sessionId,
                activity.id,
              )
            }
          >
            {activity.action.kind === "open-terminal" ? (
              <TerminalSquare size={13} aria-hidden />
            ) : null}
            {activity.action.label}
          </button>
        ) : null}
      </div>
      {activity.status !== "running" ? (
        <button
          type="button"
          className="command-activity__dismiss"
          aria-label={`Dismiss ${activity.title} result`}
          onClick={dismiss}
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </article>
  );
}

export const CommandActivity = memo(function CommandActivity() {
  const dockRef = useRef<HTMLElement>(null);
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      activities: source.sessionId
        ? (source.commandActivities[source.sessionId] ?? [])
        : [],
    }),
    shallowEqual,
  );
  // A /compact request owns its eventual receipt, never the runtime's progress.
  // ActivityBar presents that phase for every trigger and every observer.
  const activities = state.activities.filter(
    (activity) =>
      activity.command !== "compact" || activity.status !== "running",
  );
  if (!state.sessionId || activities.length === 0) return null;

  return (
    <section
      ref={dockRef}
      className="command-activity"
      aria-label="Command activity"
      tabIndex={0}
    >
      <ScrollRail container={dockRef} variant="dock" />
      {activities.map((activity) => (
        <CommandActivityItem
          key={
            isCommandQuery(activity)
              ? `query:${activity.sessionId}:${activity.command}`
              : activity.id
          }
          activity={activity}
          dockRef={dockRef}
        />
      ))}
    </section>
  );
});
