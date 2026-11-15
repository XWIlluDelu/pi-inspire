import {
  defaultRangeExtractor,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import {
  type CSSProperties,
  Fragment,
  type Key,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isComposingKeyboardEvent } from "../keyboard-input";

export interface ListOption<T> {
  key: string;
  value: T;
  disabled?: boolean;
  selected?: boolean;
  title?: string;
  label?: string;
  group?: string;
}

type Navigation = {
  wrap?: boolean;
  edges?: boolean;
  tab?: boolean;
  consumeEmptyEnter?: boolean;
  excludeAltUp?: boolean;
};

export function useOptionList<T>(initialKey?: string, keyboard = true) {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState({ key: initialKey, index: 0, keyboard });

  const reset = useCallback((keyboard?: boolean) => {
    setChoice((previous) => ({
      key: undefined,
      index: 0,
      keyboard: keyboard ?? previous.keyboard,
    }));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, []);
  const pointer = (index?: number, key?: string) => {
    setChoice((previous) =>
      !previous.keyboard && (index === undefined || key === previous.key)
        ? previous
        : {
            key: key ?? previous.key,
            index: index ?? previous.index,
            keyboard: false,
          },
    );
  };
  function indexOf(options: readonly ListOption<T>[]) {
    const byKey = options.findIndex(
      (option) => !option.disabled && option.key === choice.key,
    );
    if (byKey >= 0) return byKey;
    const from = Math.min(choice.index, options.length - 1);
    for (let index = Math.max(0, from); index < options.length; index++)
      if (!options[index]!.disabled) return index;
    for (let index = from - 1; index >= 0; index--)
      if (!options[index]!.disabled) return index;
    return -1;
  }
  const optionId = (index: number) => `${id}-option-${index}`;
  const descendant = (options: readonly ListOption<T>[]) => {
    const index = indexOf(options);
    return choice.keyboard && index >= 0 ? optionId(index) : undefined;
  };
  function navigate(
    event: KeyboardEvent,
    options: readonly ListOption<T>[],
    pick: ((value: T) => void) | undefined,
    { wrap, edges, tab, consumeEmptyEnter, excludeAltUp }: Navigation = {},
  ) {
    if (event.defaultPrevented || isComposingKeyboardEvent(event.nativeEvent))
      return false;
    const index = indexOf(options);
    const selects =
      (event.key === "Enter" || (tab && event.key === "Tab")) &&
      (!tab || !event.shiftKey) &&
      index >= 0 &&
      pick;
    if (selects || (consumeEmptyEnter && event.key === "Enter")) {
      event.preventDefault();
      if (index >= 0) pick?.(options[index]!.value);
      return true;
    }
    if (index < 0) return false;
    const step =
      event.key === "ArrowDown" || (edges && event.key === "Home")
        ? 1
        : (event.key === "ArrowUp" && !(excludeAltUp && event.altKey)) ||
            (edges && event.key === "End")
          ? -1
          : 0;
    if (!step) return false;
    event.preventDefault();
    const disabledChoice =
      wrap && choice.key !== undefined && options[choice.index]?.disabled;
    const start =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (disabledChoice ? choice.index : index) + step;
    for (let count = 0; count < options.length; count++) {
      const offset = start + count * step;
      if (!wrap && (offset < 0 || offset >= options.length)) break;
      const next = (offset + options.length) % options.length;
      const option = options[next]!;
      if (!option.disabled) {
        setChoice({ key: option.key, index: next, keyboard: true });
        return true;
      }
    }
    setChoice({ key: options[index]!.key, index, keyboard: true });
    return true;
  }
  return {
    id,
    scrollRef,
    keyboard: choice.keyboard,
    optionId,
    indexOf,
    descendant,
    navigate,
    pointer,
    reset,
    activate: (key: string | undefined) =>
      setChoice({ key, index: 0, keyboard: true }),
  };
}

export function OptionList<T>({
  list,
  options,
  renderOption,
  onPick,
  heading,
  optionClass,
  className,
  label,
  loading,
  onKeyDown,
  fixedRows,
  plain = false,
  children,
  optionButtons,
  focusOptions = false,
  highlightAsSelection,
}: {
  list: ReturnType<typeof useOptionList<T>>;
  options: readonly ListOption<T>[];
  renderOption: (option: ListOption<T>) => ReactNode;
  onPick?: (value: T) => void;
  heading?: (
    option: ListOption<T>,
    style?: CSSProperties,
    key?: Key,
  ) => ReactNode;
  optionClass?: string;
  className?: string;
  label: string;
  loading?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  fixedRows?: boolean;
  plain?: boolean;
  children?: ReactNode;
  optionButtons?: boolean;
  focusOptions?: boolean;
  highlightAsSelection?: boolean;
}) {
  const active = list.indexOf(options);
  const descendant = list.descendant(options);
  const rows = useMemo(() => {
    const offsets: number[] = [];
    const items: { key: string; index: number; heading?: boolean }[] = [];
    for (const [index, option] of options.entries()) {
      if (heading && option.group && option.group !== options[index - 1]?.group)
        items.push({ key: `heading:${option.key}`, index, heading: true });
      offsets.push(items.length);
      items.push({ key: option.key, index });
    }
    return { items, offsets };
  }, [options, heading]);
  const activeRow = rows.offsets[active];
  const virtual = !plain && Boolean(fixedRows || options.length > 50);
  const getScrollElement = useCallback(
    () => list.scrollRef.current,
    [list.scrollRef],
  );
  const getItemKey = useCallback(
    (index: number) => rows.items[index]!.key,
    [rows],
  );
  const estimateSize = useCallback(
    (index: number) => (rows.items[index]?.heading ? 28 : 48),
    [rows],
  );
  const virtualizer = useVirtualizer({
    enabled: virtual,
    count: rows.items.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 4,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeRow !== undefined && !indexes.includes(activeRow))
        indexes.push(activeRow);
      return indexes.sort((a, b) => a - b);
    },
  });
  useLayoutEffect(() => {
    if (!descendant || activeRow === undefined) return;
    if (virtual) virtualizer.scrollToIndex(activeRow, { align: "auto" });
    else
      list.scrollRef.current
        ?.querySelector(`[id="${descendant}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow, descendant, list.scrollRef, rows, virtual, virtualizer]);
  const Option = optionButtons ? "button" : "div";
  const render = (row: (typeof rows.items)[number], style?: CSSProperties) => {
    const option = options[row.index]!;
    if (row.heading) return heading?.(option, style, row.key);
    const highlighted = list.keyboard && active === row.index;
    return (
      <Option
        key={row.key}
        type={optionButtons ? "button" : undefined}
        disabled={optionButtons ? option.disabled : undefined}
        tabIndex={
          optionButtons
            ? focusOptions && active === row.index
              ? 0
              : -1
            : undefined
        }
        id={list.optionId(row.index)}
        role="option"
        aria-label={option.label}
        aria-selected={
          highlightAsSelection ? highlighted : Boolean(option.selected)
        }
        aria-posinset={row.index + 1}
        aria-setsize={options.length}
        className={`picker__row ${optionClass ?? ""}`}
        data-highlighted={highlighted || (optionButtons && option.selected)}
        title={option.title}
        style={style}
        onMouseDown={(event) => event.preventDefault()}
        onPointerMove={(event) => {
          if (event.pointerType !== "touch" && !option.disabled)
            list.pointer(row.index, option.key);
        }}
        onFocus={focusOptions ? () => list.activate(option.key) : undefined}
        onClick={() => onPick?.(option.value)}
      >
        {renderOption(option)}
      </Option>
    );
  };
  const virtualGroups = new Map<string, VirtualItem[]>();
  if (fixedRows)
    for (const item of virtualizer.getVirtualItems()) {
      const group = options[rows.items[item.index]!.index]?.group ?? "";
      let members = virtualGroups.get(group);
      if (!members) virtualGroups.set(group, (members = []));
      members.push(item);
    }
  const renderVirtual = ({ index, key, start, size }: VirtualItem) => {
    const row = rows.items[index]!;
    const style = { position: "absolute" as const, top: start, width: "100%" };
    return fixedRows ? (
      render(row, { ...style, height: size })
    ) : (
      <div
        key={key}
        data-index={index}
        ref={virtualizer.measureElement}
        style={style}
      >
        {render(row)}
      </div>
    );
  };
  return (
    <div
      ref={list.scrollRef}
      id={list.id}
      data-keyboard-active={list.keyboard}
      tabIndex={onKeyDown ? -1 : undefined}
      onKeyDown={onKeyDown}
      role="listbox"
      aria-label={label}
      aria-busy={loading}
      aria-activedescendant={onKeyDown ? descendant : undefined}
      className={className ? `option-list ${className}` : "option-list"}
    >
      {virtual ? (
        <div
          className="picker__plane"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {fixedRows
            ? [...virtualGroups].map(([group, members]) => (
                <div key={group} role="group" aria-label={group}>
                  {members.map(renderVirtual)}
                </div>
              ))
            : virtualizer.getVirtualItems().map(renderVirtual)}
        </div>
      ) : (
        rows.items.map((row) => (
          <Fragment key={row.key}>{render(row)}</Fragment>
        ))
      )}
      {children}
    </div>
  );
}
