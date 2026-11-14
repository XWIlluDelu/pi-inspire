import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CodeView } from "./CodeView";
import { CopyAction } from "./CopyAction";
import { DetailSummary } from "./DetailSummary";

export function ActivityHeader({
  icon,
  children,
  copy,
  className = "",
}: {
  icon?: ReactNode;
  children: ReactNode;
  copy?: Omit<ComponentProps<typeof CopyAction>, "className"> & {
    className?: string;
  };
  className?: string;
}) {
  return (
    <div className={`activity-surface__head ${className}`}>
      {icon}
      {children}
      {copy && (
        <CopyAction
          {...copy}
          className={`activity-copy ${copy.className ?? ""}`}
        />
      )}
    </div>
  );
}

interface ReaderScrollPosition {
  top: number;
  left: number;
  following: boolean;
}
type ReaderValue = boolean | ReaderScrollPosition;

/** Only deliberate choices outlive an omitted card. The projection owns this
 * map; defaults and transient renderer state never become saved preferences. */
export type ActivityReadingChoices = Map<string, Map<string, ReaderValue>>;
export const ReadingChoices = createContext<ActivityReadingChoices | null>(
  null,
);
const ActivityItemId = createContext<string | null>(null);
const ReadingBlock = createContext("");

/** Presentation blocks already have stable keys within their activity. */
export function ActivityReadingBlock({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const parent = useContext(ReadingBlock);
  return (
    <ReadingBlock.Provider value={`${parent}/${name}`}>
      {children}
    </ReadingBlock.Provider>
  );
}

function useActivityReaderMemory<T extends ReaderValue>(name: string) {
  const choices = useContext(ReadingChoices);
  const id = useContext(ActivityItemId);
  const block = useContext(ReadingBlock);
  const key = `${block}/${name}`;
  const read = useCallback(
    () => (id ? (choices?.get(id)?.get(key) as T | undefined) : undefined),
    [choices, id, key],
  );
  const write = useCallback(
    (value: T) => {
      if (!choices || !id) return;
      const choice = choices.get(id) ?? new Map();
      choice.set(key, value);
      choices.set(id, choice);
    },
    [choices, id, key],
  );
  return [read, write] as const;
}

/** Only an explicit reader action records a choice; mounting does not freeze a default. */
export function useActivityReaderExpanded(
  name: string,
): readonly [boolean, (expanded: boolean) => void];
export function useActivityReaderExpanded(
  name: string,
  empty: null,
): readonly [boolean | null, (expanded: boolean) => void];
export function useActivityReaderExpanded(
  name: string,
  empty: false | null = false,
) {
  const [read, write] = useActivityReaderMemory<boolean>(name);
  const [expanded, setExpanded] = useState(() => read() ?? empty);
  const choose = useCallback(
    (next: boolean) => {
      write(next);
      setExpanded(next);
    },
    [write],
  );
  return [expanded, choose] as const;
}

/** Mount and prepare the body only while the native disclosure is open. */
export function ActivityDetails({
  reader,
  label,
  className,
  summaryClassName,
  inline = false,
  children,
}: {
  reader: string;
  label: ReactNode;
  className?: string;
  summaryClassName?: string;
  inline?: boolean;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useActivityReaderExpanded(reader);
  if (inline) return children();
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <DetailSummary className={summaryClassName}>{label}</DetailSummary>
      {open && children()}
    </details>
  );
}

export function useActivityReaderScroll<T extends HTMLElement>(
  name: string,
  content: unknown,
  followUpdates = false,
) {
  const [read, write] = useActivityReaderMemory<ReaderScrollPosition>(name);
  const ref = useRef<T>(null);
  const following = useRef(read()?.following ?? true);
  useLayoutEffect(() => {
    const saved = read();
    if (saved && ref.current) {
      ref.current.scrollTop = saved.top;
      ref.current.scrollLeft = saved.left;
      following.current = saved.following;
    }
  }, [read]);
  useLayoutEffect(() => {
    if (followUpdates && following.current && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [content, followUpdates]);
  return {
    stopFollowing() {
      following.current = false;
      if (ref.current)
        write({
          top: ref.current.scrollTop,
          left: ref.current.scrollLeft,
          following: false,
        });
    },
    props: {
      ref,
      onScroll(event: React.UIEvent<T>) {
        const { scrollTop, scrollLeft, scrollHeight, clientHeight } =
          event.currentTarget;
        following.current = scrollHeight - scrollTop - clientHeight < 24;
        write({
          top: scrollTop,
          left: scrollLeft,
          following: following.current,
        });
      },
    },
  };
}

export function ActivityCode({
  reader,
  label,
  following,
  scrollable = true,
  className = "",
  ...props
}: ComponentProps<typeof CodeView> & {
  reader: string;
  label: string;
  following?: boolean;
  scrollable?: boolean;
}) {
  const scroll = useActivityReaderScroll<HTMLPreElement>(
    reader,
    props.text ?? props.children,
    following,
  );
  return (
    <CodeView
      {...props}
      {...scroll.props}
      className={`activity-reader ${className}`}
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? "group" : undefined}
      aria-label={scrollable ? label : undefined}
    />
  );
}

export function ActivityReader({
  reader,
  label,
  className = "",
  ...props
}: ComponentProps<"div"> & { reader: string; label: string }) {
  const scroll = useActivityReaderScroll<HTMLDivElement>(
    reader,
    props.children,
  );
  return (
    <div
      {...props}
      {...scroll.props}
      className={`activity-reader ${className}`}
      tabIndex={0}
      role="group"
      aria-label={label}
    />
  );
}

export function ActivityText({
  text,
  label,
  error,
  following = false,
  live = false,
  preview,
  scrollable = true,
  className = "",
}: {
  text: string;
  label: string;
  error?: boolean;
  following?: boolean;
  live?: boolean;
  preview?: number;
  scrollable?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useActivityReaderExpanded(`${label}-all`);
  const truncated = preview !== undefined && text.length > preview;
  return (
    <>
      <ActivityCode
        reader={`${label}-scroll`}
        label={label}
        scrollable={scrollable}
        following={live || following}
        className={live ? `tool-terminal--live ${className}` : className}
        data-error={error || undefined}
        text={!expanded && truncated ? `${text.slice(0, preview)}…` : text}
      />
      {truncated && (
        <button
          type="button"
          className="card__show-all"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

/** Only a real Pi tool call carries its explicit choices across pages and checkpoints. */
export function ActivityItemOwner({
  toolCallId,
  onFocus,
  children,
}: {
  toolCallId?: string;
  onFocus: () => void;
  children: ReactNode;
}) {
  return (
    <ActivityItemId value={toolCallId ?? null}>
      <div className="activity-item-boundary" onFocus={onFocus}>
        {children}
      </div>
    </ActivityItemId>
  );
}
