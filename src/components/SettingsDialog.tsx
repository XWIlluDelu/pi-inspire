import { AlertTriangle, X } from "lucide-react";
import type { ReactNode } from "react";
import { ContextPaneState } from "./ContextPaneState";
import { Modal } from "./Modal";
import { PiLoader } from "./PiLoader";

export function SettingsConfirmation({
  id,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  id: string;
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onDismiss={onClose}
    >
      <div className="dialog settings-confirmation">
        <h2 className="dialog__title" id={`${id}-title`}>
          {title}
        </h2>
        <p className="dialog__message" id={`${id}-description`}>
          {description}
        </p>
        <div className="settings-confirmation__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Static, inert placeholders keep the deferred body's columns and footer stable. */
export function SettingsLoading({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      className={`settings__layout settings__loading${onRetry ? "" : " deferred-loading"}`}
    >
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
              className="button button--quiet res__state-action"
              onClick={onRetry}
            >
              Reload
            </button>
          </ContextPaneState>
        ) : (
          <>
            <div className="settings__content">
              <div className="settings__loading-status" role="status">
                <PiLoader size={14} aria-hidden />
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
  suspended = false,
  onClose,
  children,
}: {
  suspended?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      active={!suspended}
      overlayClassName="settings-overlay"
      aria-label="Settings"
      onDismiss={onClose}
    >
      <div className="dialog settings">
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
    </Modal>
  );
}
