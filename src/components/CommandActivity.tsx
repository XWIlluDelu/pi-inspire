import {
  CheckCircle2,
  CircleStop,
  Download,
  TerminalSquare,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
} from "react";
import {
  type NativeCommandActivity as Activity,
  isCommandQuery,
} from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import { readingDwellMs, useReadingDwell } from "../use-reading-dwell";
import { NoticeCard } from "./NoticeCard";
import { PiLoader } from "./PiLoader";

const statusLabel = {
  running: "Running",
  success: "Done",
  cancelled: "Cancelled",
  error: "Failed",
  warning: "Needs attention",
  info: "Info",
} satisfies Record<Activity["status"], string>;

const activityIcons: Partial<Record<Activity["status"], ReactNode>> = {
  running: <PiLoader size={14} />,
  success: <CheckCircle2 size={14} />,
  cancelled: <CircleStop size={14} />,
};

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
  const { ref, leaving } = useReadingDwell<HTMLDivElement>(
    isCommandQuery(activity)
      ? activity.command === "session"
        ? 8_000
        : readingDwellMs(activity.message)
      : null,
    dismiss,
    dockRef,
  );
  const isSession =
    activity.command === "session" && activity.status === "info";
  const { details = [], status } = activity;
  const message = isSession
    ? details.length
      ? ""
      : "Usage information is unavailable."
    : activity.message;
  const title = `/${activity.command}`;
  return (
    <NoticeCard
      ref={ref}
      kind={status}
      className={leaving ? "feedback--leaving" : ""}
      icon={activityIcons[status]}
      title={
        <>
          <code>{title}</code> {statusLabel[status]}
        </>
      }
      onDismiss={status === "running" ? undefined : dismiss}
      dismissLabel={`Dismiss ${title} result`}
    >
      {message && <p>{message}</p>}
      {details.length > 0 && (
        <dl className="command-activity__details">
          {details.map((detail, index) => (
            <div key={detail.id ?? `${detail.label}:${index}`}>
              <dt>{detail.label}</dt>
              <dd title={detail.value}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {activity.download ? (
        <button
          type="button"
          className="button command-activity__action"
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
          className="button command-activity__action"
          onClick={() =>
            void store.runCommandActivityAction(activity.sessionId, activity.id)
          }
        >
          {activity.action.kind === "open-terminal" ? (
            <TerminalSquare size={13} aria-hidden />
          ) : null}
          {activity.action.label}
        </button>
      ) : null}
    </NoticeCard>
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
