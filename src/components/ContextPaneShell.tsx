import { AlertTriangle, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { dismissTerminalMenu } from "../terminal-menus";
import { recoverModalFocus, useModalFocus } from "../use-modal-focus";
import { ContextPaneState } from "./ContextPaneState";

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
        event.target.closest(".terminal-search")
      )
        return false;
      if (!dismissTerminalMenu(ref.current, event.target)) onClose();
    },
  );
  // The same host element also preserves readers and terminals across layouts.
  return isModal ? (
    <div
      className="ctx res"
      id="context-pane"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Context panel"
      tabIndex={-1}
    >
      {children}
    </div>
  ) : (
    <div
      className="ctx res"
      id="context-pane"
      ref={ref}
      role="complementary"
      aria-label="Context panel"
    >
      {children}
    </div>
  );
}

export function ContextPaneLoading({
  onClose,
  onRetry,
}: {
  onClose: () => void;
  onRetry?: () => void;
}) {
  return (
    <>
      <div className="ctx__header" ref={recoverModalFocus}>
        <span className="ctx__title">Context</span>
        <button
          type="button"
          className="icon-button ctx__close"
          title="Close"
          aria-label="Close context pane"
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      <ContextPaneState
        className={onRetry ? undefined : "deferred-loading"}
        icon={
          onRetry ? (
            <AlertTriangle size={17} aria-hidden />
          ) : (
            <Loader2 size={17} className="spin" aria-hidden />
          )
        }
        title={onRetry ? "Context could not be opened." : "Loading context"}
        role={onRetry ? "alert" : "status"}
      >
        {onRetry ? (
          <button
            type="button"
            className="button button--quiet res__state-action"
            onClick={onRetry}
          >
            Reload
          </button>
        ) : null}
      </ContextPaneState>
    </>
  );
}
