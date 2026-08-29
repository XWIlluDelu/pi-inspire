import { useVirtualizer } from "@tanstack/react-virtual";
import { Paperclip } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UserTurnAnchor } from "../../shared/contracts";

const PAGE_SIZE = 100;
const ROW_HEIGHT = 40;
const MAX_TICKS = 12;

function clampTickWindowStart(start: number, total: number): number {
  return Math.max(0, Math.min(start, Math.max(0, total - MAX_TICKS)));
}

function centeredTickWindowStart(
  total: number,
  activeOrdinal: number | null,
): number {
  const target = activeOrdinal ?? Math.max(0, total - 1);
  return clampTickWindowStart(target - Math.floor(MAX_TICKS / 2), total);
}

function FlatChevron({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      width="16"
      height="6"
      viewBox="0 0 16 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          direction === "up"
            ? "M1.5 4.5L8 1.5L14.5 4.5"
            : "M1.5 1.5L8 4.5L14.5 1.5"
        }
      />
    </svg>
  );
}

export function PromptMap({
  container,
  mobileActive = false,
  onDismissMobile,
  turns,
  total,
  activeOrdinal,
  loadedStarts,
  loadingStarts,
  navigatingOrdinal,
  error,
  onLoad,
  onNavigate,
}: {
  container?: React.RefObject<HTMLElement | null>;
  mobileActive?: boolean;
  onDismissMobile?: () => void;
  turns: readonly UserTurnAnchor[];
  total: number;
  activeOrdinal: number | null;
  loadedStarts: readonly number[];
  loadingStarts: readonly number[];
  navigatingOrdinal: number | null;
  error: string | null;
  onLoad: (start?: number) => Promise<readonly UserTurnAnchor[]>;
  onNavigate: (ordinal: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [localNavigating, setLocalNavigating] = useState(false);
  const [retryOrdinal, setRetryOrdinal] = useState<number | null>(null);
  const [tickWindowStart, setTickWindowStart] = useState(() =>
    centeredTickWindowStart(total, activeOrdinal),
  );
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const disclosureFocusRef = useRef<"open" | "closed" | "escape" | null>(null);
  const pointerFocusRef = useRef(false);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const navigatingRef = useRef(false);
  const wasOpenRef = useRef(false);
  const followedOrdinalRef = useRef<number | null>(null);
  const listUserOwnedRef = useRef(false);
  const previousTickOrdinalRef = useRef(activeOrdinal);
  const previousMobileActiveRef = useRef(mobileActive);
  const turnByOrdinal = useMemo(
    () => new Map(turns.map((turn) => [turn.ordinal, turn])),
    [turns],
  );
  const virtualizer = useVirtualizer({
    enabled: open && total > 0,
    count: total,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => turnByOrdinal.get(index)?.id ?? `prompt:${index}`,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const previousOrdinal = previousTickOrdinalRef.current;
    previousTickOrdinalRef.current = activeOrdinal;
    setTickWindowStart((current) => {
      if (total <= MAX_TICKS) return 0;
      if (activeOrdinal === null) return clampTickWindowStart(current, total);
      if (
        previousOrdinal === null ||
        Math.abs(activeOrdinal - previousOrdinal) > 1
      )
        return centeredTickWindowStart(total, activeOrdinal);
      if (activeOrdinal < current)
        return clampTickWindowStart(activeOrdinal, total);
      if (activeOrdinal >= current + MAX_TICKS)
        return clampTickWindowStart(activeOrdinal - MAX_TICKS + 1, total);
      return clampTickWindowStart(current, total);
    });
  }, [activeOrdinal, total]);

  useEffect(() => {
    void onLoad();
  }, [onLoad]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const root = container?.current;
    if (!nav || !root) return;
    if (mobileActive) {
      nav.style.removeProperty("left");
      nav.style.removeProperty("top");
      return;
    }

    const sync = () => {
      if (!nav || !root || !root.isConnected) return;
      const rect = root.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      const column = root
        .querySelector(".transcript__column")
        ?.getBoundingClientRect();
      const columnLeft = column ? column.left : rect.left + rect.width / 2;
      const columnRight = column ? column.right : rect.left + rect.width / 2;
      const gap = rect.right - columnRight;
      const offset = Math.max(28, Math.min(gap * 0.5, 72));
      const x = Math.max(columnLeft - offset, rect.left + 14);
      const y = rect.top + rect.height / 2;

      if (open) {
        const cardLeft = Math.max(
          12,
          Math.min(x - 14, window.innerWidth - 300),
        );
        nav.style.left = `${Math.round(cardLeft)}px`;
      } else {
        nav.style.left = `${Math.round(x)}px`;
      }
      nav.style.top = `${Math.round(y)}px`;
    };

    // ResizeObserver runs after layout and before paint. Position immediately
    // in that observation cycle so a pane or window resize cannot leave the
    // rail one frame behind the reading column.
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(root);
    // Reading width changes the centered child without resizing this scrollport.
    const readingWidthObserver = new MutationObserver(sync);
    readingWidthObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-reading-width"],
    });
    window.addEventListener("resize", sync);
    sync();

    return () => {
      resizeObserver.disconnect();
      readingWidthObserver.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [container, mobileActive, open]);

  useEffect(() => {
    if (previousMobileActiveRef.current && !mobileActive) setOpen(false);
    previousMobileActiveRef.current = mobileActive;
  }, [mobileActive]);

  useEffect(
    () => () => {
      if (hoverOpenTimerRef.current !== null)
        window.clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current !== null)
        window.clearTimeout(hoverCloseTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      pointerFocusRef.current = false;
      wasOpenRef.current = false;
      followedOrdinalRef.current = null;
      listUserOwnedRef.current = false;
      return;
    }
    if (total === 0) return;
    const firstOpen = !wasOpenRef.current;
    wasOpenRef.current = true;
    const target = activeOrdinal ?? total - 1;
    if (!firstOpen && listUserOwnedRef.current) return;
    if (!firstOpen && followedOrdinalRef.current === target) return;
    followedOrdinalRef.current = target;
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(target, {
        align: firstOpen ? "center" : "auto",
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [activeOrdinal, open, total, virtualizer.scrollToIndex]);

  useLayoutEffect(() => {
    if (disclosureFocusRef.current === "open" && open) {
      disclosureFocusRef.current = null;
      navRef.current?.focus({ preventScroll: true });
    } else if (disclosureFocusRef.current === "escape" && !open) {
      toggleRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || !target.isConnected) return;
      if (!navRef.current?.contains(target)) {
        disclosureFocusRef.current = "closed";
        setOpen(false);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", closeFromOutside, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", closeFromOutside, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || virtualItems.length === 0) return;
    const starts = new Set<number>();
    for (const item of virtualItems) {
      if (!turnByOrdinal.has(item.index))
        starts.add(Math.floor(item.index / PAGE_SIZE) * PAGE_SIZE);
    }
    for (const start of starts) {
      if (!loadedStarts.includes(start) && !loadingStarts.includes(start))
        void onLoad(start);
    }
  }, [loadedStarts, loadingStarts, onLoad, open, turnByOrdinal, virtualItems]);

  const navigate = async (ordinal: number) => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    setLocalNavigating(true);
    setRetryOrdinal(null);
    try {
      if (!(await onNavigate(ordinal))) {
        setRetryOrdinal(ordinal);
      } else {
        disclosureFocusRef.current = "closed";
        if (navRef.current?.contains(document.activeElement)) {
          (document.activeElement as HTMLElement).blur();
        }
        setOpen(false);
      }
    } catch {
      setRetryOrdinal(ordinal);
    } finally {
      navigatingRef.current = false;
      setLocalNavigating(false);
    }
  };
  const navigating = navigatingOrdinal !== null || localNavigating;
  const outlineRetryStart = (() => {
    const missing = virtualItems.find((item) => !turnByOrdinal.has(item.index));
    return missing
      ? Math.floor(missing.index / PAGE_SIZE) * PAGE_SIZE
      : undefined;
  })();
  const previousDisabled =
    navigating || activeOrdinal === null || activeOrdinal <= 0;
  const nextDisabled =
    navigating || activeOrdinal === null || activeOrdinal >= total - 1;
  const tickCount = Math.min(total, MAX_TICKS);
  const visibleTickStart = clampTickWindowStart(tickWindowStart, total);
  const cancelHoverOpen = () => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  };
  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };
  const requestHoverOpen = () => {
    cancelHoverClose();
    if (hoverOpenTimerRef.current !== null) return;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      setOpen(true);
    }, 80);
  };
  const requestHoverClose = () => {
    cancelHoverOpen();
    if (hoverCloseTimerRef.current !== null) return;
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      const nav = navRef.current;
      if (nav?.matches(":hover")) return;
      if (pointerFocusRef.current && nav?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      pointerFocusRef.current = false;
      if (!nav?.contains(document.activeElement)) {
        disclosureFocusRef.current = "closed";
        setOpen(false);
      }
    }, 120);
  };

  return (
    <nav
      ref={navRef}
      className={`prompt-map ${mobileActive ? "prompt-map--mobile-active" : ""} ${open ? "prompt-map--open" : ""}`}
      aria-label="User prompt navigation"
      data-prompt-map
      data-mobile-active={mobileActive ? "true" : undefined}
      style={
        {
          "--prompt-map-list-height": `${Math.max(1, Math.min(total, 12)) * ROW_HEIGHT}px`,
        } as CSSProperties
      }
      tabIndex={-1}
      onPointerDownCapture={() => {
        pointerFocusRef.current = true;
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") cancelHoverClose();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") requestHoverClose();
      }}
      onBlurCapture={(event) => {
        const nav = event.currentTarget;
        requestAnimationFrame(() => {
          if (!nav.isConnected || nav.contains(document.activeElement)) return;
          disclosureFocusRef.current = "closed";
          setOpen(false);
        });
      }}
      onKeyDown={(event) => {
        pointerFocusRef.current = false;
        if (event.key !== "Escape") return;
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          disclosureFocusRef.current = "escape";
          setOpen(false);
        } else if (mobileActive && onDismissMobile) {
          event.preventDefault();
          event.stopPropagation();
          onDismissMobile();
        }
      }}
    >
      <button
        type="button"
        className="prompt-map__step prompt-map__step--previous"
        aria-label="Previous user prompt"
        title="Previous user prompt"
        disabled={previousDisabled}
        onClick={() => {
          if (activeOrdinal !== null) void navigate(activeOrdinal - 1);
        }}
      >
        <FlatChevron direction="up" />
      </button>

      <div className="prompt-map__body">
        {open ? (
          <div className="prompt-map__flyout">
            <div
              ref={listRef}
              className="prompt-map__list"
              role="list"
              aria-label="User prompts"
              tabIndex={0}
              onPointerDown={() => {
                listUserOwnedRef.current = true;
              }}
              onWheel={() => {
                listUserOwnedRef.current = true;
              }}
              onTouchStart={() => {
                listUserOwnedRef.current = true;
              }}
              onKeyDown={(event) => {
                if (
                  [
                    "ArrowDown",
                    "ArrowUp",
                    "End",
                    "Home",
                    "PageDown",
                    "PageUp",
                    " ",
                  ].includes(event.key)
                )
                  listUserOwnedRef.current = true;
              }}
            >
              {total === 0 ? (
                <p className="prompt-map__empty">No user prompts</p>
              ) : (
                <div
                  className="prompt-map__virtual"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {virtualItems.map((item) => {
                    const turn = turnByOrdinal.get(item.index);
                    return (
                      <div
                        key={item.key}
                        ref={virtualizer.measureElement}
                        data-index={item.index}
                        className="prompt-map__virtual-row"
                        role="listitem"
                        style={{ transform: `translateY(${item.start}px)` }}
                      >
                        {turn ? (
                          <button
                            type="button"
                            className={`prompt-map__turn ${item.index === activeOrdinal ? "prompt-map__turn--active" : ""}`}
                            aria-current={
                              item.index === activeOrdinal
                                ? "location"
                                : undefined
                            }
                            disabled={navigating}
                            title={turn.snippet}
                            onClick={() => void navigate(item.index)}
                          >
                            <span className="prompt-map__ordinal">
                              {item.index + 1}.
                            </span>
                            <span className="prompt-map__snippet">
                              {turn.snippet}
                            </span>
                            {turn.attachmentCount > 0 ? (
                              <span className="prompt-map__attachments">
                                <Paperclip size={11} aria-hidden />
                                <span aria-hidden>{turn.attachmentCount}</span>
                                <span className="visually-hidden">
                                  {turn.attachmentCount}{" "}
                                  {turn.attachmentCount === 1
                                    ? "attachment"
                                    : "attachments"}
                                </span>
                              </span>
                            ) : null}
                          </button>
                        ) : (
                          <div
                            className="prompt-map__skeleton"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {loadingStarts.length > 0 ? (
              <span className="visually-hidden" role="status">
                Loading user prompts
              </span>
            ) : null}
            {error || retryOrdinal !== null ? (
              <button
                type="button"
                className="prompt-map__error"
                title={error ?? "Prompt navigation failed"}
                onClick={() =>
                  retryOrdinal === null
                    ? void onLoad(outlineRetryStart)
                    : void navigate(retryOrdinal)
                }
              >
                Retry prompt navigation
              </button>
            ) : null}
          </div>
        ) : (
          <button
            ref={toggleRef}
            type="button"
            className="prompt-map__toggle"
            aria-label="Open prompt map"
            aria-expanded="false"
            title="Open prompt map"
            onPointerEnter={(event) => {
              if (!mobileActive && event.pointerType !== "touch")
                requestHoverOpen();
            }}
            onFocus={() => {
              cancelHoverOpen();
              cancelHoverClose();
              if (disclosureFocusRef.current === "escape") {
                disclosureFocusRef.current = null;
                return;
              }
              if (mobileActive || pointerFocusRef.current) return;
              disclosureFocusRef.current = "open";
              setOpen(true);
            }}
            onClick={() => {
              cancelHoverOpen();
              cancelHoverClose();
              disclosureFocusRef.current = "open";
              setOpen(true);
            }}
          >
            <span className="prompt-map__ticks" aria-hidden="true">
              {Array.from({ length: tickCount }, (_, index) => {
                const ordinal = visibleTickStart + index;
                const isActive = ordinal === activeOrdinal;
                return (
                  <i
                    key={ordinal}
                    data-prompt-ordinal={ordinal}
                    className={
                      isActive ? "prompt-map__tick--active" : undefined
                    }
                  />
                );
              })}
            </span>
          </button>
        )}
      </div>

      <button
        type="button"
        className="prompt-map__step prompt-map__step--next"
        aria-label="Next user prompt"
        title="Next user prompt"
        disabled={nextDisabled}
        onClick={() => {
          if (activeOrdinal !== null) void navigate(activeOrdinal + 1);
        }}
      >
        <FlatChevron direction="down" />
      </button>
    </nav>
  );
}
