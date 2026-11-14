import { type ReactNode, useRef } from "react";
import { ChoicePanel } from "./ChoicePanel";

export function currentContentsIndex<T>(
  entries: readonly T[],
  isCurrent: (entry: T) => boolean,
) {
  for (let index = entries.length - 1; index >= 0; index--)
    if (isCurrent(entries[index]!)) return index;
  return -1;
}

export function ReaderContents<
  Entry extends { title: string; depth: number; page?: number },
>({
  label,
  trigger,
  triggerLabel,
  triggerClassName,
  open,
  setOpen,
  entries,
  current,
  onPick,
}: {
  label: string;
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  open: boolean;
  setOpen(open: boolean): void;
  entries: readonly Entry[];
  current: number;
  onPick(entry: Entry): void;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <ChoicePanel
      label={label}
      trigger={trigger}
      triggerLabel={triggerLabel}
      triggerClassName={triggerClassName}
      triggerRef={opener}
      open={open}
      setOpen={setOpen}
    >
      {open &&
        entries.map((entry, index) => (
          <button
            key={index}
            type="button"
            className="picker__row reader-contents__entry"
            style={{ paddingInlineStart: `${12 + entry.depth * 14}px` }}
            aria-current={index === current ? "location" : undefined}
            onClick={() => {
              onPick(entry);
              setOpen(false);
              opener.current?.focus({ preventScroll: true });
            }}
          >
            <span>{entry.title}</span>
            {entry.page !== undefined && <small>{entry.page}</small>}
          </button>
        ))}
    </ChoicePanel>
  );
}
