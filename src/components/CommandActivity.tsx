import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  CircleX,
  Info,
  Loader2,
  TerminalSquare,
  X,
} from "lucide-react";
import { memo } from "react";
import type { NativeCommandActivity as Activity } from "../app-state";
import { shallowEqual, store, useAppState } from "../store";

function ActivityIcon({ status }: { status: Activity["status"] }) {
  if (status === "running")
    return <Loader2 size={14} className="spin" aria-hidden />;
  if (status === "success") return <CheckCircle2 size={14} aria-hidden />;
  if (status === "error") return <CircleX size={14} aria-hidden />;
  if (status === "warning") return <AlertTriangle size={14} aria-hidden />;
  if (status === "cancelled") return <CircleStop size={14} aria-hidden />;
  return <Info size={14} aria-hidden />;
}

export const CommandActivity = memo(function CommandActivity() {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      activities: source.sessionId
        ? (source.commandActivities[source.sessionId] ?? [])
        : [],
    }),
    shallowEqual,
  );
  if (!state.sessionId || state.activities.length === 0) return null;

  return (
    <section className="command-activity" aria-label="Command activity">
      {state.activities.map((activity) => (
        <article
          key={activity.id}
          className={`command-activity__item command-activity__item--${activity.status}`}
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
            <p>{activity.message}</p>
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
              onClick={() =>
                store.dismissCommandActivity(activity.sessionId, activity.id)
              }
            >
              <X size={13} aria-hidden />
            </button>
          ) : null}
        </article>
      ))}
    </section>
  );
});
