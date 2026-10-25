import { ChevronRight } from "lucide-react";
import type { ChildCall, ChildCallList } from "../../shared/tool-activity";
import { stripTerminalSequences } from "../ansi";
import { childCallSummary, isModelCall } from "../child-call-summary";
import { PiLoader } from "./PiLoader";
import { PiStatus } from "./PiStatus";
import { ResourcePathLabel } from "./ResourcePathLabel";
import {
  useActivityReaderExpanded,
  useActivityReaderScroll,
} from "./transcript-activity-visibility";

const statusLabels: Record<ChildCall["status"], string> = {
  running: "Running",
  ok: "Finished",
  error: "Failed",
  cancelled: "Cancelled",
  unfinished: "Unfinished",
};

/** Describe observed calls, not inferred script intent or the parent's outcome. */
export function childCallsSummary(list?: ChildCallList): string {
  if (!list?.calls.length) return "";
  const failed = list.calls.filter((call) => call.status === "error").length;
  const count = list.calls.length;
  const summary = `${count} call${count === 1 ? "" : "s"}`;
  return failed ? `${failed} failed · ${summary}` : summary;
}

function CallRow({ call }: { call: ChildCall }) {
  const [open, setOpen] = useActivityReaderExpanded(`child-call:${call.key}`);
  const model = isModelCall(call.name);
  const duration =
    call.durationMs !== undefined && call.durationMs >= 1_000
      ? `${(call.durationMs / 1_000).toFixed(1)} s`
      : undefined;
  const detail =
    call.arguments !== undefined ||
    (!model && Boolean(call.argumentsPreview)) ||
    call.argumentsOmitted ||
    call.error ||
    duration;
  const summary = childCallSummary(call);
  const icon =
    call.status === "running" ? (
      <PiLoader size={12} aria-hidden />
    ) : call.status === "ok" ? (
      <PiStatus status="success" size={12} aria-hidden />
    ) : call.status === "error" ? (
      <PiStatus status="error" size={12} aria-hidden />
    ) : (
      <PiStatus status="neutral" size={12} aria-hidden />
    );
  const row = (
    <>
      <code className="child-call__name">{call.name}</code>
      <span
        className={`child-call__status child-call__status--${call.status}`}
        title={statusLabels[call.status]}
      >
        {icon}
        <span className="sr-only">{statusLabels[call.status]}</span>
      </span>
      {summary.text ? (
        <span className="child-call__summary">
          {summary.path ? (
            <ResourcePathLabel path={summary.text} />
          ) : (
            summary.text
          )}
        </span>
      ) : null}
    </>
  );
  return detail ? (
    <details
      className="child-call"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="child-call__row">
        <ChevronRight size={12} className="child-call__chevron" aria-hidden />
        {row}
      </summary>
      {open ? (
        <div className="child-call__detail">
          {duration ? (
            <span className="child-call__duration">Duration · {duration}</span>
          ) : null}
          {call.argumentsOmitted ? (
            <div className="card__pending">Arguments not retained</div>
          ) : null}
          {call.arguments !== undefined || (!model && call.argumentsPreview) ? (
            <>
              <div className="card__section-label">
                {call.argumentsPreview !== undefined
                  ? "Arguments preview"
                  : "Available arguments"}
              </div>
              <pre
                className="card__mono"
                tabIndex={0}
                role="group"
                aria-label={
                  call.argumentsPreview !== undefined
                    ? "Arguments preview"
                    : "Available arguments"
                }
              >
                {stripTerminalSequences(
                  call.argumentsPreview ??
                    JSON.stringify(call.arguments, null, 2),
                )}
              </pre>
            </>
          ) : null}
          {call.error ? (
            <pre
              className="card__mono card__mono--error"
              tabIndex={0}
              role="group"
              aria-label="Call error"
            >
              {stripTerminalSequences(call.error)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </details>
  ) : (
    <div className="child-call">
      <div className="child-call__row">{row}</div>
    </div>
  );
}

/** Native records are Host-bounded. Details remain lazy, and a reader can stop
 * following updates by scrolling or focusing a row. */
export function ChildCalls({
  list,
  running,
  onRead,
}: {
  list: ChildCallList;
  running: boolean;
  onRead: () => void;
}) {
  const scroll = useActivityReaderScroll<HTMLDivElement>(
    "child-calls-scroll",
    list,
    running,
  );
  return (
    <>
      <div
        className="child-calls"
        ref={scroll.props.ref}
        tabIndex={0}
        role="group"
        aria-label="Child calls"
        onFocusCapture={() => {
          scroll.stopFollowing();
          onRead();
        }}
        onPointerDown={() => {
          scroll.stopFollowing();
          onRead();
        }}
        onScroll={(event) => {
          scroll.props.onScroll(event);
          const element = event.currentTarget;
          if (
            element.scrollHeight - element.scrollTop - element.clientHeight >=
            24
          )
            onRead();
        }}
      >
        {list.calls.map((call) => (
          <CallRow key={call.key} call={call} />
        ))}
      </div>
      {!list.complete ? (
        <div className="card__pending">Call record incomplete</div>
      ) : null}
    </>
  );
}
