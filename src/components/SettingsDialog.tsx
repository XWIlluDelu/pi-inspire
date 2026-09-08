import { AlertTriangle, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useModalFocus } from "../use-modal-focus";
import { ContextPaneState } from "./ContextPaneState";

/** Static, inert placeholders keep the deferred body's columns and footer stable. */
export function SettingsLoading({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="settings__layout settings__loading">
      {!onRetry ? (
        <div className="settings__sidebar" aria-hidden="true">
          <div className="settings__nav-list">
            {[0, 1, 2, 3].map((row) => (
              <div className="settings__nav-item" key={row}>
                <span className="settings__skeleton settings__skeleton--icon" />
                <span className="settings__skeleton settings__skeleton--label" />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="settings__main">
        {onRetry ? (
          <ContextPaneState
            icon={<AlertTriangle size={17} aria-hidden />}
            title="Settings could not be opened."
            role="alert"
          >
            <button
              type="button"
              className="button res__state-action"
              onClick={onRetry}
            >
              Reload
            </button>
          </ContextPaneState>
        ) : (
          <>
            <div className="settings__content">
              <div className="settings__loading-status" role="status">
                <Loader2 size={14} className="spin" aria-hidden />
                <span>Loading settings</span>
              </div>
              <div className="settings__card" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((row) => (
                  <div className="settings__field" key={row}>
                    <div className="settings__skeleton-copy">
                      <span className="settings__skeleton settings__skeleton--label" />
                      <span className="settings__skeleton settings__skeleton--description" />
                    </div>
                    <span className="settings__skeleton settings__skeleton--control" />
                  </div>
                ))}
              </div>
            </div>
            <div className="settings__footer" aria-hidden="true">
              <span className="settings__skeleton settings__skeleton--label" />
              <span className="settings__skeleton settings__skeleton--label" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Keep the animated shell and focus owner mounted across deferred body states. */
export function SettingsDialog({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, "settings", onClose);
  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings__header">
          <h2 className="settings__title">Settings</h2>
          <button
            type="button"
            className="icon-button settings__close-btn"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
