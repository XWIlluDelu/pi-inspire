import { Download, X } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef } from "react";
import type { Notice } from "../events";
import { shallowEqual, store, useAppState } from "../store";
import {
  type AvailableUpdates,
  availableUpdates,
  updateDetailsText,
} from "../update-availability";
import { useReadingDwell } from "../use-reading-dwell";
import { CopyAction } from "./CopyAction";
import { NoticeCard } from "./NoticeCard";

function NoticeItem({ notice }: { notice: Notice }) {
  const dismiss = useCallback(
    () => store.dismissNotice(notice.id),
    [notice.id],
  );
  const { ref, leaving } = useReadingDwell<HTMLDivElement>(
    notice.kind === "info" ? 8_000 : null,
    dismiss,
  );
  return (
    <NoticeCard
      ref={ref}
      kind={notice.kind}
      text={notice.text}
      onDismiss={dismiss}
      className={leaving ? "feedback--leaving" : ""}
    />
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
          <Download size={14} aria-hidden />
          <span>Updates available</span>
        </span>
        <div className="notice__actions">
          <CopyAction
            text={updateDetailsText(updates)}
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
      error: source.error,
      connection: source.connection,
      readOnlyReason: source.readOnlyReason,
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
  const ref = useRef<HTMLDivElement>(null);
  // Both anchors respect the current header and multiline banners. Rebind
  // after feedback changes can replace those nodes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const boundaries = [
      ...document.querySelectorAll<HTMLElement>(
        "main > .topbar, main > .banner",
      ),
    ];
    const measure = () => {
      if (boundaries.length > 0) {
        const bottom = Math.max(
          ...boundaries.map((node) => node.getBoundingClientRect().bottom),
        );
        element.style.setProperty("--notice-header-bottom", `${bottom}px`);
      }
      // Measure at the full card width, without a previous scrollbar. Normal
      // stacks keep their floating shadows; only overflowing ones need clipping.
      const scrollTop = element.scrollTop;
      element.classList.remove("notices--scrollable");
      // The entrance translates cards by 4px; that painted overflow is not
      // missing layout space and must not clip an otherwise fitting stack.
      const items = [...element.children];
      const gap = Number.parseFloat(getComputedStyle(element).rowGap) || 0;
      const height = items.reduce(
        (total, node) => total + node.getBoundingClientRect().height,
        Math.max(0, items.length - 1) * gap,
      );
      const overflowing = height > element.clientHeight + 1;
      element.classList.toggle("notices--scrollable", overflowing);
      if (overflowing) element.scrollTop = scrollTop;
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    [...boundaries, element, ...element.children].forEach((node) =>
      observer?.observe(node),
    );
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
  if (state.notices.length === 0 && !updates) return null;
  return (
    <div ref={ref} className="notices" aria-live="polite">
      {state.notices.map((notice) => (
        <NoticeItem key={`${notice.kind}:${notice.text}`} notice={notice} />
      ))}
      {updates ? (
        <UpdateNotice updates={updates} onViewUpdates={onViewUpdates} />
      ) : null}
    </div>
  );
});
