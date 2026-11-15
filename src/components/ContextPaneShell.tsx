import { X } from "lucide-react";
import type { ReactNode } from "react";
import { dismissTerminalMenu } from "../terminal-menus";
import { recoverModalFocus, useModalFocus } from "../use-modal-focus";

/** Keep the pane and its focus owner mounted across deferred body states. */
export function ContextPaneShell({
  isModal,
  onClose,
  children,
}: {
  isModal: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useModalFocus<HTMLDivElement>(
    isModal,
    "context-pane",
    (event) => {
      // This shortcut belongs to the focused terminal's capture listener,
      // not the drawer or an open terminal menu.
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.target instanceof Element &&
        ref.current?.contains(event.target) &&
        event.target.closest(".terminal-pane--focused")
      )
        return false;
      // Terminal search consumes Escape locally and returns focus to its PTY.
      if (
        event.target instanceof Element &&
        ref.current?.contains(event.target) &&
        event.target.closest(
          ".terminal-search, .dock-tabs .choice-panel, .history-detail",
        )
      )
        return false;
      if (!dismissTerminalMenu(ref.current, event.target)) onClose();
    },
  );
  const semantics = isModal
    ? {
        role: "dialog",
        "aria-label": "Context panel",
        "aria-modal": true,
        tabIndex: -1,
      }
    : { role: "complementary", "aria-label": "Context panel" };
  return (
    <div className="ctx res" id="context-pane" ref={ref} {...semantics}>
      {children}
    </div>
  );
}

export function ContextPaneLoadingHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="pane-toolbar ctx__header" ref={recoverModalFocus}>
      <div className="ctx__tools">
        <ContextPaneClose onClose={onClose} />
      </div>
    </div>
  );
}

export function ContextPaneClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="icon-button ctx__close"
      title="Close"
      aria-label="Close context pane"
      onClick={onClose}
    >
      <X size={15} aria-hidden />
    </button>
  );
}
