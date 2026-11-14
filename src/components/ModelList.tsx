import { Check } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
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

import { type ListOption, OptionList, useOptionList } from "./OptionList";
import { SearchField } from "./SearchField";
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
function fuzzyCategory(value: string, query: string): number | null {
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
interface ModelCandidate {
  model: ModelOption;
  common?: boolean;
}

const identityRanks = (models: readonly ModelIdentity[]) =>
  new Map(models.map((model, index) => [modelIdentityKey(model), index]));
const lexicalOrder = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const currentKey = value ? modelIdentityKey(value) : "";
  const list = useOptionList<ModelCandidate>(
    initialQuery ? undefined : currentKey,
    autoFocus,
  );
  const recentRank = useMemo(() => identityRanks(recent), [recent]);
  const commonRank = useMemo(() => identityRanks(common), [common]);
  const options = useMemo<ListOption<ModelCandidate>[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = models.flatMap((model) => {
      const category = fuzzyCategory(modelSearchText(model), needle);
      const key = modelIdentityKey(model);
      return category === null
        ? []
        : [
            {
              model,
              key,
              category,
              common: commonRank.get(key) ?? common.length,
            },
          ];
    });
    return matches
      .sort(
        (left, right) =>
          left.common - right.common ||
          lexicalOrder(left.model.provider, right.model.provider) ||
          left.category - right.category ||
          (recentRank.get(left.key) ?? recent.length) -
            (recentRank.get(right.key) ?? recent.length) ||
          lexicalOrder(left.model.id, right.model.id),
      )
      .map(({ key, model }) => {
        const common = commonRank.has(key);
        return {
          key,
          value: { model, common },
          selected: key === currentKey,
          group: common ? "Common models" : model.provider,
          title: `${model.name ?? model.id} — ${model.provider}/${model.id}`,
        };
      });
  }, [
    models,
    query,
    currentKey,
    recentRank,
    recent.length,
    commonRank,
    common.length,
  ]);
  const pick = onSelect
    ? ({ model }: ModelCandidate) => onSelect(model)
    : undefined;
  useSearchFocus(autoFocus, inputRef, list.scrollRef);
  const navigate = (event: KeyboardEvent) => {
    if (isComposingKeyboardEvent(event.nativeEvent)) return;
    if (!list.navigate(event, options, pick, { edges: true }))
      onKeyDown?.(event);
  };
  return (
    <>
      <SearchField
        className="model-picker__search"
        iconSize={13}
        inputRef={inputRef}
        role="combobox"
        aria-label={searchLabel}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded="true"
        aria-controls={list.id}
        aria-activedescendant={list.descendant(options)}
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          list.reset(true);
        }}
        onKeyDown={navigate}
        onBlur={() => list.pointer()}
        onPointerDown={() => list.pointer()}
        placeholder={placeholder ?? "Search provider or model…"}
        action={searchAction}
      />
      {status ? (
        <div className="picker__empty" role="status">
          {status}
        </div>
      ) : null}
      <OptionList
        list={list}
        options={options}
        label="Available models"
        className="model-picker__list"
        optionClass="model-picker__option"
        fixedRows
        onPick={pick}
        onKeyDown={navigate}
        heading={({ group, value: { model, common } }, style, key) => (
          <div
            key={key}
            className="model-picker__heading"
            title={group}
            aria-hidden
            style={style}
          >
            <SearchMatchText
              text={group!}
              ranges={
                common ? [] : modelSearchHighlights(model, query).provider
              }
            />
          </div>
        )}
        renderOption={({ key, value: { model, common }, selected }) => {
          const name = model.name ?? model.id;
          const matches = modelSearchHighlights(model, query);
          return (
            <>
              <span className="model-picker__option-copy">
                <span className="model-picker__name">
                  <span className="model-picker__name-text">
                    <SearchMatchText text={name} ranges={matches.name} />
                  </span>
                  {model.virtual ? (
                    <span className="model-picker__badge">Router</span>
                  ) : null}
                </span>
                <span className="model-picker__id">
                  {common ? (
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
                {!selected && recentRank.has(key) ? (
                  <span className="model-picker__badge">Recent</span>
                ) : null}
                {model.reasoning === false ? (
                  <span className="model-picker__badge">No thinking</span>
                ) : null}
                {selected ? <Check size={12} aria-hidden /> : null}
              </span>
            </>
          );
        }}
      >
        {!options.length && !status ? (
          <div className="picker__empty">
            <p>{query ? "No matching models" : "No models available yet."}</p>
            {!query && emptyAction ? emptyAction : null}
          </div>
        ) : null}
      </OptionList>
    </>
  );
}
