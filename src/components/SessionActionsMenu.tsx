import { type RefObject, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";

const CONSTRAINTS: FloatingMenuConstraints = {
  gap: 0,
  horizontalMargin: 8,
  verticalMargin: 4,
  maxWidth: 720,
  maxHeight: 240,
  overlapAnchor: true,
};

export function SessionActionsMenu({
  anchorRef,
  cloneDisabled,
  onRename,
  onClone,
  onExport,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  cloneDisabled: boolean;
  onRename: (width: number) => void;
  onClone: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const resolveTarget = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    return {
      context: anchor,
      anchor: rect,
      preferredWidth: Math.max(200, rect.width),
      observe: [anchor],
    };
  }, [anchorRef]);
  const placement = useFloatingMenuPlacement(true, resolveTarget, CONSTRAINTS);
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    node
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      )
        onClose();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("focusin", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("focusin", dismiss);
    };
  }, [anchorRef, onClose]);

  if (!placement) return null;
  return createPortal(
    <div
      ref={attachMenu}
      className="session-actions-menu"
      role="menu"
      aria-label="Session actions"
      style={{
        left: placement.left,
        top: placement.top,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
          return;
        }
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % items.length
            : event.key === "ArrowUp"
              ? (index - 1 + items.length) % items.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : null;
        if (next !== null) {
          event.preventDefault();
          items[next]?.focus();
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onRename(placement.width)}
      >
        Rename session
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={cloneDisabled}
        onClick={onClone}
      >
        Clone current branch
      </button>
      <button type="button" role="menuitem" onClick={onExport}>
        Export session…
      </button>
    </div>,
    document.body,
  );
}
