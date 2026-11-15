import { ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ActivityFoldVisibilityPreference } from "../../shared/contracts";
import {
  ActivityItemOwner,
  type ActivityReadingChoices,
  ReadingChoices,
} from "./transcript-activity-visibility";

import { toolIcon } from "./transcript-cards";
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
  expandedNode?: ReactNode;
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

function ToolStrip({ items }: { items: readonly ActivityItem[] }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const panel = useId();
  const selected = items.find((item) => item.key === selectedKey);
  return (
    <div className="activity-strip">
      <div
        className="activity-strip__items"
        role="group"
        aria-label="Tool calls"
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="activity-strip__item"
            aria-label={`${item.name} tool details${item.failed ? ", failed" : ""}`}
            title={item.name}
            aria-expanded={selectedKey === item.key}
            aria-controls={selectedKey === item.key ? panel : undefined}
            data-failed={item.failed || undefined}
            onClick={() =>
              setSelectedKey(selectedKey === item.key ? null : item.key)
            }
          >
            {toolIcon(item.name ?? "")}
          </button>
        ))}
      </div>
      {selected && (
        <div id={panel} className="activity-strip__detail" key={selected.key}>
          <ActivityItemOwner toolCallId={selected.toolCallId}>
            {selected.expandedNode}
          </ActivityItemOwner>
        </div>
      )}
    </div>
  );
}

function ActivityItems({
  items,
  collapseTools,
}: {
  items: readonly ActivityItem[];
  collapseTools: boolean;
}) {
  const children: ReactNode[] = [];
  for (let start = 0; start < items.length; ) {
    const item = items[start]!;
    let end = start + 1;
    if (collapseTools && item.expandedNode && !item.live)
      while (items[end]?.expandedNode && !items[end]?.live) end++;
    children.push(
      end - start > 1 ? (
        <ToolStrip key={item.key} items={items.slice(start, end)} />
      ) : (
        <ActivityItemOwner key={item.key} toolCallId={item.toolCallId}>
          {item.node}
        </ActivityItemOwner>
      ),
    );
    start = end;
  }
  return children;
}

export function ResponseActivityFold({
  visibility,
  live,
  choices,
  items,
  collapseTools,
}: {
  visibility: ActivityFoldVisibilityPreference;
  live: boolean;
  choices: ActivityReadingChoices;
  collapseTools: boolean;
  items: readonly ActivityItem[];
}) {
  const id = useId();
  const [choice, setChoice] = useState<
    "collapsed" | "compact" | "expanded" | null
  >(null);
  const [inspecting, setInspecting] = useState(false);
  const header = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLElement>(null);
  const footer = useRef<HTMLButtonElement>(null);
  const anchor = useRef<{ edge: "top" | "bottom"; position: number }>(null);
  const dynamicOpen = useActivityCloseDelay(
    visibility === "dynamic" && live,
    2400,
    800,
  );
  const density =
    choice ??
    (visibility === "dynamic"
      ? dynamicOpen || inspecting
        ? "compact"
        : "collapsed"
      : visibility);
  const open = density !== "collapsed";
  const start =
    density === "compact" ? Math.max(0, items.length - ACTIVITY_PAGE_SIZE) : 0;
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

  useLayoutEffect(() => {
    const previous = anchor.current;
    anchor.current = null;
    const section = group.current;
    const scroll = section?.closest<HTMLElement>(".transcript");
    if (!previous || !section || !scroll) return;
    scroll.scrollTop +=
      section.getBoundingClientRect()[previous.edge] - previous.position;
    (previous.edge === "bottom" && open ? footer : header).current?.focus({
      preventScroll: true,
    });
  }, [density, open]);

  function choose(
    next: "collapsed" | "compact" | "expanded",
    edge: "top" | "bottom" = "top",
  ) {
    if (group.current)
      anchor.current = {
        edge,
        position: group.current.getBoundingClientRect()[edge],
      };
    setChoice(next);
  }

  const collapseTo =
    density === "expanded" && items.length > ACTIVITY_PAGE_SIZE
      ? "compact"
      : "collapsed";
  const collapseLabel =
    collapseTo === "compact" ? "Compact activity" : "Collapse activity";

  return (
    <section
      ref={group}
      className="activity-fold"
      data-dynamic={visibility === "dynamic" || undefined}
      aria-label="Assistant activity"
      onFocus={() => {
        if (open) setInspecting(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setInspecting(false);
      }}
    >
      <button
        type="button"
        ref={header}
        className="disclosure-row activity-fold__disclosure"
        aria-controls={id}
        aria-expanded={open}
        aria-description={matrixDescription}
        aria-label={
          open
            ? collapseTo === "compact"
              ? "Compact assistant activity"
              : "Collapse assistant activity"
            : "Expand assistant activity"
        }
        onClick={() => choose(open ? collapseTo : "compact")}
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
            {start > 0 && (
              <button
                type="button"
                className="button button--quiet disclosure-row"
                onClick={() => choose("expanded")}
              >
                <ChevronRight size={14} aria-hidden /> Earlier activity
              </button>
            )}
            <ReadingChoices value={choices}>
              <ActivityItems
                items={items.slice(start)}
                collapseTools={collapseTools}
              />
            </ReadingChoices>
            {items.length > 1 && (
              <button
                type="button"
                className="button button--quiet disclosure-row"
                ref={footer}
                onClick={() => choose(collapseTo, "bottom")}
              >
                <ChevronRight
                  size={14}
                  className="chev chev--open"
                  aria-hidden
                />{" "}
                {collapseLabel}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
