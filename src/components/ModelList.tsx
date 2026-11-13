import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Check, Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
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
import { isComposingKeyboardEvent } from "../keyboard-input";
import { useSearchFocus } from "../use-search-focus";

import {
  fuzzySearchMatchRanges,
  mergeSearchMatchRanges,
  SearchMatchText,
} from "./SearchMatchText";

const EMPTY_IDENTITIES: readonly ModelIdentity[] = [];

function modelSearchHighlights(model: ModelOption, query: string) {
  const name = model.name ?? model.id;
  const nameOffset = model.provider.length + model.id.length + 2;
  const identityOffset = nameOffset + (model.name ?? "").length + 1;
  const matches = fuzzySearchMatchRanges(
    modelSearchText(model),
    query,
    (value) => value.toLocaleLowerCase(),
  );
  const project = (text: string, offsets: number[]) =>
    mergeSearchMatchRanges(
      offsets.flatMap((offset) =>
        matches
          .map((range) => ({
            start: Math.max(0, range.start - offset),
            end: Math.min(text.length, range.end - offset),
          }))
          .filter((range) => range.end > range.start),
      ),
    );
  const idOffsets = [
    model.provider.length + 1,
    identityOffset + model.provider.length + 1,
  ];
  return {
    provider: project(model.provider, [0, identityOffset]),
    id: project(model.id, idOffsets),
    name: project(
      name,
      model.name == null
        ? idOffsets
        : name === model.id
          ? [nameOffset, ...idOffsets]
          : [nameOffset],
    ),
  };
}
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

/** Shared searchable model list. Actions belong to the selected model outside the list. */
export function ModelList({
  models,
  value,
  recent = EMPTY_IDENTITIES,
  common = EMPTY_IDENTITIES,
  initialQuery = "",
  status,
  onSelect,
  onKeyDown,
  autoFocus = false,
  searchAction,
  placeholder,
  searchLabel = "Search models",
  emptyAction,
}: {
  models: ModelOption[];
  value: ModelOption | null;
  recent?: readonly ModelIdentity[];
  common?: readonly ModelIdentity[];
  initialQuery?: string;
  status?: string | null;
  onSelect?: (model: ModelOption) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  autoFocus?: boolean;
  searchAction?: ReactNode;
  placeholder?: string;
  searchLabel?: string;
  emptyAction?: ReactNode;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [keyboardActive, setKeyboardActive] = useState(autoFocus);
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
  const getScrollElement = useCallback(() => listRef.current, []);
  const estimateSize = useCallback(
    (index: number) => (rows[index]?.kind === "heading" ? 28 : 48),
    [rows],
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
  useSearchFocus(autoFocus, inputRef, listRef);
  useEffect(() => {
    fallbackActiveIndex.current = active;
    const key = options[active] ? modelIdentityKey(options[active]) : null;
    if (activeModelKey !== key) setActiveModelKey(key);
  }, [options, active, activeModelKey]);
  useLayoutEffect(() => {
    if (activeRow !== undefined && keyboardActive)
      virtualizer.scrollToIndex(activeRow, { align: "auto" });
  }, [activeRow, keyboardActive, rows, virtualizer]);
  const navigate = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isComposingKeyboardEvent(event.nativeEvent))
      return;
    if (
      options.length &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      setKeyboardActive(true);
      activate(
        event.key === "ArrowDown"
          ? active + 1
          : event.key === "ArrowUp"
            ? active - 1
            : event.key === "Home"
              ? 0
              : options.length - 1,
      );
    } else if (event.key === "Enter" && onSelect && options[active]) {
      event.preventDefault();
      onSelect(options[active]!);
    } else onKeyDown?.(event);
  };
  return (
    <>
      <div className="model-picker__search">
        <Search size={13} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label={searchLabel}
          aria-autocomplete="list"
          aria-haspopup="listbox"
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
            setKeyboardActive(true);
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
        tabIndex={-1}
        onKeyDown={navigate}
        role="listbox"
        aria-label="Available models"
        aria-activedescendant={
          keyboardActive && options[active]
            ? `${id}-option-${active}`
            : undefined
        }
        className={`model-picker__list ${options.length ? "" : "model-picker__list--empty"}`}
      >
        <div
          className="model-picker__rows"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {[...visibleGroups].map(([group, items]) => (
            <div
              key={group.common ? "common" : `provider/${group.provider}`}
              {...{
                role: "group",
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
                      title={group.provider}
                      aria-hidden
                      style={style}
                    >
                      <SearchMatchText
                        text={group.provider}
                        ranges={
                          group.common
                            ? []
                            : modelSearchHighlights(group.models[0]!, query)
                                .provider
                        }
                      />
                    </div>
                  );
                const { model, index, key } = row;
                const selected = key === currentKey;
                const name = model.name ?? model.id;
                const matches = modelSearchHighlights(model, query);
                return (
                  <div
                    key={key}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={selected}
                    aria-posinset={index + 1}
                    aria-setsize={options.length}
                    style={style}
                    title={`${model.name ?? model.id} — ${model.provider}/${model.id}`}
                    className={`model-picker__option ${index === active && keyboardActive ? "model-picker__option--active" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={(event) => {
                      if (event.pointerType === "touch") return;
                      setKeyboardActive(false);
                      activate(index);
                    }}
                    onClick={() => onSelect?.(model)}
                  >
                    <span className="model-picker__option-copy">
                      <span className="model-picker__name">
                        <span className="model-picker__name-text">
                          <SearchMatchText text={name} ranges={matches.name} />
                        </span>
                        {model.virtual ? (
                          <span className="model-picker__badge model-picker__badge--neutral">
                            Router
                          </span>
                        ) : null}
                      </span>
                      <span className="model-picker__id">
                        {group.common ? (
                          <>
                            <SearchMatchText
                              text={model.provider}
                              ranges={matches.provider}
                            />
                            /
                          </>
                        ) : null}
                        <SearchMatchText text={model.id} ranges={matches.id} />
                      </span>
                    </span>
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
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {!options.length && !status ? (
          <div className="picker__empty">
            <p>{query ? "No matching models" : "No models available yet."}</p>
            {!query && emptyAction ? emptyAction : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
