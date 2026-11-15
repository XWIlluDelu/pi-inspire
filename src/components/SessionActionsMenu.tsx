import { GripVertical } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import {
  runSessionAction,
  sessionActionAvailable,
  sessionActions,
} from "../session-actions";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { useSessionActionReorder } from "../use-session-action-reorder";
import { ButtonLabel } from "./ButtonLabel";
import { AnchoredPanel } from "./ChoicePanel";
import { CopyFeedback } from "./CopyFeedback";

export function SessionActionsMenu({
  anchorRef,
  sessionId,
  onRename,
  onExport,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  sessionId: string;
  onRename: (sessionId: string, name: string) => void;
  onExport: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { order, rename, clone } = useAppState(
    (state) => ({
      order:
        state.desiredPreferences.sessionActionOrder ??
        state.prefs.sessionActionOrder,
      rename: sessionActionAvailable("rename", state),
      clone: sessionActionAvailable("clone", state),
    }),
    shallowEqual,
  );
  const { copied, copying, copy } = useCopied({
    scope: sessionId,
    onError: store.reportCopyError,
  });
  const list = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const reorder = useSessionActionReorder({
    order,
    onChange: (next) => store.setPreference("sessionActionOrder", next),
    containerRef: list,
    onMove: (id, index) =>
      setAnnouncement(
        `${sessionActions[id].title} moved to position ${index + 1}`,
      ),
  });
  return (
    <AnchoredPanel
      anchorRef={anchorRef}
      label="Session actions"
      open
      onClose={onClose}
      role="menu"
    >
      <div
        ref={list}
        role="presentation"
        onPointerMove={reorder.onPointerMove}
        onPointerUp={reorder.onPointerUp}
        onPointerCancel={reorder.onPointerCancel}
        onLostPointerCapture={reorder.onPointerCancel}
        onKeyDownCapture={(event) => {
          if (reorder.onKeyDown(event)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {reorder.order.map((id) => {
          const { icon: Icon, title } = sessionActions[id];
          const copyId = id === "copy-id";
          return (
            <div
              key={id}
              role="presentation"
              className="session-actions-menu__row"
              data-session-action-id={id}
              data-dragging={reorder.draggingId === id || undefined}
            >
              <button
                type="button"
                role="menuitem"
                disabled={id === "rename" ? !rename : id === "clone" && !clone}
                aria-disabled={copyId ? copying : undefined}
                onClick={() =>
                  runSessionAction(id, sessionId, {
                    copyId: () => {
                      if (!copying) void copy(sessionId, store.copyOwnership());
                    },
                    rename: onRename,
                    export: onExport,
                    closeMenu: onClose,
                  })
                }
              >
                {Icon ? (
                  <Icon size={14} aria-hidden />
                ) : (
                  <CopyFeedback copied={copied} copying={copying} size={14} />
                )}
                <ButtonLabel reserve={copyId && copied ? title : []}>
                  {copyId && copied ? "ID copied" : title}
                </ButtonLabel>
              </button>
              <button
                type="button"
                className="session-actions-menu__grip"
                tabIndex={-1}
                aria-label={`Reorder ${title}`}
                title="Drag to reorder"
                onPointerDown={(event) => reorder.startDrag(event, id)}
              >
                <GripVertical size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <span className="sr-only" role="status">
        {copied ? "Session ID copied" : announcement}
      </span>
    </AnchoredPanel>
  );
}
