import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useModalFocus } from "../use-modal-focus";

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
