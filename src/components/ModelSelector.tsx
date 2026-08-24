import { Check, ChevronDown, Search } from "lucide-react";
import {
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

interface ModelGroupingMetrics {
  comparisons: number;
  visits: number;
}

function fuzzyCategory(
  value: string,
  queryValue: string,
  metrics?: ModelGroupingMetrics,
): number | null {
  const query = queryValue.trim().toLocaleLowerCase();
  if (!query) return 0;
  const text = value.toLocaleLowerCase();
  metrics && (metrics.visits += text.length);
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

interface ModelMenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ModelMenuPlacement {
  direction: "up" | "down";
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

const MODEL_MENU_GAP = 4;
const MODEL_MENU_HORIZONTAL_MARGIN = 16;
const MODEL_MENU_VERTICAL_MARGIN = 8;
const MODEL_MENU_MAX_WIDTH = 520;
const MODEL_MENU_MAX_HEIGHT = 440;

function samePlacement(
  left: ModelMenuPlacement | null,
  right: ModelMenuPlacement,
): boolean {
  return (
    left?.direction === right.direction &&
    left.left === right.left &&
    left.top === right.top &&
    left.bottom === right.bottom &&
    left.width === right.width &&
    left.maxHeight === right.maxHeight
  );
}

/** Place the menu inside the live center viewport, preferring the side with
 * more usable room. Upward placement uses bottom alignment so a short menu
 * remains attached to its trigger without measuring its rendered height. */
export function placeModelMenu(
  trigger: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  bounds: ModelMenuBounds,
  layoutHeight: number,
): ModelMenuPlacement {
  const availableWidth = Math.max(
    0,
    bounds.right - bounds.left - 2 * MODEL_MENU_HORIZONTAL_MARGIN,
  );
  const width = Math.min(MODEL_MENU_MAX_WIDTH, availableWidth);
  const minimumLeft = bounds.left + MODEL_MENU_HORIZONTAL_MARGIN;
  const maximumLeft = Math.max(
    minimumLeft,
    bounds.right - MODEL_MENU_HORIZONTAL_MARGIN - width,
  );
  const left = Math.min(Math.max(trigger.left, minimumLeft), maximumLeft);
  const above = Math.max(
    0,
    trigger.top - MODEL_MENU_GAP - bounds.top - MODEL_MENU_VERTICAL_MARGIN,
  );
  const below = Math.max(
    0,
    bounds.bottom -
      MODEL_MENU_VERTICAL_MARGIN -
      trigger.bottom -
      MODEL_MENU_GAP,
  );
  const direction = above >= below ? "up" : "down";
  const maxHeight = Math.min(
    MODEL_MENU_MAX_HEIGHT,
    direction === "up" ? above : below,
  );

  return {
    direction,
    left: Math.round(left),
    ...(direction === "down"
      ? { top: Math.round(trigger.bottom + MODEL_MENU_GAP) }
      : {
          bottom: Math.round(layoutHeight - trigger.top + MODEL_MENU_GAP),
        }),
    width: Math.round(width),
    maxHeight: Math.floor(maxHeight),
  };
}

function liveModelMenuBounds(root: HTMLElement): ModelMenuBounds {
  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  let bounds: ModelMenuBounds = {
    left: viewportLeft,
    top: viewportTop,
    right: viewportLeft + viewportWidth,
    bottom: viewportTop + viewportHeight,
  };
  const center = root.closest<HTMLElement>(".center");
  const centerBounds = center?.getBoundingClientRect();
  if (centerBounds && centerBounds.width > 0 && centerBounds.height > 0) {
    bounds = {
      left: Math.max(bounds.left, centerBounds.left),
      top: Math.max(bounds.top, centerBounds.top),
      right: Math.min(bounds.right, centerBounds.right),
      bottom: Math.min(bounds.bottom, centerBounds.bottom),
    };
  }
  const topbarBounds = center
    ?.querySelector<HTMLElement>(":scope > .topbar")
    ?.getBoundingClientRect();
  if (topbarBounds && topbarBounds.height > 0)
    bounds.top = Math.max(bounds.top, topbarBounds.bottom);
  return bounds;
}

/** Canonical comparison sorting is paid only when the available-model array changes. */
export function prepareModelOptions(
  models: readonly ModelOption[],
  metrics?: ModelGroupingMetrics,
): ModelOption[] {
  return models
    .map((model, order) => ({ model, order }))
    .sort((left, right) => {
      if (metrics) metrics.comparisons += 1;
      return left.model.provider < right.model.provider
        ? -1
        : left.model.provider > right.model.provider
          ? 1
          : left.model.id < right.model.id
            ? -1
            : left.model.id > right.model.id
              ? 1
              : left.order - right.order;
    })
    .map(({ model }) => model);
}

/** Stable linear filtering and bounded relevance bucketing over prepared models. */
export function groupPreparedModels(
  models: readonly ModelOption[],
  recent: readonly ModelIdentity[],
  query = "",
  metrics?: ModelGroupingMetrics,
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
    if (metrics) metrics.visits += 1;
    const category = fuzzyCategory(
      `${model.provider} ${model.id} ${model.name ?? ""}`,
      query,
      metrics,
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

/** Convenience owner for non-rendering callers; production prepares once with useMemo. */
export function groupModels(
  models: readonly ModelOption[],
  recent: readonly ModelIdentity[],
  query = "",
): ModelGroup[] {
  return groupPreparedModels(prepareModelOptions(models), recent, query);
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
  const [placement, setPlacement] = useState<ModelMenuPlacement | null>(null);
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
    setPlacement(null);
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
    if (!open) return;
    const root = rootRef.current;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!root || !trigger || !menu) return;

    let frame: number | null = null;
    const update = () => {
      frame = null;
      if (!trigger.isConnected || !menu.isConnected) return;
      const next = placeModelMenu(
        trigger.getBoundingClientRect(),
        liveModelMenuBounds(root),
        document.documentElement.clientHeight || window.innerHeight,
      );
      setPlacement((current) =>
        samePlacement(current, next) ? current : next,
      );
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const center = root.closest<HTMLElement>(".center");
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resizeObserver?.observe(trigger);
    if (center) resizeObserver?.observe(center);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    update();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open]);

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
