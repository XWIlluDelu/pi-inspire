import { AlertTriangle, Download, Info, X, XCircle } from "lucide-react";
import { memo, useCallback } from "react";
import type { Notice } from "../events";
import { shallowEqual, store, useAppState } from "../store";
import {
  type AvailableUpdates,
  availableUpdates,
} from "../update-availability";
import { useReadingDwell } from "../use-reading-dwell";
import { CopyAction } from "./CopyAction";

function parseNoticeText(text: string): { tag: string | null; body: string } {
  const match = /^\(([^)]+)\):\s*(.+)$/s.exec(text);
  if (match) {
    return { tag: match[1]!, body: match[2]! };
  }
  return { tag: null, body: text };
}

function NoticeIcon({ kind }: { kind: Notice["kind"] }) {
  switch (kind) {
    case "warning":
      return <AlertTriangle size={13} aria-hidden />;
    case "error":
      return <XCircle size={13} aria-hidden />;
    default:
      return <Info size={13} aria-hidden />;
  }
}

function noticeDefaultTitle(kind: Notice["kind"]): string {
  switch (kind) {
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Notice";
  }
}

function NoticeItem({ notice }: { notice: Notice }) {
  const dismiss = useCallback(
    () => store.dismissNotice(notice.id),
    [notice.id],
  );
  const { ref, leaving } = useReadingDwell<HTMLDivElement>(
    notice.kind === "info" ? 8_000 : null,
    dismiss,
  );
  const { tag, body } = parseNoticeText(notice.text);
  const copyLabel =
    notice.kind === "warning"
      ? "Warning"
      : notice.kind === "error"
        ? "Error"
        : "Notice";
  const title = tag
    ? `${noticeDefaultTitle(notice.kind)} · ${tag}`
    : noticeDefaultTitle(notice.kind);

  return (
    <div
      ref={ref}
      className={`notice notice--${notice.kind}${leaving ? " feedback--leaving" : ""}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <div className="notice__head">
        <span className="notice__title">
          <NoticeIcon kind={notice.kind} />
          <span>{title}</span>
        </span>
        <div className="notice__actions">
          <CopyAction
            text={notice.text}
            label={copyLabel}
            className="notice__copy"
          />
          <button
            type="button"
            className="notice__dismiss"
            onClick={dismiss}
            aria-label="Dismiss notification"
            title="Dismiss"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
      <div className="notice__text">{body}</div>
    </div>
  );
}

function updateNoticeText(updates: AvailableUpdates): string {
  const items: string[] = [];
  if (updates.pi) items.push(`Pi ${updates.pi.latestVersion}`);
  if (updates.extensions.length > 0) {
    items.push(
      `${updates.extensions.length} extension${updates.extensions.length === 1 ? "" : "s"}`,
    );
  }
  if (updates.inspire) items.push(`INSΠRE ${updates.inspire.latestVersion}`);
  return `${items.join(" · ")} available.`;
}

function updateNoticeDetails(updates: AvailableUpdates): string {
  const lines: string[] = [];
  if (updates.pi) {
    lines.push(
      `Pi ${updates.pi.currentVersion} → ${updates.pi.latestVersion}`,
      "Run pi update",
      updates.pi.releaseUrl,
    );
  }
  if (updates.extensions.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "Extensions",
      ...updates.extensions.map((update) => `- ${update.displayName}`),
      "Run pi update --extensions",
    );
  }
  if (updates.inspire) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `INSΠRE ${updates.inspire.currentVersion} → ${updates.inspire.latestVersion}`,
      updates.inspire.releaseUrl,
    );
  }
  return lines.join("\n");
}

function UpdateNotice({
  updates,
  onViewUpdates,
}: {
  updates: AvailableUpdates;
  onViewUpdates: () => void;
}) {
  const message = updateNoticeText(updates);
  return (
    <div className="notice notice--info" role="status">
      <div className="notice__head">
        <span className="notice__title">
          <Download size={13} aria-hidden />
          <span>Updates available</span>
        </span>
        <div className="notice__actions">
          <CopyAction
            text={updateNoticeDetails(updates)}
            label="Update details"
            className="notice__copy"
          />
          <button
            type="button"
            className="notice__dismiss"
            onClick={store.snoozeUpdate}
            aria-label="Close updates for 24 hours"
            title="Close for 24 hours"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
      <div className="notice__text">
        <span>{message}</span>{" "}
        <a
          className="notice__link"
          href="#settings-updates"
          onClick={(event) => {
            event.preventDefault();
            onViewUpdates();
          }}
        >
          View updates
        </a>
      </div>
    </div>
  );
}

export const Notices = memo(function Notices({
  onViewUpdates,
}: {
  onViewUpdates: () => void;
}) {
  const state = useAppState(
    (source) => ({
      notices: source.notices,
      inspireUpdateChecking: source.inspireUpdateChecking,
      piUpdateChecking: source.piUpdateChecking,
      updateSnoozedUntil: source.updateSnoozedUntil,
      inspireUpdateCheck: source.inspireUpdateCheck,
      piUpdateCheck: source.piUpdateCheck,
    }),
    shallowEqual,
  );
  const updates =
    !state.inspireUpdateChecking &&
    !state.piUpdateChecking &&
    state.updateSnoozedUntil === null
      ? availableUpdates(state)
      : null;
  if (state.notices.length === 0 && !updates) return null;
  return (
    <div className="notices" aria-live="polite">
      {state.notices.map((notice) => (
        <NoticeItem key={`${notice.kind}:${notice.text}`} notice={notice} />
      ))}
      {updates ? (
        <UpdateNotice updates={updates} onViewUpdates={onViewUpdates} />
      ) : null}
    </div>
  );
});
