import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ActivityFoldVisibilityPreference } from "../../shared/contracts";
import {
  ActivityItemOwner,
  type ActivityReadingChoices,
  ReadingChoices,
} from "./transcript-activity-visibility";

import { useActivityCloseDelay } from "./use-activity-close-delay";

const ACTIVITY_PAGE_SIZE = 24;

export interface ActivityItem {
  key: string;
  node: ReactNode;
  kind?: "thinking" | "tool";
  name?: string;
  failed?: boolean;
  toolCallId?: string;
  live?: boolean;
}

function ActivityMatrix({
  items,
  description,
  live,
}: {
  items: readonly ActivityItem[];
  description: string;
  live: boolean;
}) {
  const full = items.length === 9;
  const previousFull = useRef(full);
  const [lighting, setLighting] = useState(false);
  useEffect(() => {
    const wasFull = previousFull.current;
    previousFull.current = full;
    if (!full) setLighting(false);
    if (!full || wasFull) return;
    setLighting(true);
    const timer = window.setTimeout(() => setLighting(false), 800);
    return () => window.clearTimeout(timer);
  }, [full]);
  return (
    <span
      className={`activity-fold__matrix${full ? " activity-fold__matrix--full" : ""}${full && lighting ? " activity-fold__matrix--lighting" : ""}`}
      title={description}
      aria-hidden
    >
      {Array.from({ length: 9 }, (_, index) => {
        const item = items[index];
        return (
          <span
            key={item?.key ?? `empty:${index}`}
            className={
              item
                ? `activity-fold__kind activity-fold__kind--${item.kind}${live && item.live ? " activity-fold__kind--live" : ""}`
                : "activity-fold__cell-empty"
            }
          />
        );
      })}
    </span>
  );
}

function summarizeActivity(items: readonly ActivityItem[]) {
  const tools = new Map<string, number>();
  let steps = 0;
  let thinking = 0;
  let failed = 0;
  for (const item of items) {
    if (item.kind) steps += 1;
    if (item.failed) failed += 1;
    if (item.kind === "thinking") thinking += 1;
    if (item.name) tools.set(item.name, (tools.get(item.name) ?? 0) + 1);
  }
  const names = [...tools].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name,
  );
  if (thinking > 0 && names.length < 3)
    names.unshift(thinking > 1 ? `thinking ×${thinking}` : "thinking");
  const rest = names.length - 3;
  return {
    text: steps
      ? [steps === 1 ? "1 step" : `${steps} steps`, ...names.slice(0, 3)].join(
          " · ",
        ) + (rest > 0 ? ` +${rest}` : "")
      : "",
    failed,
  };
}

export function ResponseActivityFold({
  visibility,
  live,
  choices,
  items,
}: {
  visibility: ActivityFoldVisibilityPreference;
  live: boolean;
  choices: ActivityReadingChoices;
  items: readonly ActivityItem[];
}) {
  const id = useId();
  const [openChoice, setOpen] = useState<boolean | null>(null);
  const [focus, setFocus] = useState<string | true | null>(null);
  const [pageAnchor, setPageAnchor] = useState<string | null>(null);
  const dynamicOpen = useActivityCloseDelay(
    visibility === "dynamic" && live,
    2400,
    800,
  );
  const open =
    openChoice ??
    (visibility === "dynamic"
      ? dynamicOpen || focus !== null
      : visibility !== "collapsed");
  const anchor = typeof focus === "string" ? focus : pageAnchor;
  const at =
    anchor === null ? -1 : items.findIndex(({ key }) => key === anchor);
  const last = Math.max(0, Math.ceil(items.length / ACTIVITY_PAGE_SIZE) - 1);
  const defaultPage = visibility === "expanded" ? 0 : last;
  const page = at < 0 ? defaultPage : Math.floor(at / ACTIVITY_PAGE_SIZE);
  const start = page * ACTIVITY_PAGE_SIZE;
  const matrixItems = items.filter((item) => item.kind).slice(-9);
  const matrixDescription = matrixItems.length
    ? `Recent activity, oldest to newest: ${matrixItems
        .map(
          (item) =>
            `${item.kind === "thinking" ? "Thinking" : "Tool"}${live && item.live ? " (active)" : ""}`,
        )
        .join(", ")}.`
    : "Waiting for activity.";
  const { text, failed } = open
    ? summarizeActivity(items)
    : { text: "", failed: 0 };

  function showPage(next: number) {
    setFocus(true);
    setPageAnchor(
      next === defaultPage
        ? null
        : (items[next * ACTIVITY_PAGE_SIZE]?.key ?? null),
    );
  }

  return (
    <section
      className="activity-fold"
      data-dynamic={visibility === "dynamic" || undefined}
      aria-label="Assistant activity"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocus(null);
      }}
    >
      <button
        type="button"
        className="disclosure-row activity-fold__disclosure"
        aria-controls={id}
        aria-expanded={open}
        aria-description={matrixDescription}
        aria-label={
          open ? "Collapse assistant activity" : "Expand assistant activity"
        }
        onClick={() => {
          setOpen(!open);
          setFocus(null);
        }}
      >
        <ChevronRight
          size={14}
          className={open ? "chev chev--open" : "chev"}
          aria-hidden
        />
        <span>Activity</span>
        <ActivityMatrix
          items={matrixItems}
          description={matrixDescription}
          live={live}
        />
        {text && (
          <span className="activity-fold__summary">
            {text}
            {failed > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="activity-fold__summary-failed">
                  {failed} failed
                </span>
              </>
            )}
          </span>
        )}
      </button>
      <div id={id} className="activity-fold__content" hidden={!open}>
        {open && (
          <>
            {last > 0 && (
              <div
                className="activity-fold__pages"
                role="group"
                aria-label="Activity pages"
                onFocus={() => setFocus(true)}
              >
                <button
                  type="button"
                  className="button button--quiet disclosure-row"
                  disabled={page === 0}
                  onClick={() => showPage(page - 1)}
                >
                  Earlier activity
                </button>
                <span>
                  {page + 1} / {last + 1}
                </span>
                <button
                  type="button"
                  className="button button--quiet disclosure-row"
                  disabled={page === last}
                  onClick={() => showPage(page + 1)}
                >
                  Later activity
                </button>
              </div>
            )}
            <ReadingChoices value={choices}>
              {items.slice(start, start + ACTIVITY_PAGE_SIZE).map((item) => (
                <ActivityItemOwner
                  key={item.key}
                  toolCallId={item.toolCallId}
                  onFocus={() => setFocus(item.key)}
                >
                  {item.node}
                </ActivityItemOwner>
              ))}
            </ReadingChoices>
          </>
        )}
      </div>
    </section>
  );
}
