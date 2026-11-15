import { ArrowDown, ArrowUp, GripVertical, ListOrdered } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { SessionActionId } from "../../shared/contracts";
import { moveSessionAction, sessionActions } from "../session-actions";
import { useSessionActionReorder } from "../use-session-action-reorder";
import { AnchoredPanel } from "./ChoicePanel";
import { SettingsSection } from "./SettingsSection";

const moveMenuBounds = {
  gap: 4,
  horizontalMargin: 8,
  verticalMargin: 8,
  maxWidth: 190,
  maxHeight: 112,
  preferredDirection: "down",
} as const;

export function SessionActionsSettings({
  order,
  onChange,
}: {
  order: readonly SessionActionId[];
  onChange: (order: SessionActionId[]) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [activeMenu, setActiveMenu] = useState<SessionActionId | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announce = (id: SessionActionId, index: number) =>
    setAnnouncement(
      `${sessionActions[id].title} moved to position ${index + 1} of ${order.length}.`,
    );
  const toggle = (id: SessionActionId, handle: HTMLButtonElement) => {
    opener.current = handle;
    setActiveMenu((current) => (current === id ? null : id));
  };
  const reorder = useSessionActionReorder({
    order,
    onChange,
    containerRef: list,
    onReorderStart: () => setActiveMenu(null),
    onHandleClick: (id) => {
      const handle = list.current?.querySelector<HTMLButtonElement>(
        `[data-session-action-id="${id}"] .session-action-order__handle`,
      );
      if (handle) toggle(id, handle);
    },
    onMove: announce,
  });
  const activeIndex = activeMenu === null ? -1 : order.indexOf(activeMenu);

  return (
    <SettingsSection
      id="session-actions"
      icon={<ListOrdered size={14} />}
      title="Session actions"
      description="Reorder the session title menu."
    >
      <ol
        ref={list}
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
          const { title } = sessionActions[id];
          const open = activeMenu === id;
          return (
            <li
              className="session-action-order__row"
              key={id}
              data-session-action-id={id}
              data-dragging={reorder.draggingId === id || undefined}
            >
              <span className="session-action-order__index" aria-hidden>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="session-action-order__label">{title}</span>
              <button
                type="button"
                className="session-action-order__handle"
                aria-label={`Reorder ${title}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title="Drag to reorder · Click for move options · Alt+↑/↓ to move"
                onPointerDown={(event) => reorder.startDrag(event, id)}
                onClick={(event) => {
                  // Pointer taps are handled on release by the drag control.
                  if (event.detail === 0) toggle(id, event.currentTarget);
                }}
              >
                <GripVertical size={16} aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
      {activeMenu !== null && activeIndex >= 0 && (
        <AnchoredPanel
          open
          id={menuId}
          label={`Move options for ${sessionActions[activeMenu].title}`}
          anchorRef={opener}
          onClose={() => setActiveMenu(null)}
          constraints={moveMenuBounds}
          role="menu"
        >
          {(["up", "down"] as const).map((direction) => {
            const destination = activeIndex + (direction === "up" ? -1 : 1);
            const Icon = direction === "up" ? ArrowUp : ArrowDown;
            return (
              <button
                key={direction}
                type="button"
                role="menuitem"
                aria-label={`Move ${sessionActions[activeMenu].title} ${direction}`}
                disabled={destination < 0 || destination >= order.length}
                onClick={() => {
                  onChange(moveSessionAction(order, activeMenu, destination));
                  announce(activeMenu, destination);
                  setActiveMenu(null);
                  opener.current?.focus({ preventScroll: true });
                }}
              >
                <Icon size={14} aria-hidden />
                <span>Move {direction}</span>
                <kbd className="session-action-order__kbd">
                  {direction === "up" ? "Alt+↑" : "Alt+↓"}
                </kbd>
              </button>
            );
          })}
        </AnchoredPanel>
      )}
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </SettingsSection>
  );
}
