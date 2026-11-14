import type { ReactNode } from "react";
import { DialogHeader, Modal } from "./Modal";

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
