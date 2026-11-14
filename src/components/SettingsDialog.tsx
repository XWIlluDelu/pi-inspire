import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { ContextPaneState } from "./ContextPaneState";
import { DialogHeader, Modal } from "./Modal";
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
        <footer className="dialog__actions">
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
        </footer>
      </div>
    </Modal>
  );
}

export function SettingsLoading({ onRetry }: { onRetry?: () => void }) {
  return (
    <ContextPaneState
      className={onRetry ? undefined : "deferred-loading"}
      icon={
        onRetry ? (
          <AlertTriangle size={17} aria-hidden />
        ) : (
          <PiLoader size={14} aria-hidden />
        )
      }
      title={onRetry ? "Settings could not be opened." : "Loading settings"}
      role={onRetry ? "alert" : "status"}
    >
      {onRetry && (
        <button
          type="button"
          className="button button--quiet"
          onClick={onRetry}
        >
          Reload
        </button>
      )}
    </ContextPaneState>
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
      <div className="dialog dialog--flush settings">
        <DialogHeader
          title="Settings"
          closeLabel="Close settings"
          onClose={onClose}
        />
        {children}
      </div>
    </Modal>
  );
}
