import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Check, Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ModelIdentity,
  type ModelOption,
  modelIdentityKey,
} from "../../shared/contracts";

const EMPTY_IDENTITIES: readonly ModelIdentity[] = [];
function fuzzyCategory(value: string, queryValue: string): number | null {
  const query = queryValue.trim().toLocaleLowerCase();
  if (!query) return 0;
  const text = value.toLocaleLowerCase();
  const direct = text.indexOf(query);
  if (direct >= 0) return direct === 0 ? 0 : 1;
  let cursor = 0;
  for (const character of query) {
    const found = text.indexOf(character, cursor);
    if (found < 0) return null;
    cursor = found + 1;
  }
  return 2;
}
function modelSearchText(model: ModelOption): string {
  return `${model.provider} ${model.id} ${model.name ?? ""} ${model.provider}/${model.id}`;
}
interface ModelGroup {
  provider: string;
  models: ModelOption[];
  common?: boolean;
}
function prepareModelOptions(models: readonly ModelOption[]): ModelOption[] {
  return models
    .map((model, order) => ({ model, order }))
    .sort((left, right) =>
      left.model.provider < right.model.provider
        ? -1
        : left.model.provider > right.model.provider
          ? 1
          : left.model.id < right.model.id
            ? -1
            : left.model.id > right.model.id
              ? 1
              : left.order - right.order,
    )
    .map(({ model }) => model);
}
function groupPreparedModels(
  models: readonly ModelOption[],
  recent: readonly ModelIdentity[],
  query: string,
  common: readonly ModelIdentity[],
): ModelGroup[] {
  const recentRank = new Map(
    recent.map((model, index) => [modelIdentityKey(model), index]),
  );
  type Bucket = {
    recent: Array<ModelOption | undefined>;
    ordinary: ModelOption[];
  };
  const groups = new Map<string, Bucket[]>();
  const byKey = new Map(
    models.map((model) => [modelIdentityKey(model), model]),
  );
  const commonOptions = common.flatMap((identity) => {
    const model = byKey.get(modelIdentityKey(identity));
    return model && fuzzyCategory(modelSearchText(model), query) !== null
      ? [model]
      : [];
  });
  const commonKeys = new Set(commonOptions.map(modelIdentityKey));
  for (const model of models) {
    if (commonKeys.has(modelIdentityKey(model))) continue;
    const category = fuzzyCategory(modelSearchText(model), query);
    if (category === null) continue;
    let buckets = groups.get(model.provider);
    if (!buckets) {
      buckets = Array.from({ length: 3 }, () => ({ recent: [], ordinary: [] }));
      groups.set(model.provider, buckets);
    }
    const bucket = buckets[category]!;
    const rank = recentRank.get(modelIdentityKey(model));
    if (rank === undefined) bucket.ordinary.push(model);
    else bucket.recent[rank] = model;
  }
  return [
    ...(commonOptions.length
      ? [{ provider: "Common models", models: commonOptions, common: true }]
      : []),
    ...[...groups].map(([provider, buckets]) => ({
      provider,
      models: buckets.flatMap((bucket) => [
        ...bucket.recent.filter((model): model is ModelOption =>
          Boolean(model),
        ),
        ...bucket.ordinary,
      ]),
    })),
  ];
}

export interface ModelListHandle {
  focusModel: (
    model: ModelIdentity,
    canFocus: () => boolean,
    complete: () => void,
  ) => void;
}

/** Shared bounded model search. Settings uses a grid because its rows contain actions. */
export function ModelList({
  models,
  value,
  recent = EMPTY_IDENTITIES,
  common = EMPTY_IDENTITIES,
  initialQuery = "",
  status,
  onSelect,
  onKeyDown,
  renderActions,
  renderNameAction,
  autoFocus = false,
  controllerRef,
  searchAction,
  placeholder,
  emptyAction,
  optionSize,
}: {
  models: ModelOption[];
  value: ModelOption | null;
  recent?: readonly ModelIdentity[];
  common?: readonly ModelIdentity[];
  initialQuery?: string;
  status?: string | null;
  onSelect?: (model: ModelOption) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  renderActions?: (model: ModelOption, active: boolean) => ReactNode;
  renderNameAction?: (model: ModelOption, active: boolean) => ReactNode;
  autoFocus?: boolean;
  controllerRef?: Ref<ModelListHandle>;
  searchAction?: ReactNode;
  placeholder?: string;
  emptyAction?: ReactNode;
  optionSize?: number;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [keyboardActive, setKeyboardActive] = useState(!renderActions);
  const currentKey = value ? modelIdentityKey(value) : "";
  const [activeModelKey, setActiveModelKey] = useState<string | null>(
    initialQuery ? null : currentKey,
  );
  const fallbackActiveIndex = useRef(0);
  const recentKeys = useMemo(
    () => new Set(recent.map(modelIdentityKey)),
    [recent],
  );
  const prepared = useMemo(() => prepareModelOptions(models), [models]);
  const pendingFocus = useRef<{
    key: string;
    action?: string;
    select?: boolean;
    canFocus: () => boolean;
    complete: () => void;
  } | null>(null);
  useImperativeHandle(
    controllerRef,
    () => ({
      focusModel(model, canFocus, complete) {
        pendingFocus.current?.complete();
        const key = modelIdentityKey(model);
        if (!prepared.some((option) => modelIdentityKey(option) === key)) {
          complete();
          return;
        }
        pendingFocus.current = { key, canFocus, complete };
        setQuery("");
        setActiveModelKey(key);
      },
    }),
    [prepared],
  );
  useEffect(() => () => pendingFocus.current?.complete(), []);
  const groups = useMemo(
    () => groupPreparedModels(prepared, recent, query, common),
    [prepared, recent, query, common],
  );
  const { options, indexes, rows, optionRows } = useMemo(() => {
    const options: ModelOption[] = [],
      optionRows: number[] = [];
    const rows: Array<
      | { kind: "heading"; group: ModelGroup; key: string }
      | {
          kind: "model";
          group: ModelGroup;
          model: ModelOption;
          index: number;
          key: string;
        }
    > = [];
    for (const group of groups) {
      rows.push({
        kind: "heading",
        group,
        key: group.common ? "common" : `provider/${group.provider}`,
      });
      for (const model of group.models) {
        optionRows.push(rows.length);
        rows.push({
          kind: "model",
          group,
          model,
          index: options.length,
          key: modelIdentityKey(model),
        });
        options.push(model);
      }
    }
    return {
      options,
      indexes: new Map(
        options.map((model, index) => [modelIdentityKey(model), index]),
      ),
      rows,
      optionRows,
    };
  }, [groups]);
  const active =
    indexes.get(activeModelKey ?? "") ??
    Math.min(fallbackActiveIndex.current, Math.max(0, options.length - 1));
  const activeRow = optionRows[active];
  const activate = (index: number) => {
    const next = Math.max(0, Math.min(index, options.length - 1));
    fallbackActiveIndex.current = next;
    setActiveModelKey(options[next] ? modelIdentityKey(options[next]) : null);
  };
  const grid = Boolean(renderActions);
  const getScrollElement = useCallback(() => listRef.current, []);
  const estimateSize = useCallback(
    (index: number) =>
      rows[index]?.kind === "heading" ? 28 : (optionSize ?? 48),
    [rows, optionSize],
  );
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 4,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      // Keep the active descendant mounted before scrolling a distant row.
      if (activeRow !== undefined && !indexes.includes(activeRow))
        indexes.push(activeRow);
      return indexes.sort((left, right) => left - right);
    },
  });
  useEffect(() => {
    virtualizer.measure();
  }, [optionSize, virtualizer]);
  const visibleGroups = new Map<
    ModelGroup,
    ReturnType<typeof virtualizer.getVirtualItems>
  >();
  for (const item of virtualizer.getVirtualItems()) {
    const group = rows[item.index]!.group;
    const items = visibleGroups.get(group) ?? [];
    items.push(item);
    visibleGroups.set(group, items);
  }
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  useEffect(() => {
    fallbackActiveIndex.current = active;
    const key = options[active] ? modelIdentityKey(options[active]) : null;
    if (activeModelKey !== key) setActiveModelKey(key);
  }, [options, active, activeModelKey]);
  useLayoutEffect(() => {
    if (activeRow !== undefined && (keyboardActive || pendingFocus.current))
      virtualizer.scrollToIndex(activeRow, { align: "auto" });
  }, [activeRow, keyboardActive, rows, virtualizer]);
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request) return;
    if (
      !request.canFocus() ||
      !prepared.some((option) => modelIdentityKey(option) === request.key)
    ) {
      pendingFocus.current = null;
      request.complete();
      return;
    }
    const index = indexes.get(request.key);
    if (index === undefined || activeModelKey !== request.key) return;
    const target = document
      .getElementById(`${id}-option-${index}`)
      ?.querySelector<HTMLElement>(
        request.action
          ? `[data-model-action="${request.action}"]:not(:disabled)`
          : ".models-row-actions [data-model-action]:not(:disabled)",
      );
    pendingFocus.current = null;
    request.complete();
    target?.focus();
    if (request.select) target?.click();
  });
  const navigate = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (
      options.length &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const start = grid && !keyboardActive;
      setKeyboardActive(true);
      activate(
        event.key === "ArrowDown"
          ? start
            ? 0
            : active + 1
          : event.key === "ArrowUp"
            ? start
              ? options.length - 1
              : active - 1
            : event.key === "Home"
              ? 0
              : options.length - 1,
      );
    } else if (event.key === "Enter" && onSelect && options[active]) {
      event.preventDefault();
      onSelect(options[active]!);
    } else onKeyDown?.(event);
  };
  const navigateAction = (event: KeyboardEvent, index: number) => {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      !(target instanceof HTMLElement) ||
      !target.dataset.modelAction ||
      target.matches(":disabled")
    )
      return;
    const radio = target instanceof HTMLInputElement && target.type === "radio";
    const previous =
      event.key === "ArrowUp" || (radio && event.key === "ArrowLeft");
    const next =
      event.key === "ArrowDown" || (radio && event.key === "ArrowRight");
    if (!previous && !next && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const destination =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : radio
            ? (index + (previous ? -1 : 1) + options.length) % options.length
            : Math.max(
                0,
                Math.min(index + (previous ? -1 : 1), options.length - 1),
              );
    const model = options[destination];
    if (!model) return;
    if (destination === index) {
      if (radio) target.click();
      return;
    }
    // Native radio navigation only sees mounted rows. Route through the full
    // filtered grid, mount/scroll the destination, then focus and select it.
    pendingFocus.current?.complete();
    pendingFocus.current = {
      key: modelIdentityKey(model),
      action: target.dataset.modelAction,
      select: radio,
      canFocus: () => true,
      complete: () => {},
    };
    setKeyboardActive(true);
    activate(destination);
  };
  return (
    <>
      <div className="model-picker__search">
        <Search size={13} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label={grid ? "Search available models" : "Search models"}
          aria-autocomplete="list"
          aria-haspopup={grid ? "grid" : "listbox"}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            keyboardActive && options[active]
              ? `${id}-option-${active}`
              : undefined
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setKeyboardActive(!grid);
            fallbackActiveIndex.current = 0;
            setActiveModelKey(null);
            virtualizer.scrollToOffset(0);
          }}
          onKeyDown={navigate}
          onBlur={() => setKeyboardActive(false)}
          onPointerDown={() => setKeyboardActive(false)}
          placeholder={placeholder ?? "Search provider or model…"}
        />
        {searchAction}
      </div>
      {status ? (
        <div className="picker__empty" role="status">
          {status}
        </div>
      ) : null}
      <div
        ref={listRef}
        data-keyboard-active={keyboardActive}
        id={`${id}-list`}
        tabIndex={grid ? undefined : -1}
        {...{
          role: grid ? "grid" : "listbox",
          "aria-label": "Available models",
          "aria-rowcount": grid ? options.length : undefined,
        }}
        className={`model-picker__list ${options.length ? "" : "model-picker__list--empty"}`}
        style={
          grid && options.length
            ? { height: Math.min(340, virtualizer.getTotalSize()) }
            : undefined
        }
      >
        <div
          className="model-picker__rows"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {[...visibleGroups].map(([group, items]) => (
            <div
              key={group.common ? "common" : `provider/${group.provider}`}
              {...{
                role: grid ? "rowgroup" : "group",
                "aria-label": group.provider,
              }}
            >
              {items.map((item) => {
                const row = rows[item.index]!;
                const style = {
                  position: "absolute" as const,
                  top: item.start,
                  left: 0,
                  width: "100%",
                  height: item.size,
                };
                if (row.kind === "heading")
                  return (
                    <div
                      key={row.key}
                      className="model-picker__heading"
                      aria-hidden
                      style={style}
                    >
                      {group.provider}
                    </div>
                  );
                const { model, index, key } = row;
                const selected = key === currentKey;
                return (
                  <div
                    key={key}
                    id={`${id}-option-${index}`}
                    {...(grid
                      ? {
                          role: "row",
                          "aria-selected": selected,
                          "aria-rowindex": index + 1,
                        }
                      : {
                          role: "option",
                          "aria-selected": selected,
                          "aria-posinset": index + 1,
                          "aria-setsize": options.length,
                        })}
                    style={style}
                    title={`${model.name ?? model.id} — ${model.provider}/${model.id}`}
                    className={`dropdown__option model-picker__option ${grid ? "model-picker__option--actions" : ""} ${index === active && keyboardActive ? "dropdown__option--active" : ""}`}
                    onMouseDown={
                      grid ? undefined : (event) => event.preventDefault()
                    }
                    onPointerMove={(event) => {
                      if (event.pointerType === "touch") return;
                      setKeyboardActive(false);
                      activate(index);
                    }}
                    onFocus={grid ? () => activate(index) : undefined}
                    onKeyDown={
                      grid ? (event) => navigateAction(event, index) : undefined
                    }
                    onClick={grid ? undefined : () => onSelect?.(model)}
                  >
                    <span
                      role={grid ? "gridcell" : undefined}
                      className="model-picker__option-copy"
                    >
                      <span className="model-picker__name">
                        <span className="model-picker__name-text">
                          {model.name ?? model.id}
                        </span>
                        {model.virtual ? (
                          <span className="model-picker__badge model-picker__badge--neutral">
                            Router
                          </span>
                        ) : null}
                        {renderNameAction?.(model, index === active)}
                      </span>
                      <span className="model-picker__id">
                        {group.common || grid ? `${model.provider}/` : ""}
                        {model.id}
                      </span>
                    </span>
                    {renderActions ? (
                      <div
                        role="gridcell"
                        className="models-actions models-row-actions"
                      >
                        {renderActions(model, index === active)}
                      </div>
                    ) : (
                      <span className="model-picker__badges">
                        {!selected && recentKeys.has(key) ? (
                          <span className="model-picker__badge model-picker__badge--recent">
                            Recent
                          </span>
                        ) : null}
                        {model.reasoning === false ? (
                          <span className="model-picker__badge model-picker__badge--neutral">
                            No thinking
                          </span>
                        ) : null}
                        {selected ? <Check size={12} aria-hidden /> : null}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {!options.length ? (
          <div className="picker__empty">
            <p>{query ? "No matching models" : "No models available yet."}</p>
            {!query && emptyAction ? emptyAction : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
