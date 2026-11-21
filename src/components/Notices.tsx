import { Download } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef } from "react";
import type { Notice } from "../events";
import { shallowEqual, store, useAppState } from "../store";
import {
  type AvailableUpdates,
  availableUpdates,
  updateDetailsText,
} from "../update-availability";
import { readingDwellMs, useReadingDwell } from "../use-reading-dwell";
import { EarlierBranchBanner } from "./EarlierBranchBanner";
import { NoticeCard } from "./NoticeCard";

function NoticeItem({ notice }: { notice: Notice }) {
  const dismiss = useCallback(
    () => store.dismissNotice(notice.id),
    [notice.id],
  );
  const { ref, leaving } = useReadingDwell<HTMLDivElement>(
    notice.kind === "info" ? readingDwellMs(notice.text) : null,
    dismiss,
  );
  return (
    <NoticeCard
      ref={ref}
      compact
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
    <NoticeCard
      kind="info"
      title="Updates available"
      icon={<Download size={14} />}
      copyText={updateDetailsText(updates)}
      copyLabel="Update details"
      dismissLabel="Close updates for 24 hours"
      dismissTitle="Close for 24 hours"
      onDismiss={store.updates.snooze}
    >
      {message}{" "}
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
    </NoticeCard>
  );
}

export const Notices = memo(function Notices({
  onViewUpdates,
}: {
  onViewUpdates: () => void;
}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      viewId: source.view.viewId,
      restoreSavedLeafId: source.view.restoreSavedLeafId,
      notices: source.live.notices,
      readOnlyReason: source.readOnlyReason,
      updateSnoozedUntil: source.updateSnoozedUntil,
      inspireUpdateCheck: source.inspireUpdateCheck,
      piUpdateCheck: source.piUpdateCheck,
    }),
    shallowEqual,
  );
  const updates =
    state.updateSnoozedUntil === null ? availableUpdates(state) : null;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const composer = document.querySelector<HTMLElement>(
      "main .composer, main .composer-readonly",
    );
    const measure = () => {
      const stackBounds = element.getBoundingClientRect();
      // Keep the editor reachable when a long stack overlaps its column.
      const composerBounds = composer?.getBoundingClientRect();
      if (
        composerBounds &&
        composerBounds.width > 0 &&
        stackBounds.left < composerBounds.right &&
        stackBounds.right > composerBounds.left &&
        composerBounds.top > stackBounds.top + 8
      ) {
        element.style.setProperty(
          "--notice-bottom-inset",
          `max(var(--space-4), var(--safe-bottom), ${window.innerHeight - composerBounds.top + 8}px)`,
        );
      } else {
        element.style.removeProperty("--notice-bottom-inset");
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
    const observer = new ResizeObserver(measure);
    [
      element,
      ...element.children,
      composer,
      composer?.closest(".composer-dock"),
      document.querySelector("main"),
    ].forEach((node) => {
      if (node) observer.observe(node);
    });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
  if (state.notices.length === 0 && !updates && !state.restoreSavedLeafId)
    return null;
  return (
    <div ref={ref} className="notices" aria-live="polite">
      {state.restoreSavedLeafId ? (
        <EarlierBranchBanner
          key={`${state.sessionId}:${state.viewId}`}
          restoreSavedLeafId={state.restoreSavedLeafId}
        />
      ) : null}
      {state.notices.map((notice) => (
        <NoticeItem key={`${notice.kind}:${notice.text}`} notice={notice} />
      ))}
      {updates ? (
        <UpdateNotice updates={updates} onViewUpdates={onViewUpdates} />
      ) : null}
    </div>
  );
});
