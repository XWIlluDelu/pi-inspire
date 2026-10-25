import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const VisibleActivityItems = createContext<ReadonlySet<string> | null>(null);

interface ReaderScrollPosition {
  top: number;
  left: number;
  following: boolean;
}
type ReaderValue = boolean | ReaderScrollPosition;

type ActivityReadingChoice = {
  disclosure?: "open" | "closed";
  stripSelection?: string | null;
  readers?: Map<string, ReaderValue>;
};

/** Only deliberate choices outlive an omitted card. The projection owns this
 * map; defaults and transient renderer state never become saved preferences. */
export type ActivityReadingChoices = Map<string, ActivityReadingChoice>;
const ReadingChoices = createContext<ActivityReadingChoices | null>(null);
const ActivityItemId = createContext<string | null>(null);
const ReadingBlock = createContext("");

export function ActivityReadingOwner({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <ActivityItemId.Provider value={id}>{children}</ActivityItemId.Provider>
  );
}

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
    () =>
      id ? (choices?.get(id)?.readers?.get(key) as T | undefined) : undefined,
    [choices, id, key],
  );
  const write = useCallback(
    (value: T) => {
      if (!choices || !id) return;
      const choice = choices.get(id) ?? {};
      choice.readers ??= new Map();
      choice.readers.set(key, value);
      choices.set(id, choice);
    },
    [choices, id, key],
  );
  return [read, write] as const;
}

/** Only an explicit reader action records a choice; mounting does not freeze a default. */
export function useActivityReaderExpanded(name: string) {
  const [read, write] = useActivityReaderMemory<boolean>(name);
  const [expanded, setExpanded] = useState(() => read() ?? false);
  const current = useRef(expanded);
  current.current = expanded;
  return [
    expanded,
    (next: boolean | ((previous: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(current.current) : next;
      current.current = value;
      write(value);
      setExpanded(value);
    },
  ] as const;
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

export function ActivityItemVisibilityProvider({
  visibleIds,
  readingChoices,
  children,
}: {
  visibleIds: ReadonlySet<string> | null;
  readingChoices?: ActivityReadingChoices;
  children: ReactNode;
}) {
  return (
    <ReadingChoices.Provider value={readingChoices ?? null}>
      <VisibleActivityItems.Provider value={visibleIds}>
        {children}
      </VisibleActivityItems.Provider>
    </ReadingChoices.Provider>
  );
}

export function useVisibleActivityItemIds(): ReadonlySet<string> | null {
  return useContext(VisibleActivityItems);
}

export function useActivityInspectionHeld(ids: readonly string[]): boolean {
  const choices = useContext(ReadingChoices);
  return ids.some((id) => choices?.get(id)?.disclosure === "open");
}

export function useActivityDisclosure() {
  const choices = useContext(ReadingChoices);
  const id = useContext(ActivityItemId);
  const [override, setOverride] = useState<"open" | "closed" | null>(
    () => (id ? choices?.get(id)?.disclosure : null) ?? null,
  );
  return [
    override,
    (next: "open" | "closed") => {
      if (id && choices)
        choices.set(id, { ...choices.get(id), disclosure: next });
      setOverride(next);
    },
  ] as const;
}

export function useActivityStripSelection(id: string) {
  const choices = useContext(ReadingChoices);
  const [selected, setSelected] = useState<string | null>(
    () => choices?.get(id)?.stripSelection ?? null,
  );
  return [
    selected,
    (next: string | null) => {
      choices?.set(id, { ...choices.get(id), stripSelection: next });
      setSelected(next);
    },
  ] as const;
}

function isVisible(
  visibleIds: ReadonlySet<string> | null,
  ids: readonly string[],
): boolean {
  return (
    visibleIds === null ||
    ids.length === 0 ||
    ids.some((id) => visibleIds.has(id))
  );
}

/** A rolling compact tail can retire a focused card, strip button or detail.
 * Ref cleanup observes focus before its DOM disappears; a later user choice
 * still wins over the deferred recovery. */
export function recoverOmittedActivityFocus(element: HTMLElement | null) {
  if (!element) return;
  return () => {
    const focused = document.activeElement;
    if (!element.contains(focused)) return;
    const fold = element.closest<HTMLElement>("[data-activity-fold]");
    queueMicrotask(() => {
      if (
        focused?.isConnected ||
        (document.activeElement !== document.body &&
          document.activeElement !== focused)
      )
        return;
      const control =
        fold?.querySelector<HTMLElement>(".activity-fold__omission") ??
        fold?.querySelector<HTMLElement>(
          '[data-activity-fold-anchor="start"], [data-activity-fold-anchor="center"]',
        );
      control?.focus({ preventScroll: true });
    });
  };
}

/** Omitted fragments do not mount their renderers or layout wrappers. */
export function ActivitySegmentBoundary({
  ids,
  children,
}: {
  ids: readonly string[];
  children: ReactNode;
}) {
  const visibleIds = useVisibleActivityItemIds();
  return isVisible(visibleIds, ids) ? (
    <div ref={recoverOmittedActivityFocus} className="activity-item-boundary">
      {children}
    </div>
  ) : null;
}

/** A visible card borrows its small reading choice from the projection, so
 * Compact can unmount the hidden prefix without forgetting manual disclosure. */
export function ActivityItemBoundary({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const visibleIds = useVisibleActivityItemIds();
  if (visibleIds !== null && !visibleIds.has(id)) return null;
  return (
    <ActivityItemId.Provider value={id}>
      <div ref={recoverOmittedActivityFocus} className="activity-item-boundary">
        {children}
      </div>
    </ActivityItemId.Provider>
  );
}
