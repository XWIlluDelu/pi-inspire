import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SessionActionId } from "../shared/contracts";
import { moveSessionAction } from "./session-actions";

interface Drag {
  id: SessionActionId;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  order: SessionActionId[];
}

/** Keep drag previews local; persist only a completed drop or keyboard move. */
export function useSessionActionReorder({
  order,
  onChange,
  containerRef,
  onReorderStart,
  onHandleClick,
  onMove,
}: {
  order: readonly SessionActionId[];
  onChange: (order: SessionActionId[]) => void;
  containerRef: RefObject<HTMLElement | null>;
  onReorderStart?: () => void;
  onHandleClick?: (id: SessionActionId) => void;
  onMove?: (id: SessionActionId, nextIndex: number) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const focus = useRef<HTMLButtonElement | null>(null);
  const [preview, setPreview] = useState<SessionActionId[] | null>(null);
  const [draggingId, setDraggingId] = useState<SessionActionId | null>(null);

  useLayoutEffect(() => {
    if (focus.current?.isConnected) {
      focus.current.focus({ preventScroll: true });
      if (!drag.current) {
        focus.current.scrollIntoView({ block: "nearest" });
        focus.current = null;
      }
    }
  }, [order, preview, draggingId]);

  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    const wasActive = current.active;
    const dragId = current.id;
    drag.current = null;
    if (!wasActive) focus.current = null;
    if (containerRef.current?.hasPointerCapture(current.pointerId)) {
      containerRef.current.releasePointerCapture(current.pointerId);
    }
    if (
      commit &&
      wasActive &&
      current.order.some((id, index) => id !== order[index])
    ) {
      onChange(current.order);
      const newIndex = current.order.indexOf(dragId);
      onMove?.(dragId, newIndex);
    }
    setPreview(null);
    setDraggingId(null);
  };

  return {
    order: preview ?? order,
    draggingId,
    startDrag: (
      event: PointerEvent<HTMLButtonElement>,
      id: SessionActionId,
    ) => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      focus.current = event.currentTarget;
      drag.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        order: [...order],
      };
      containerRef.current?.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.active) {
        if (
          Math.hypot(
            event.clientX - current.startX,
            event.clientY - current.startY,
          ) < 5
        )
          return;
        current.active = true;
        setDraggingId(current.id);
        onReorderStart?.();
      }
      const rows = [
        ...event.currentTarget.querySelectorAll<HTMLElement>(
          "[data-session-action-id]",
        ),
      ];
      const nearest = rows.reduce<HTMLElement | null>((best, row) => {
        const distance = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return Math.abs(event.clientY - (rect.top + rect.height / 2));
        };
        return !best || distance(row) < distance(best) ? row : best;
      }, null);
      const target = nearest?.dataset.sessionActionId as
        | SessionActionId
        | undefined;
      if (!target || target === current.id) return;
      current.order = moveSessionAction(
        current.order,
        current.id,
        current.order.indexOf(target),
      );
      setPreview(current.order);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const isClick = !current.active;
      const clickId = current.id;
      const rect = event.currentTarget.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      finish(inside);
      if (isClick && inside && onHandleClick) {
        onHandleClick(clickId);
      }
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerId === drag.current?.pointerId) finish(false);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && drag.current) {
        finish(false);
        return true;
      }
      if (
        !event.altKey ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      )
        return false;
      const button = event.target as HTMLElement;
      const id = button.closest<HTMLElement>("[data-session-action-id]")
        ?.dataset.sessionActionId as SessionActionId | undefined;
      if (!id) return false;
      const next = order.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1);
      if (next >= 0 && next < order.length) {
        const nextButton = button.closest("button") ?? button;
        if (nextButton instanceof HTMLButtonElement) {
          focus.current = nextButton;
        }
        onReorderStart?.();
        onChange(moveSessionAction(order, id, next));
        onMove?.(id, next);
      }
      return true;
    },
  };
}
