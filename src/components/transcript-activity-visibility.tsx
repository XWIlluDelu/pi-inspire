import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface ReaderScrollPosition {
  top: number;
  left: number;
  following: boolean;
}
type ReaderValue = boolean | ReaderScrollPosition;

type ActivityReadingChoice = {
  disclosure?: "open" | "closed";
  readers?: Map<string, ReaderValue>;
};

/** Only deliberate choices outlive an omitted card. The projection owns this
 * map; defaults and transient renderer state never become saved preferences. */
export type ActivityReadingChoices = Map<string, ActivityReadingChoice>;
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
