import { Check, ChevronDown, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  modelIdentityKey,
  type ModelIdentity,
  type ModelOption,
} from "../../shared/contracts";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";

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

interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

const MODEL_MENU_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: 520,
  maxHeight: 440,
};

/** Canonical comparison sorting is paid only when the available-model array changes. */
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

/** Stable linear filtering and bounded relevance bucketing over prepared models. */
function groupPreparedModels(
  models: readonly ModelOption[],
  recent: readonly ModelIdentity[],
  query = "",
): ModelGroup[] {
  const recentRank = new Map(
    recent.map((model, index) => [modelIdentityKey(model), index]),
  );
  type Bucket = {
    recent: Array<ModelOption | undefined>;
    ordinary: ModelOption[];
  };
  const groups = new Map<string, Bucket[]>();
  for (const model of models) {
    const category = fuzzyCategory(
      `${model.provider} ${model.id} ${model.name ?? ""}`,
      query,
    );
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
  return [...groups].map(([provider, buckets]) => ({
    provider,
    models: buckets.flatMap((bucket) => [
      ...bucket.recent.filter((model): model is ModelOption => Boolean(model)),
      ...bucket.ordinary,
    ]),
  }));
}

export function ModelSelector({
  value,
  models,
  recent,
  onChange,
  emptyLabel = "No session model",
  disabled = false,
}: {
  value: ModelOption | null;
  models: ModelOption[];
  recent: ModelIdentity[];
  onChange: (provider: string, id: string) => void;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const resolveMenuTarget = useCallback(() => {
    const root = rootRef.current;
    const trigger = triggerRef.current;
    if (!root || !trigger) return null;
    return {
      context: root,
      anchor: trigger.getBoundingClientRect(),
      observe: [trigger],
    };
  }, []);
  const placement = useFloatingMenuPlacement(
    open,
    resolveMenuTarget,
    MODEL_MENU_CONSTRAINTS,
  );
  const currentKey = value ? modelIdentityKey(value) : "";
  const recentKeys = useMemo(
    () => new Set(recent.map(modelIdentityKey)),
    [recent],
  );
  const preparedModels = useMemo(() => prepareModelOptions(models), [models]);
  const groups = useMemo(
    () => groupPreparedModels(preparedModels, recent, query),
    [preparedModels, recent, query],
  );
  const { options, optionIndexes } = useMemo(() => {
    const flattened = groups.flatMap((group) => group.models);
    return {
      options: flattened,
      optionIndexes: new Map(
        flattened.map((model, index) => [modelIdentityKey(model), index]),
      ),
    };
  }, [groups]);

  const show = () => {
    if (models.length === 0) return;
    setQuery("");
    const unfiltered = groupPreparedModels(preparedModels, recent).flatMap(
      (group) => group.models,
    );
    setActive(
      Math.max(
        0,
        unfiltered.findIndex((model) => modelIdentityKey(model) === currentKey),
      ),
    );
    setOpen(true);
  };

  const restoreTriggerFocus = () => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const pick = (model: ModelOption | undefined) => {
    if (!model) return;
    setOpen(false);
    // Selection ownership may continue asynchronously in the store, but the
    // transient search surface is already gone and keyboard focus belongs to
    // its stable trigger immediately after React commits that close.
    restoreTriggerFocus();
    if (modelIdentityKey(model) !== currentKey)
      onChange(model.provider, model.id);
  };

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActive((index) => Math.min(index, Math.max(0, options.length - 1)));
  }, [open, options.length]);

  useEffect(() => {
    if (!open || !placement) return;
    const list = listRef.current;
    const option = optionRefs.current[active];
    if (!list || !option) return;
    const listBounds = list.getBoundingClientRect();
    const optionBounds = option.getBoundingClientRect();
    if (optionBounds.top < listBounds.top)
      list.scrollTop -= listBounds.top - optionBounds.top;
    else if (optionBounds.bottom > listBounds.bottom)
      list.scrollTop += optionBounds.bottom - listBounds.bottom;
  }, [active, open, options.length, placement]);

  const onListKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      restoreTriggerFocus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      // The menu is portaled out of document order. Rebase native Tab
      // navigation on the trigger so it still advances through Composer.
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, options.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(options[active]);
    }
  };

  const reasoning = value?.reasoning;
  const display = value?.name ?? value?.id ?? emptyLabel;
  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="dropdown__trigger model-picker__trigger"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || models.length === 0}
        title={
          reasoning === false
            ? `${display} — thinking is not supported`
            : `${display} — ${value?.provider ?? "no provider"}`
        }
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (
            !open &&
            ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)
          ) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className="model-picker__trigger-copy">
          <span className="dropdown__value">{display}</span>
        </span>
        <ChevronDown size={11} aria-hidden />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="model-picker__menu dropdown__menu"
              data-placement={placement?.direction}
              style={
                placement
                  ? {
                      left: placement.left,
                      top: placement.top,
                      bottom: placement.bottom,
                      width: placement.width,
                      maxHeight: placement.maxHeight,
                    }
                  : { visibility: "hidden" }
              }
            >
              <div className="model-picker__search">
                <Search size={13} aria-hidden />
                <input
                  ref={inputRef}
                  role="combobox"
                  aria-label="Search models"
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={`${id}-listbox`}
                  aria-activedescendant={
                    options[active] ? `${id}-option-${active}` : undefined
                  }
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onListKey}
                  placeholder="Search provider or model…"
                />
              </div>
              <div
                ref={listRef}
                id={`${id}-listbox`}
                role="listbox"
                aria-label="Available models"
                className="model-picker__list"
              >
                {groups.map((group) => (
                  <div
                    key={group.provider}
                    role="group"
                    aria-label={group.provider}
                  >
                    <div className="model-picker__heading" aria-hidden>
                      {group.provider}
                    </div>
                    {group.models.map((model) => {
                      const key = modelIdentityKey(model);
                      const index = optionIndexes.get(key)!;
                      const selected = key === currentKey;
                      return (
                        <div
                          key={key}
                          ref={(element) => {
                            optionRefs.current[index] = element;
                          }}
                          id={`${id}-option-${index}`}
                          role="option"
                          aria-selected={selected}
                          className={`dropdown__option model-picker__option ${index === active ? "dropdown__option--active" : ""}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => pick(model)}
                        >
                          <span className="model-picker__option-copy">
                            <span>{model.name ?? model.id}</span>
                            {model.name ? (
                              <span className="model-picker__id">
                                {model.id}
                              </span>
                            ) : null}
                          </span>
                          <span className="model-picker__badges">
                            {selected ? <span>Active</span> : null}
                            {!selected && recentKeys.has(key) ? (
                              <span>Recent</span>
                            ) : null}
                            {model.reasoning === false ? (
                              <span>No thinking</span>
                            ) : null}
                            {selected ? <Check size={12} aria-hidden /> : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {options.length === 0 ? (
                  <div className="picker__empty">No matching models</div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
