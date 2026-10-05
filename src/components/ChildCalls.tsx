import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  XCircle,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ChildCall, ChildCallList } from "../../shared/tool-activity";
import { stripTerminalSequences } from "../ansi";

const statusLabels: Record<ChildCall["status"], string> = {
  running: "Running",
  ok: "Finished",
  error: "Failed",
  cancelled: "Cancelled",
  unfinished: "Unfinished",
};

function argumentSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return typeof value === "string" ? value : "";
  const args = value as Record<string, unknown>;
  for (const key of ["path", "file", "command", "pattern", "query", "url"]) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
  return Object.entries(args)
    .filter(
      ([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

function callSummary(call: ChildCall): string {
  if (call.arguments !== undefined) return argumentSummary(call.arguments);
  if (!call.argumentsPreview) return "";
  try {
    return argumentSummary(JSON.parse(call.argumentsPreview));
  } catch {
    return call.argumentsPreview;
  }
}

function CallRow({ call }: { call: ChildCall }) {
  const [open, setOpen] = useState(false);
  const model =
    call.name === "models.classify" || call.name === "models.generateImages";
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
  const summary = stripTerminalSequences(callSummary(call)).slice(0, 160);
  const icon =
    call.status === "running" ? (
      <Loader2 size={12} className="spin" aria-hidden />
    ) : call.status === "ok" ? (
      <CheckCircle2 size={12} aria-hidden />
    ) : call.status === "error" ? (
      <XCircle size={12} aria-hidden />
    ) : (
      <Circle size={12} aria-hidden />
    );
  const row = (
    <>
      <span
        className={`child-call__status child-call__status--${call.status}`}
        title={statusLabels[call.status]}
      >
        {icon}
        <span className="sr-only">{statusLabels[call.status]}</span>
      </span>
      <code className="child-call__name">{call.name}</code>
      {summary ? <span className="child-call__summary">{summary}</span> : null}
    </>
  );
  return detail ? (
    <details
      className="child-call"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="child-call__row">
        {row}
        <ChevronRight size={12} className="child-call__chevron" aria-hidden />
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
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (running && following.current && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [list, running]);
  return (
    <>
      <div
        className="child-calls"
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label="Child calls"
        onFocusCapture={() => {
          following.current = false;
          onRead();
        }}
        onPointerDown={() => {
          following.current = false;
          onRead();
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
          if (!following.current) onRead();
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
