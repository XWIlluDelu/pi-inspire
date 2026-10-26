import { ArrowDown, ArrowUp, GripVertical, ListOrdered } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { SessionActionId } from "../../shared/contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  moveSessionAction,
  SESSION_ACTION_LABELS,
  SESSION_ACTION_VISIBLE_COUNT,
} from "../session-actions";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useModalPortal } from "../use-modal-focus";
import { useSessionActionReorder } from "../use-session-action-reorder";
import { SettingsSection } from "./SettingsSection";

const POPOVER_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 8,
  verticalMargin: 8,
  maxWidth: 220,
  maxHeight: 120,
  preferredDirection: "down",
};

export function SessionActionsSettings({
  order,
  onChange,
}: {
  order: readonly SessionActionId[];
  onChange: (order: SessionActionId[]) => void;
}) {
  const containerRef = useRef<HTMLOListElement | null>(null);
  const activeHandleRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusAction = useRef<SessionActionId | null>(null);
  const [activeMenu, setActiveMenu] = useState<SessionActionId | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const closeMenu = useCallback((restoreFocus = true) => {
    setActiveMenu(null);
    if (restoreFocus && activeHandleRef.current?.isConnected) {
      activeHandleRef.current.focus({ preventScroll: true });
    }
  }, []);

  const openMenuFor = useCallback(
    (id: SessionActionId, trigger: HTMLButtonElement) => {
      activeHandleRef.current = trigger;
      setActiveMenu(id);
    },
    [],
  );

  const resolveTarget = useCallback(() => {
    const trigger = activeHandleRef.current;
    if (!trigger?.isConnected) return null;
    const anchor = trigger.getBoundingClientRect();
    return {
      context: trigger,
      anchor,
      preferredWidth: 190,
      observe: [trigger],
    };
  }, []);

  const placement = useFloatingMenuPlacement(
    Boolean(activeMenu),
    resolveTarget,
    POPOVER_CONSTRAINTS,
  );
  useModalPortal(Boolean(activeMenu && placement), activeHandleRef, popoverRef);

  const reorder = useSessionActionReorder({
    order,
    onChange,
    containerRef,
    onReorderStart: () => closeMenu(false),
    onHandleClick: (id) => {
      const handle = containerRef.current?.querySelector<HTMLButtonElement>(
        `[data-session-action-id="${id}"] .session-action-order__handle`,
      );
      if (handle) {
        if (activeMenu === id) {
          closeMenu(false);
        } else {
          openMenuFor(id, handle);
        }
      }
    },
    onMove: (id, nextIndex) => {
      setAnnouncement(
        `${SESSION_ACTION_LABELS[id]} moved to position ${nextIndex + 1} of ${order.length}.`,
      );
    },
  });

  useLayoutEffect(() => {
    const id = pendingFocusAction.current;
    if (!id) return;
    pendingFocusAction.current = null;
    const handle = containerRef.current?.querySelector<HTMLButtonElement>(
      `[data-session-action-id="${id}"] .session-action-order__handle`,
    );
    handle?.focus({ preventScroll: true });
  }, [order]);

  useLayoutEffect(() => {
    if (
      activeMenu &&
      placement &&
      !popoverRef.current?.contains(document.activeElement)
    ) {
      const firstEnabled = popoverRef.current?.querySelector<HTMLButtonElement>(
        "button[role='menuitem']:not(:disabled)",
      );
      firstEnabled?.focus({ preventScroll: true });
    }
  }, [activeMenu, placement]);

  useEffect(() => {
    if (!activeMenu) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (
        !popoverRef.current?.contains(target) &&
        !activeHandleRef.current?.contains(target)
      ) {
        closeMenu(false);
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("focusin", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("focusin", dismiss);
    };
  }, [activeMenu, closeMenu]);

  const executeMove = (actionId: SessionActionId, offset: number) => {
    const currentIndex = order.indexOf(actionId);
    if (currentIndex < 0) return;
    const destination = Math.max(
      0,
      Math.min(order.length - 1, currentIndex + offset),
    );
    if (destination === currentIndex) {
      closeMenu(true);
      return;
    }
    pendingFocusAction.current = actionId;
    onChange(moveSessionAction(order, actionId, destination));
    setAnnouncement(
      `${SESSION_ACTION_LABELS[actionId]} moved to position ${destination + 1} of ${order.length}.`,
    );
    closeMenu(false);
  };

  const activeIndex = activeMenu ? order.indexOf(activeMenu) : -1;

  return (
    <SettingsSection
      id="session-actions"
      icon={<ListOrdered size={14} />}
      title="Session actions"
      description="Reorder the session title menu."
    >
      <ol
        ref={containerRef}
        className="session-action-order"
        aria-label="Session action order"
        onPointerMove={reorder.onPointerMove}
        onPointerUp={reorder.onPointerUp}
        onPointerCancel={reorder.onPointerCancel}
        onLostPointerCapture={reorder.onPointerCancel}
        onKeyDown={(event) => {
          if (reorder.onKeyDown(event)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {reorder.order.map((id, index) => {
          const showBoundary = index === SESSION_ACTION_VISIBLE_COUNT;
          const isMenuOpen = activeMenu === id;

          return (
            <Fragment key={id}>
              {showBoundary ? (
                <li
                  className="session-action-order__boundary"
                  role="separator"
                  aria-label="Revealed under More actions"
                >
                  <div
                    className="session-action-order__boundary-line"
                    aria-hidden
                  />
                  <span className="session-action-order__boundary-label">
                    Revealed under More actions
                  </span>
                  <div
                    className="session-action-order__boundary-line"
                    aria-hidden
                  />
                </li>
              ) : null}
              <li
                className="session-action-order__row"
                data-session-action-id={id}
                data-dragging={reorder.draggingId === id || undefined}
              >
                <span className="session-action-order__index" aria-hidden>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="session-action-order__label">
                  {SESSION_ACTION_LABELS[id]}
                </span>
                <button
                  type="button"
                  className="session-action-order__handle"
                  aria-label={`Reorder ${SESSION_ACTION_LABELS[id]}`}
                  aria-haspopup="menu"
                  aria-expanded={isMenuOpen}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  title="Drag to reorder · Click for move options · Alt+↑/↓ to move"
                  onPointerDown={(event) => reorder.startDrag(event, id)}
                  onClick={(event) => {
                    // Pointer taps are handled after releasing drag capture.
                    // Native keyboard and assistive activation use click detail 0.
                    if (event.detail !== 0) return;
                    if (isMenuOpen) {
                      closeMenu(false);
                    } else {
                      openMenuFor(id, event.currentTarget);
                    }
                  }}
                >
                  <GripVertical size={16} aria-hidden />
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>
      {activeMenu && placement
        ? createPortal(
            <div
              ref={popoverRef}
              role="menu"
              className="session-action-order__popover"
              aria-label={`Move options for ${SESSION_ACTION_LABELS[activeMenu]}`}
              style={{
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
              onKeyDown={(event) => {
                if (isComposingKeyboardEvent(event.nativeEvent)) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeMenu(true);
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  closeMenu(true);
                  return;
                }
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button[role='menuitem']:not(:disabled)",
                  ),
                );
                if (!buttons.length) return;
                const activeEl = document.activeElement as HTMLButtonElement;
                const idx = buttons.indexOf(activeEl);
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  const next = (idx + 1) % buttons.length;
                  buttons[next]?.focus();
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = (idx - 1 + buttons.length) % buttons.length;
                  buttons[next]?.focus();
                } else if (event.key === "Home") {
                  event.preventDefault();
                  buttons[0]?.focus();
                } else if (event.key === "End") {
                  event.preventDefault();
                  buttons[buttons.length - 1]?.focus();
                }
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="session-action-order__popover-item"
                aria-label={`Move ${SESSION_ACTION_LABELS[activeMenu]} up`}
                disabled={activeIndex <= 0}
                onClick={(event) => {
                  event.stopPropagation();
                  executeMove(activeMenu, -1);
                }}
              >
                <ArrowUp size={14} aria-hidden />
                <span>Move up</span>
                <kbd className="session-action-order__kbd">Alt+↑</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-action-order__popover-item"
                aria-label={`Move ${SESSION_ACTION_LABELS[activeMenu]} down`}
                disabled={activeIndex >= order.length - 1}
                onClick={(event) => {
                  event.stopPropagation();
                  executeMove(activeMenu, 1);
                }}
              >
                <ArrowDown size={14} aria-hidden />
                <span>Move down</span>
                <kbd className="session-action-order__kbd">Alt+↓</kbd>
              </button>
            </div>,
            document.body,
          )
        : null}
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </SettingsSection>
  );
}
